import { appendFileSync, mkdirSync, statSync } from 'node:fs';
import { createReadStream } from 'node:fs';
import { dirname } from 'node:path';
import { createInterface } from 'node:readline';
import type { EventMsg } from './codexAppServerTypes';

export type CodexProtocolContext = {
    epoch: string;
    epochStartedAt: number;
    seq: number;
    at: number;
    threadId?: string;
    turnId?: string;
    itemId?: string;
    requestId?: string | number;
};

export type CodexProtocolRecord = {
    version: 1;
    cliVersion: string;
    adapter: string;
    protocol: CodexProtocolContext;
    kind: 'raw' | 'event';
    direction: 'incoming' | 'outgoing' | 'internal';
    message: unknown;
};

export type CodexProtocolIndexEntry = {
    offset: number;
    bytes: number;
    record: Omit<CodexProtocolRecord, 'message'> & { method?: string };
};

/** Append-only local audit log. No transcript or command output is retained in memory. */
export class CodexProtocolJournal {
    private seq = 0;
    private ready = false;

    constructor(readonly path: string, private readonly onError: (error: unknown) => void) {}

    append(record: Omit<CodexProtocolRecord, 'version' | 'protocol'> & {
        protocol: Omit<CodexProtocolContext, 'seq' | 'at'>;
    }): CodexProtocolContext {
        const protocol = { ...record.protocol, seq: ++this.seq, at: Date.now() };
        try {
            if (!this.ready) {
                mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
                this.ready = true;
            }
            const serialized = JSON.stringify({ ...record, version: 1, protocol }) + '\n';
            let offset = 0;
            try { offset = statSync(this.path).size; } catch (error: any) { if (error.code !== 'ENOENT') throw error; }
            appendFileSync(this.path, serialized, { mode: 0o600 });
            // The index contains no output payload and lets uploaders read a large
            // record in fixed-size byte slices, including after a process restart.
            const message = record.message as { method?: unknown; type?: unknown } | null;
            const method = typeof message?.method === 'string' ? message.method : typeof message?.type === 'string' ? message.type : undefined;
            const index: CodexProtocolIndexEntry = {
                offset, bytes: Buffer.byteLength(serialized),
                record: { version: 1, cliVersion: record.cliVersion, adapter: record.adapter, protocol, kind: record.kind, direction: record.direction, ...(method ? { method } : {}) },
            };
            appendFileSync(`${this.path}.index`, JSON.stringify(index) + '\n', { mode: 0o600 });
        } catch (error) {
            this.onError(error);
        }
        return protocol;
    }
}

/** Stream records after a persisted cursor without loading a session into the heap. */
export async function* replayCodexProtocolJournal(
    path: string,
    options: { afterSeq?: number; epoch?: string; threadId?: string } = {},
): AsyncGenerator<CodexProtocolRecord> {
    const input = createReadStream(path, { encoding: 'utf8' });
    const lines = createInterface({ input, crlfDelay: Infinity });
    try {
        for await (const line of lines) {
            if (!line.trim()) continue;
            // A corrupt record is an explicit replay failure, never a silently skipped event.
            const record = JSON.parse(line) as CodexProtocolRecord;
            if (record.version !== 1 || !Number.isSafeInteger(record.protocol?.seq)) {
                throw new Error('Unsupported or corrupt Codex protocol journal record');
            }
            if (record.protocol.seq <= (options.afterSeq ?? 0)) continue;
            if (options.epoch && record.protocol.epoch !== options.epoch) continue;
            if (options.threadId && record.protocol.threadId !== options.threadId) continue;
            yield record;
        }
    } finally {
        lines.close();
        input.destroy();
    }
}

export function replayedCodexEvent(record: CodexProtocolRecord): EventMsg | null {
    if (record.kind !== 'event') return null;
    return { ...(record.message as EventMsg), protocol: record.protocol };
}
