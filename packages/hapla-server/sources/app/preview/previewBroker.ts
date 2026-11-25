import type { Server, Socket } from 'socket.io';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import type WebSocket from 'ws';
import { auth } from '@/app/auth/auth';
import { db } from '@/storage/db';
import type { PreviewHttpHead, PreviewHttpRequest } from '@hapla/wire';

type HttpStream = { response: ServerResponse; head: (head: PreviewHttpHead) => void; end: () => void; fail: () => void };

export class PreviewBroker {
    private machines = new Map<string, Socket>();
    private http = new Map<string, HttpStream>();
    private websockets = new Map<string, WebSocket>();
    private frames = new Map<string, { chunks: Buffer[]; size: number }>();

    start(io: Server) {
        const namespace = io.of('/preview-tunnel');
        namespace.use(async (socket, next) => {
            try {
                const verified = await auth.verifyToken(socket.handshake.auth.token);
                const machineId = socket.handshake.auth.machineId;
                if (!verified || typeof machineId !== 'string' || !await db.machine.findFirst({ where: { id: machineId, accountId: verified.userId }, select: { id: true } })) return next(new Error('Unauthorized preview workbench'));
                socket.data.owner = verified.userId; socket.data.machineId = machineId; next();
            } catch { next(new Error('Unauthorized preview workbench')); }
        });
        namespace.on('connection', socket => {
            const key = `${socket.data.owner}:${socket.data.machineId}`;
            const previous = this.machines.get(key);
            this.machines.set(key, socket);
            previous?.disconnect();
            const ownedHttp = new Set<string>(); const ownedWs = new Set<string>();
            socket.on('preview-head', (data: PreviewHttpHead & { id: string }) => {
                const stream = data && ownedHttp.has(data.id) ? this.http.get(data.id) : undefined;
                if (!stream) return;
                try {
                    if (!Number.isInteger(data.status) || data.status < 200 || data.status > 599 || !data.headers || typeof data.headers !== 'object') throw new Error('Invalid upstream response');
                    stream.head(data);
                } catch { stream.fail(); }
            });
            socket.on('preview-response', async (data: { id: string; data: Buffer }, acknowledge: () => void) => {
                const stream = data && ownedHttp.has(data.id) ? this.http.get(data.id) : undefined;
                try { if (stream && !stream.response.destroyed && !stream.response.writableEnded && !stream.response.write(data.data)) await once(stream.response, 'drain'); }
                catch { stream?.fail(); }
                finally { acknowledge?.(); }
            });
            socket.on('preview-end', (data: { id: string }) => { if (data && ownedHttp.delete(data.id)) this.http.get(data.id)?.end(); });
            socket.on('preview-error', (data: { id: string }) => { if (data && ownedHttp.delete(data.id)) this.http.get(data.id)?.fail(); });
            socket.on('preview-ws-data', (data: { id: string; data: Buffer; binary: boolean; end: boolean }, acknowledge: () => void) => {
                const ws = data && ownedWs.has(data.id) ? this.websockets.get(data.id) : undefined;
                try {
                    if (ws?.readyState !== 1) return;
                    const frame = this.frames.get(data.id) ?? { chunks: [], size: 0 };
                    frame.size += data.data.length;
                    if (frame.size > 16 * 1024 * 1024 || ws.bufferedAmount > 16 * 1024 * 1024) { ws.terminate(); return; }
                    frame.chunks.push(Buffer.from(data.data));
                    if (data.end) { this.frames.delete(data.id); ws.send(Buffer.concat(frame.chunks), { binary: data.binary }); }
                    else this.frames.set(data.id, frame);
                } catch { ws?.terminate(); this.frames.delete(data.id); } finally { acknowledge?.(); }
            });
            socket.on('preview-ws-close', (data: { id: string; code: number; reason: string }) => { if (data && ownedWs.delete(data.id)) { this.websockets.get(data.id)?.close(data.code === 1000 ? 1000 : 1011); this.websockets.delete(data.id); this.frames.delete(data.id); } });
            socket.on('disconnect', () => {
                if (this.machines.get(key) === socket) this.machines.delete(key);
                for (const id of ownedHttp) this.http.get(id)?.fail();
                for (const id of ownedWs) { this.websockets.get(id)?.close(1011, 'Workbench disconnected'); this.websockets.delete(id); this.frames.delete(id); }
            });
            socket.data.previewHttp = ownedHttp; socket.data.previewWs = ownedWs;
        });
    }

    machine(owner: string, machineId: string): Socket {
        const socket = this.machines.get(`${owner}:${machineId}`);
        if (!socket?.connected) throw new Error('工作台未连接，请启动对应的 Hapla CLI daemon');
        return socket;
    }

    async proxyHttp(socket: Socket, request: IncomingMessage, response: ServerResponse, target: Omit<PreviewHttpRequest, 'id'>, headers: (head: PreviewHttpHead) => Record<string, string | string[]>) {
        const id = randomUUID();
        const owned: Set<string> = socket.data.previewHttp;
        if (owned.size >= 32) throw new Error('预览连接过多，请关闭部分页面后重试');
        owned.add(id);
        let settled = false;
        let resolve!: () => void;
        const finished = new Promise<void>(done => { resolve = done; });
        const cleanup = () => { if (settled) return; settled = true; clearTimeout(timer); this.http.delete(id); owned.delete(id); resolve(); };
        const timer = setTimeout(() => fail(), 30_000);
        const fail = () => {
            if (!response.headersSent) response.writeHead(502, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
            if (!response.writableEnded) response.end('开发服务暂时不可用，启动服务后刷新此固定链接即可重试。');
            socket.emit('preview-cancel', { id }); cleanup();
        };
        this.http.set(id, { response, head: head => {
            clearTimeout(timer);
            if (!response.headersSent) response.writeHead(head.status, headers(head));
        }, end: () => { response.end(); cleanup(); }, fail });
        const cancel = () => { if (!settled) { socket.emit('preview-cancel', { id }); cleanup(); } };
        response.once('close', cancel);
        try {
            const result = await socket.timeout(10_000).emitWithAck('preview-http', { id, ...target });
            if (!result?.accepted) throw new Error('Preview rejected');
            for await (const chunk of request) {
                if (settled) break;
                await socket.timeout(30_000).emitWithAck('preview-body', { id, data: chunk });
            }
            if (!settled) await socket.timeout(30_000).emitWithAck('preview-body', { id, end: true });
            await finished;
        } catch { fail(); }
        finally { response.off('close', cancel); }
    }

    async openWebsocket(socket: Socket, data: { target: string; headers: Record<string, string | string[]>; protocols: string[] }) {
        const id = randomUUID();
        const owned: Set<string> = socket.data.previewWs;
        if (owned.size >= 32) throw new Error('Too many preview sockets');
        owned.add(id);
        let result: { success?: boolean; protocol?: string };
        try { result = await socket.timeout(15_000).emitWithAck('preview-ws-open', { id, ...data }); }
        catch { owned.delete(id); socket.emit('preview-ws-close', { id }); throw new Error('Upstream websocket unavailable'); }
        if (!result?.success) { owned.delete(id); socket.emit('preview-ws-close', { id }); throw new Error('Upstream websocket unavailable'); }
        return { protocol: result.protocol as string, cancel: () => { owned.delete(id); socket.emit('preview-ws-close', { id }); }, attach: (ws: WebSocket) => {
            this.websockets.set(id, ws);
            let pending = Promise.resolve(); let pendingBytes = 0;
            ws.on('message', (data, binary) => {
                const body = Buffer.from(data as Buffer); pendingBytes += body.length;
                if (pendingBytes > 16 * 1024 * 1024) { ws.terminate(); return; }
                pending = pending.then(async () => {
                    for (let offset = 0; offset < Math.max(1, body.length); offset += 64 * 1024) {
                        await socket.timeout(30_000).emitWithAck('preview-ws-data', { id, data: body.subarray(offset, offset + 64 * 1024), binary, end: offset + 64 * 1024 >= body.length });
                    }
                    pendingBytes -= body.length;
                }).catch(() => ws.terminate());
            });
            socket.emit('preview-ws-ready', { id });
            ws.on('close', () => { owned.delete(id); this.websockets.delete(id); this.frames.delete(id); socket.emit('preview-ws-close', { id }); });
            ws.on('error', () => ws.close());
        } };
    }
}

export const previewBroker = new PreviewBroker();
