import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocketServer } from 'ws';
import { EventEmitter } from 'node:events';
vi.mock('./authenticateSocket', () => ({ authenticateSocket: vi.fn() }));
import { asrUpstreamUrl, attachAsrSocket } from './asrHandler';

class BrowserSocket {
    incoming = new EventEmitter();
    events: any[] = [];
    on = this.incoming.on.bind(this.incoming);
    emit(_name: string, event: unknown) { this.events.push(event); }
    receive(name: string, data?: unknown) { this.incoming.emit(name, data); }
}
const cleanup: Array<() => void> = [];
afterEach(() => { cleanup.splice(0).forEach(close => close()); vi.unstubAllEnvs(); });
async function waitFor(check: () => boolean) {
    const until = Date.now() + 3000;
    while (!check()) { if (Date.now() > until) throw new Error('ASR test timed out'); await new Promise(resolve => setTimeout(resolve, 10)); }
}

describe('ASR socket relay', () => {
    it('requires an explicit upstream instead of contacting a machine-specific default', () => {
        const previous = process.env.HAPLA_ASR_URL;
        delete process.env.HAPLA_ASR_URL;
        try {
            expect(() => asrUpstreamUrl()).toThrow('not configured');
            expect(() => asrUpstreamUrl('')).toThrow('not configured');
        } finally {
            if (previous === undefined) delete process.env.HAPLA_ASR_URL;
            else process.env.HAPLA_ASR_URL = previous;
        }
    });
    it('uses the configured host and secure transport without credentials', () => {
        expect(asrUpstreamUrl('http://localhost:8765')).toBe('ws://localhost:8765/ws');
        expect(asrUpstreamUrl('https://asr.example/base')).toBe('wss://asr.example/base/ws');
        expect(() => asrUpstreamUrl('file:///etc/passwd')).toThrow('ASR URL');
    });
    it('forwards PCM after ready, preserves final text before stopped, and releases the upstream', async () => {
        const upstream = new WebSocketServer({ host: '127.0.0.1', port: 0 });
        await new Promise<void>(resolve => upstream.once('listening', resolve));
        cleanup.push(() => upstream.close());
        let sawPCM = false; let sawClose = false;
        upstream.on('connection', (connection, request) => {
            expect(request.headers.origin).toBeUndefined();
            connection.on('close', () => { sawClose = true; });
            connection.on('message', (data, binary) => {
                if (binary) { sawPCM = true; expect(data).toEqual(Buffer.alloc(1024)); return; }
                const event = JSON.parse(data.toString());
                if (event.type === 'start') { expect(event.sample_rate).toBe(16000); connection.send(JSON.stringify({ type: 'ready' })); }
                if (event.type === 'stop') { connection.send(JSON.stringify({ type: 'final', text: '你好 Hapla' })); connection.send(JSON.stringify({ type: 'stopped' })); }
            });
        });
        const port = (upstream.address() as { port: number }).port;
        vi.stubEnv('HAPLA_ASR_URL', `http://127.0.0.1:${port}`);
        const socket = new BrowserSocket();
        attachAsrSocket(socket as any);
        cleanup.push(() => socket.receive('disconnect'));
        socket.receive('asr-start'); await waitFor(() => socket.events.some(event => event.type === 'ready'));
        socket.receive('asr-pcm', Buffer.alloc(1024)); socket.receive('asr-stop');
        await waitFor(() => sawClose);
        expect(sawPCM).toBe(true);
        expect(socket.events.map(event => event.type)).toEqual(['ready', 'final', 'stopped']);
    });
});
