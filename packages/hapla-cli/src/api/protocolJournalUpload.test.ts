import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { CodexProtocolJournal } from '@/codex/codexProtocolJournal';
import { decrypt, encodeBase64, encrypt, decodeBase64 } from './encryption';
import { ProtocolJournalUpload, PROTOCOL_PLAIN_CHUNK_BYTES } from './protocolJournalUpload';

const paths: string[] = [];
const uploaders: ProtocolJournalUpload[] = [];
afterEach(() => { uploaders.forEach(item => item.stop()); paths.forEach(path => rmSync(path, { recursive: true, force: true })); });

function setup() {
    const directory = mkdtempSync(join(tmpdir(), 'hapla-protocol-outbox-'));
    paths.push(directory);
    const journal = new CodexProtocolJournal(join(directory, 'raw.jsonl'), error => { throw error; });
    const epoch = randomUUID();
    const append = (message: unknown) => journal.append({ cliVersion: '0.153.4', adapter: 'verified', kind: 'raw', direction: 'incoming', protocol: { epoch, epochStartedAt: 100 }, message });
    const key = new Uint8Array(32).fill(7);
    const options = {
        directory, serverUrl: 'https://server.test', sessionId: 'session-1',
        encrypt: (value: unknown) => encodeBase64(encrypt(key, 'dataKey', value)),
        onError: () => undefined,
    };
    const make = (send: ConstructorParameters<typeof ProtocolJournalUpload>[0]['send']) => {
        const uploader = new ProtocolJournalUpload({ ...options, send });
        uploaders.push(uploader);
        return uploader;
    };
    return { journal, append, key, make, options };
}

describe('durable encrypted raw protocol upload', () => {
    it('streams a multi-megabyte UTF-8 record in bounded slices and preserves exact original bytes', async () => {
        const { journal, append, key, make } = setup();
        append({ method: 'item/commandExecution/outputDelta', params: { delta: '中文\nstdout stderr '.repeat(160_000) } });
        append({ method: 'turn/completed', params: { turn: { status: 'completed' } } });
        const decoded: Buffer[] = [];
        const cursors = new Set<string>();
        const uploader = make(async batch => {
            expect(Buffer.byteLength(JSON.stringify(batch))).toBeLessThan(256 * 1024);
            for (const chunk of batch.chunks) {
                const raw = decrypt(key, 'dataKey', decodeBase64(chunk.content));
                expect(raw.sessionId).toBe('session-1');
                expect(raw.epoch).toBe(batch.epoch);
                expect(raw.seq).toBe(chunk.seq);
                expect(raw.part).toBe(chunk.part);
                const bytes = Buffer.from(raw.data, 'base64');
                expect(bytes.length).toBeLessThanOrEqual(PROTOCOL_PLAIN_CHUNK_BYTES);
                decoded.push(bytes);
                expect(cursors.has(`${chunk.seq}:${chunk.part}`)).toBe(false);
                cursors.add(`${chunk.seq}:${chunk.part}`);
            }
        });
        uploader.attach(journal.path);
        for (let i = 0; i < 8; i++) await uploader.flush();
        expect(Buffer.concat(decoded).equals(readFileSync(journal.path))).toBe(true);
        expect(decoded.length).toBeGreaterThan(100);
    });

    it('retries exact persisted ciphertext after an uncertain receipt and process restart', async () => {
        const { journal, append, make } = setup();
        append({ method: 'test', params: { secret: 'not a normal message' } });
        let uncertain: unknown;
        const first = make(async batch => { uncertain = batch; throw new Error('offline after commit'); });
        first.attach(journal.path);
        await expect(first.flush()).rejects.toThrow('offline');
        first.stop();
        const work = readFileSync(join(first.directory, readdirSync(first.directory).find(name => name.endsWith('.json'))!), 'utf8');
        expect(work).not.toContain('not a normal message');
        let retried = 0;
        const restarted = make(async batch => { expect(batch).toEqual(uncertain); retried++; });
        // Persisted attachment is discovered without retaining the former client in memory.
        await restarted.flush();
        await restarted.flush();
        expect(retried).toBe(1);
    });

    it('isolates offline journals by server and session', async () => {
        const { journal, append, make, options } = setup();
        append({ method: 'private' });
        const owner = make(async () => { throw new Error('offline'); });
        owner.attach(journal.path);
        await expect(owner.flush()).rejects.toThrow();
        owner.stop();
        let sent = false;
        const other = new ProtocolJournalUpload({ ...options, sessionId: 'other', send: async () => { sent = true; } });
        uploaders.push(other);
        await other.flush();
        expect(sent).toBe(false);
    });
});
