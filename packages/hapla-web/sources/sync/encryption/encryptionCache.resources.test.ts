import { describe, expect, it } from 'vitest';
import { EncryptionCache } from './encryptionCache';
import { SessionEncryption } from './sessionEncryption';
import { sessionResources } from '../sessionResources';

describe('decryption cache resources', () => {
    it('drops every plaintext entry owned by an unloaded session', () => {
        const cache = new EncryptionCache();
        cache.setCachedMessage('one', { id: 'one', seq: 1, localId: null, createdAt: 1, content: { text: 'plaintext' } }, 'session');
        cache.setCachedAgentState('session', 1, { controlledByUser: true });
        cache.clearSessionCache('session');
        expect(cache.getStats()).toMatchObject({ messages: 0, messageBytes: 0, agentStates: 0, agentStateBytes: 0 });
    });

    it('does not refill plaintext after a delayed decrypt completes beyond unload', async () => {
        let finish!: (values: unknown[]) => void;
        const cache = new EncryptionCache();
        const decryptor = { encrypt: async () => [], decrypt: () => new Promise<any[]>((resolve) => { finish = resolve; }) };
        const encryption = new SessionEncryption('delayed', decryptor, cache);
        const pending = encryption.decryptMessages([{ id: 'late', seq: 1, createdAt: 1, updatedAt: 1, localId: null, content: { t: 'encrypted', c: 'AA==' } }]);
        sessionResources.release('delayed');
        finish([{ role: 'user', content: { type: 'text', text: 'late plaintext' } }]);
        await pending;
        expect(cache.getStats().messages).toBe(0);
    });

    it('bounds agent-state and metadata caches by bytes, including oversized request arguments', () => {
        const cache = new EncryptionCache();
        for (let index = 0; index < 100; index++) cache.setCachedAgentState(`s-${index}`, 1, {
            requests: { approval: { tool: 'Bash', arguments: { command: 'x'.repeat(200000) } } },
        });
        expect(cache.getStats().agentStateBytes).toBeLessThanOrEqual(2 * 1024 * 1024);
        expect(cache.getStats().agentStates).toBeLessThan(10);
    });
});
