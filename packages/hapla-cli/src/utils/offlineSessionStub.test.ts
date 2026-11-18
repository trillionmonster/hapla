import { describe, expect, it, vi } from 'vitest';
import type { ApiSessionClient } from '@/api/apiSession';
import type { AgentState, Metadata } from '@/api/types';
import { createOfflineSessionStub } from './offlineSessionStub';

vi.mock('@/ui/logger', () => ({ logger: { warn: vi.fn() } }));

function realSession(receipt: Promise<void> = Promise.resolve()) {
    return {
        sessionId: 'real-session', authToken: 'token',
        getMetadata: vi.fn(() => ({ path: '/workspace' })),
        sendSessionProtocolMessage: vi.fn(() => receipt),
        sendSessionStream: vi.fn(), sendSessionEvent: vi.fn(),
        attachCodexProtocolJournal: vi.fn(),
        updateMetadata: vi.fn(), updateAgentState: vi.fn(), keepAlive: vi.fn(), onUserMessage: vi.fn(),
        rpcHandlerManager: { registerHandler: vi.fn(), unregisterHandler: vi.fn(), hasHandler: vi.fn() },
    } as unknown as ApiSessionClient;
}
const envelope = (id: string) => ({ id, time: 1, role: 'agent' as const, turn: 'turn-a', ev: { t: 'text' as const, text: id } });

describe('offline session bootstrap bridge', () => {
    it('replays ordered durable messages without acknowledging a final item before the real server', async () => {
        let acknowledge!: () => void;
        const providerReceipt = new Promise<void>((resolve) => { acknowledge = resolve; });
        const offline = createOfflineSessionStub('test-session');
        const first = offline.sendSessionProtocolMessage(envelope('first'), 'branch-a');
        const second = offline.sendSessionProtocolMessage(envelope('second'), 'branch-a');
        const onAcknowledged = vi.fn();
        void second.then(onAcknowledged);
        await Promise.resolve();
        expect(onAcknowledged).not.toHaveBeenCalled();
        const online = realSession(providerReceipt);
        offline.reconnect(online);
        expect(online.sendSessionProtocolMessage).toHaveBeenNthCalledWith(1, envelope('first'), 'branch-a');
        expect(online.sendSessionProtocolMessage).toHaveBeenNthCalledWith(2, envelope('second'), 'branch-a');
        await Promise.resolve();
        expect(onAcknowledged).not.toHaveBeenCalled();
        acknowledge();
        await Promise.all([first, second]);
        expect(onAcknowledged).toHaveBeenCalledOnce();
    });

    it('transfers RPC/user handlers and state before old session references continue online', () => {
        const metadata = { path: '/workspace', name: 'old' } as unknown as Metadata;
        const offline = createOfflineSessionStub('test-session', { metadata });
        const stop = vi.fn();
        const onMessage = vi.fn();
        offline.rpcHandlerManager.registerHandler('abort', stop);
        offline.rpcHandlerManager.registerHandler('removed', vi.fn());
        offline.rpcHandlerManager.unregisterHandler('removed');
        offline.onUserMessage(onMessage);
        offline.updateMetadata((value) => ({ ...value, name: 'updated' }));
        offline.updateAgentState((value) => ({ ...value, controlledByUser: true }));
        offline.keepAlive(true, 'remote', { phase: 'compacting' });
        expect(offline.getMetadata()).toMatchObject({ name: 'updated' });
        const online = realSession();
        offline.reconnect(online);
        expect(online.rpcHandlerManager.registerHandler).toHaveBeenCalledExactlyOnceWith('abort', stop);
        expect(online.onUserMessage).toHaveBeenCalledWith(onMessage);
        const metadataUpdate = vi.mocked(online.updateMetadata).mock.calls[0][0];
        expect(metadataUpdate(metadata)).toMatchObject({ name: 'updated' });
        const stateUpdate = vi.mocked(online.updateAgentState).mock.calls[0][0];
        expect(stateUpdate({} as AgentState)).toMatchObject({ controlledByUser: true });
        expect(online.keepAlive).toHaveBeenCalledWith(true, 'remote', { phase: 'compacting' });
        expect(offline.sessionId).toBe('real-session');
        expect(offline.authToken).toBe('token');
        const stream = { id: 'live', turnId: 'turn-a', text: 'live output' };
        offline.sendSessionStream(stream);
        expect(online.sendSessionStream).toHaveBeenCalledWith(stream);
    });

    it('rejects excess backlog explicitly and preserves already queued messages', async () => {
        const offline = createOfflineSessionStub('test-session', { maxBacklogBytes: 256 });
        const pending = offline.sendSessionProtocolMessage(envelope('kept'));
        await expect(offline.sendSessionProtocolMessage(envelope('x'.repeat(300)))).rejects.toThrow('byte budget');
        const online = realSession();
        offline.reconnect(online);
        await pending;
        expect(online.sendSessionProtocolMessage).toHaveBeenCalledExactlyOnceWith(envelope('kept'));
    });

    it('fails flush and pending receipts explicitly if the offline runtime closes', async () => {
        const offline = createOfflineSessionStub('test-session');
        const pending = offline.sendSessionProtocolMessage(envelope('pending'));
        await expect(offline.flush()).rejects.toThrow('offline');
        await offline.close();
        await expect(pending).rejects.toThrow('closed before');
        expect(() => offline.reconnect(realSession())).toThrow('closed offline session');
    });

    it('attaches the retained raw journal after reconnection without claiming offline upload', async () => {
        const offline = createOfflineSessionStub('test-session');
        offline.attachCodexProtocolJournal('/logs/protocol.jsonl');
        await expect(offline.flush()).rejects.toThrow('offline');
        const online = realSession();
        offline.reconnect(online);
        expect(online.attachCodexProtocolJournal).toHaveBeenCalledExactlyOnceWith('/logs/protocol.jsonl');
    });
});
