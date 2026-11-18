import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Socket, type Manager } from 'socket.io-client';

vi.mock('react-native', () => ({ Platform: { OS: 'web' } }));
vi.mock('expo-constants', () => ({ default: { expoConfig: { version: 'test' } } }));
vi.mock('@/auth/tokenStorage', () => ({ TokenStorage: {} }));
vi.mock('./storage', () => ({ storage: { getState: () => ({ localSettings: { verboseLogging: false } }) } }));

import { apiSocket, getHaplaClientId } from './apiSocket';
import { onWebReleaseCheckRequested } from '@/utils/webRelease';

type Packet = { type: number; id?: number; nsp?: string; data?: unknown[] };
type SocketInternals = { subEvents(): void; acks: Record<string, unknown> };

// The transport boundary is mocked, while the installed Socket.IO Socket performs
// real packet buffering, deadline registration, ACK removal and disconnect cleanup.
function transport() {
    const manager = Object.assign(new EventEmitter(), {
        _autoConnect: false,
        _packet: vi.fn<(packet: Packet) => void>(),
        _destroy: vi.fn(),
        setTimeoutFn: setTimeout,
        clearTimeoutFn: clearTimeout,
        engine: { transport: { writable: true }, _hasPingExpired: () => false },
    });
    const socket = new Socket(manager as unknown as Manager, '/');
    (socket as unknown as SocketInternals).subEvents();
    return {
        manager, socket,
        connect: () => manager.emit('packet', { type: 0, nsp: '/', data: { sid: 'test-socket' } }),
        close: () => manager.emit('close', 'transport close'),
        ack: (id: number, response: unknown) => manager.emit('packet', { type: 3, nsp: '/', id, data: [response] }),
        acks: () => Object.keys((socket as unknown as SocketInternals).acks),
        packets: () => manager._packet.mock.calls.map(([packet]) => packet),
    };
}

describe('RPC Socket.IO transport deadlines', () => {
    const crypt = { encryptRaw: vi.fn(), decryptRaw: vi.fn() };
    let connection: ReturnType<typeof transport>;

    beforeEach(() => {
        vi.useFakeTimers();
        vi.clearAllMocks();
        crypt.encryptRaw.mockResolvedValue('encrypted-params');
        crypt.decryptRaw.mockResolvedValue({ content: 'decoded' });
        connection = transport();
        Object.assign(apiSocket, {
            socket: connection.socket,
            encryption: { getSessionEncryption: () => crypt, getMachineEncryption: () => crypt },
        });
    });

    afterEach(() => {
        connection.close();
        Object.assign(apiSocket, { socket: null, encryption: null });
        vi.useRealTimers();
        vi.unstubAllGlobals();
    });

    it('includes the immutable Web release in the client identity sent to the server', () => {
        vi.stubGlobal('document', {
            scripts: [{ src: 'http://hapla.example/_expo/static-1234567890abcdef/js/web/index.js' }],
            querySelectorAll: () => [],
        });
        expect(getHaplaClientId()).toBe('web/test+static-1234567890abcdef');
    });

    it('requests a Web release check after the socket reconnects', () => {
        const releaseCheck = vi.fn();
        const unsubscribe = onWebReleaseCheckRequested(releaseCheck);
        (apiSocket as unknown as { setupEventHandlers(): void }).setupEventHandlers();
        connection.connect();
        expect(releaseCheck).toHaveBeenCalledWith('socket-reconnected');
        unsubscribe();
    });

    for (const [scope, deadline] of [['session', 50_000], ['machine', 20_000]] as const) {
        const call = (timeoutMs?: number) => scope === 'session'
            ? apiSocket.sessionRPC('target', 'read-file', { path: 'REPORT.md' }, timeoutMs)
            : apiSocket.machineRPC('target', 'read-file', { path: 'REPORT.md' }, timeoutMs);

        it(`${scope}: rejects offline without encrypting, sending or buffering until a future reconnect`, async () => {
            await expect(call()).rejects.toThrow('Socket not connected');
            expect(crypt.encryptRaw).not.toHaveBeenCalled();
            expect(connection.socket.sendBuffer).toEqual([]);
            expect(connection.acks()).toEqual([]);
            connection.connect();
            expect(connection.packets()).toEqual([]);
        });

        it(`${scope}: rejects if the transport disconnects during asynchronous encryption`, async () => {
            connection.connect();
            let finish!: (value: string) => void;
            crypt.encryptRaw.mockReturnValueOnce(new Promise<string>(resolve => { finish = resolve; }));
            const pending = call();
            const rejected = expect(pending).rejects.toThrow('Socket not connected');
            connection.close();
            finish('encrypted-params');
            await rejected;
            connection.connect();
            expect(connection.packets()).toEqual([]);
            expect(connection.socket.sendBuffer).toEqual([]);
            expect(connection.acks()).toEqual([]);
        });

        it(`${scope}: does not redirect an encrypted request onto a replacement socket`, async () => {
            connection.connect();
            let finish!: (value: string) => void;
            crypt.encryptRaw.mockReturnValueOnce(new Promise<string>(resolve => { finish = resolve; }));
            const pending = call();
            const rejected = expect(pending).rejects.toThrow('Socket not connected');
            const replacement = transport();
            replacement.connect();
            Object.assign(apiSocket, { socket: replacement.socket });
            finish('encrypted-params');
            await rejected;
            expect(connection.packets()).toEqual([]);
            expect(replacement.packets()).toEqual([]);
            replacement.close();
        });

        it(`${scope}: default ${deadline} ms deadline removes its ACK and ignores a late reply`, async () => {
            connection.connect();
            const settled = vi.fn();
            const pending = call();
            void pending.then(settled, settled);
            const rejected = expect(pending).rejects.toThrow('operation has timed out');
            await vi.advanceTimersByTimeAsync(0);
            expect(connection.acks()).toHaveLength(1);
            const packet = connection.packets()[0];
            expect(packet.data).toEqual(['rpc-call', { method: 'target:read-file', params: 'encrypted-params' }]);
            await vi.advanceTimersByTimeAsync(deadline - 1);
            expect(settled).not.toHaveBeenCalled();
            await vi.advanceTimersByTimeAsync(1);
            await rejected;
            expect(connection.acks()).toEqual([]);
            expect(connection.socket.sendBuffer).toEqual([]);
            expect(vi.getTimerCount()).toBe(0);
            connection.ack(packet.id!, { ok: true, result: 'late-ciphertext' });
            await Promise.resolve();
            expect(settled).toHaveBeenCalledTimes(1);
            expect(crypt.decryptRaw).not.toHaveBeenCalled();
        });

        it(`${scope}: accepts a shorter per-call deadline`, async () => {
            connection.connect();
            const rejected = expect(call(15)).rejects.toThrow('operation has timed out');
            await vi.advanceTimersByTimeAsync(15);
            await rejected;
            expect(connection.acks()).toEqual([]);
        });

        it(`${scope}: preserves encrypted success and inner error results`, async () => {
            connection.connect();
            crypt.decryptRaw.mockResolvedValueOnce({ error: 'File is not accessible' });
            const pending = call();
            await vi.advanceTimersByTimeAsync(0);
            connection.ack(connection.packets()[0].id!, { ok: true, result: 'ciphertext' });
            await expect(pending).resolves.toEqual({ error: 'File is not accessible' });
            expect(crypt.decryptRaw).toHaveBeenCalledWith('ciphertext');
            expect(connection.acks()).toEqual([]);
            expect(vi.getTimerCount()).toBe(0);
        });

        it(`${scope}: preserves routing errors and rejects disconnect without replaying`, async () => {
            connection.connect();
            const denied = call();
            const deniedCheck = expect(denied).rejects.toThrow('RPC handler unavailable');
            await vi.advanceTimersByTimeAsync(0);
            connection.ack(connection.packets()[0].id!, { ok: false, error: 'RPC handler unavailable' });
            await deniedCheck;
            const interrupted = call();
            const interruptedCheck = expect(interrupted).rejects.toThrow('socket has been disconnected');
            await vi.advanceTimersByTimeAsync(0);
            connection.close();
            await interruptedCheck;
            expect(connection.acks()).toEqual([]);
            expect(vi.getTimerCount()).toBe(0);
            connection.connect();
            expect(connection.packets()).toHaveLength(2);
        });
    }
});
