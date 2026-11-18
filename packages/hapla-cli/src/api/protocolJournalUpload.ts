import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, existsSync, writeFileSync, renameSync } from 'node:fs';
import { open, readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { CodexProtocolIndexEntry } from '@/codex/codexProtocolJournal';

export const PROTOCOL_PLAIN_CHUNK_BYTES = 24 * 1024;
const BATCH_BYTES = 200 * 1024;
type EncryptedChunk = { seq: number; part: number; parts: number; content: string };
type Batch = { epoch: string; epochStartedAt: number; chunks: EncryptedChunk[] };
type Position = { indexOffset: number; part: number };
type Work = Position & {
    version: 1;
    journalPath: string;
    pending?: { batch: Batch; next: Position };
};

function atomicWrite(path: string, value: unknown) {
    const temporary = `${path}.${randomUUID()}.tmp`;
    writeFileSync(temporary, JSON.stringify(value), { mode: 0o600 });
    renameSync(temporary, path);
}

/** Durable encrypted outbox. Only bounded chunks and one HTTP batch enter memory. */
export class ProtocolJournalUpload {
    readonly directory: string;
    private timer: ReturnType<typeof setTimeout> | null = null;
    private operation: Promise<void> | null = null;
    private stopped = false;
    private retryMs = 1000;

    constructor(private readonly options: {
        directory: string;
        serverUrl: string;
        sessionId: string;
        encrypt: (value: unknown) => string;
        send: (batch: Batch) => Promise<void>;
        onError: (error: unknown) => void;
    }) {
        const scope = createHash('sha256').update(`${options.serverUrl}\n${options.sessionId}`).digest('hex');
        this.directory = join(options.directory, 'protocol-outbox', scope);
        mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    }

    attach(journalPath: string) {
        const normalized = resolve(journalPath);
        const name = createHash('sha256').update(normalized).digest('hex');
        const path = join(this.directory, `${name}.json`);
        if (!existsSync(path)) atomicWrite(path, { version: 1, journalPath: normalized, indexOffset: 0, part: 0 } satisfies Work);
        this.start();
    }

    /** Also retries journals attached by a previous process for this exact session/server. */
    start() {
        if (this.stopped || this.timer || this.operation) return;
        this.timer = setTimeout(() => {
            this.timer = null;
            void this.flush().then(() => { this.retryMs = 1000; }, error => {
                this.options.onError(error);
                this.retryMs = Math.min(30_000, this.retryMs * 2);
            }).finally(() => this.start());
        }, this.retryMs);
        this.timer.unref();
    }

    stop() {
        this.stopped = true;
        if (this.timer) clearTimeout(this.timer);
        this.timer = null;
    }

    flush(): Promise<void> {
        if (this.operation) return this.operation;
        this.operation = this.performFlush().finally(() => { this.operation = null; });
        return this.operation;
    }

    private async readIndex(journalPath: string, offset: number): Promise<{ entry: CodexProtocolIndexEntry; next: number } | null> {
        const file = await open(`${journalPath}.index`, 'r').catch((error: NodeJS.ErrnoException) => {
            if (error.code === 'ENOENT') return null;
            throw error;
        });
        if (!file) return null;
        try {
            const buffer = Buffer.alloc(8192);
            const { bytesRead } = await file.read(buffer, 0, buffer.length, offset);
            if (!bytesRead) return null;
            const newline = buffer.subarray(0, bytesRead).indexOf(10);
            if (newline < 0) {
                if (bytesRead === buffer.length) throw new Error('Protocol index entry exceeds its bound');
                return null;
            }
            const entry = JSON.parse(buffer.subarray(0, newline).toString('utf8')) as CodexProtocolIndexEntry;
            if (!Number.isSafeInteger(entry.offset) || entry.offset < 0 || !Number.isSafeInteger(entry.bytes) || entry.bytes <= 0 || !entry.record?.protocol?.epoch) {
                throw new Error('Corrupt protocol upload index');
            }
            return { entry, next: offset + newline + 1 };
        } finally { await file.close(); }
    }

    private async prepare(work: Work): Promise<Work['pending']> {
        let position: Position = { indexOffset: work.indexOffset, part: work.part };
        let batch: Batch | undefined;
        let bytes = 0;
        const file = await open(work.journalPath, 'r').catch((error: NodeJS.ErrnoException) => {
            if (error.code === 'ENOENT' && position.indexOffset === 0) return null;
            throw error;
        });
        if (!file) return undefined;
        try {
            while (true) {
                const next = await this.readIndex(work.journalPath, position.indexOffset);
                if (!next) break;
                const { entry } = next;
                const { epoch, epochStartedAt, seq } = entry.record.protocol;
                if (batch && batch.epoch !== epoch) break;
                const parts = Math.ceil(entry.bytes / PROTOCOL_PLAIN_CHUNK_BYTES);
                if (position.part >= parts) throw new Error('Invalid protocol upload checkpoint');
                const size = Math.min(PROTOCOL_PLAIN_CHUNK_BYTES, entry.bytes - position.part * PROTOCOL_PLAIN_CHUNK_BYTES);
                const buffer = Buffer.alloc(size);
                const read = await file.read(buffer, 0, size, entry.offset + position.part * PROTOCOL_PLAIN_CHUNK_BYTES);
                if (read.bytesRead !== size) throw new Error('Protocol journal was truncated before upload');
                const content = this.options.encrypt({
                    version: 1, sessionId: this.options.sessionId, epoch, seq,
                    part: position.part, parts, record: entry.record, data: buffer.toString('base64'),
                });
                const chunk: EncryptedChunk = { seq, part: position.part, parts, content };
                const chunkBytes = Buffer.byteLength(JSON.stringify(chunk));
                if (chunkBytes > 48 * 1024) throw new Error('Encrypted protocol chunk exceeds its bound');
                if (batch && (bytes + chunkBytes > BATCH_BYTES || batch.chunks.length >= 32)) break;
                batch ??= { epoch, epochStartedAt, chunks: [] };
                batch.chunks.push(chunk);
                bytes += chunkBytes;
                position = position.part + 1 < parts ? { ...position, part: position.part + 1 } : { indexOffset: next.next, part: 0 };
            }
        } finally { await file.close(); }
        return batch ? { batch, next: position } : undefined;
    }

    private async performFlush() {
        // One pass is bounded; a busy live journal must not starve older journals.
        for (const name of (await readdir(this.directory)).filter(name => name.endsWith('.json')).sort()) {
            if (this.stopped) return;
            const path = join(this.directory, name);
            let work = JSON.parse(await readFile(path, 'utf8')) as Work;
            if (work.version !== 1) throw new Error('Unsupported protocol outbox version');
            for (let batchCount = 0; batchCount < 16 && !this.stopped; batchCount++) {
                const pending = work.pending ?? await this.prepare(work);
                if (!pending) break;
                // Store exact randomized ciphertext before sending. An uncertain receipt
                // is retried byte-for-byte across restarts, without duplicates or conflicts.
                if (!work.pending) atomicWrite(path, { ...work, pending });
                await this.options.send(pending.batch);
                work = { version: 1, journalPath: work.journalPath, ...pending.next };
                atomicWrite(path, work);
            }
        }
    }
}
