import { it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { spawnSessionReceipts } from './spawnSessionReceipt';
it('returns the same launch after concurrent retries and a lost acknowledgement', async () => {
    const receipts = spawnSessionReceipts(); let launches = 0; let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; }); const id = randomUUID();
    const launch = async () => { launches++; await gate; return { type: 'success' as const, sessionId: 'one-agent' }; };
    const a = receipts(id, launch); const b = receipts(id, launch); expect(launches).toBe(1); release();
    expect(await a).toEqual(await b); expect(await receipts(id, launch)).toEqual(await a); expect(launches).toBe(1);
});
