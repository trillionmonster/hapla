import { io, type Socket } from 'socket.io-client';
import { request as httpRequest, type ClientRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { once } from 'node:events';
import WebSocket from 'ws';
import { validatePreviewTarget, type PreviewHttpRequest } from '@hapla/wire';

const CHUNK_BYTES = 64 * 1024;

/** Authenticated daemon transport, independent of any agent session or preview URL. */
export function connectPreviewTunnel(serverUrl: string, token: string, machineId: string): () => void {
    const socket: Socket = io(`${serverUrl.replace(/\/$/, '')}/preview-tunnel`, {
        path: '/v1/updates', auth: { token, machineId }, transports: ['websocket'], reconnection: true,
    });
    const requests = new Map<string, ClientRequest>();
    const websockets = new Map<string, WebSocket>();
    const incoming = new Map<string, { chunks: Buffer[]; size: number }>();
    const outgoing = new Map<string, { ready: Promise<void>; start: () => void; chain: Promise<void>; bytes: number }>();
    const closeAll = () => { for (const request of requests.values()) request.destroy(); requests.clear(); for (const ws of websockets.values()) ws.terminate(); websockets.clear(); incoming.clear(); for (const pending of outgoing.values()) pending.start(); outgoing.clear(); };
    socket.on('disconnect', closeAll);
    socket.on('preview-http', (data: PreviewHttpRequest, acknowledge: (answer: { accepted: boolean }) => void) => {
        if (requests.size >= 32 || typeof data?.id !== 'string') return acknowledge({ accepted: false });
        try {
            const target = new URL(validatePreviewTarget(data.target));
            const request = (target.protocol === 'https:' ? httpsRequest : httpRequest)(target, { method: data.method, headers: { ...data.headers, 'accept-encoding': 'identity', ...(data.headers.origin ? { origin: target.origin } : {}) } }, response => {
                const html = /\btext\/html\b/i.test(String(response.headers['content-type'])) && !response.headers['content-encoding'] && data.method !== 'HEAD';
                const responseHeaders = { ...response.headers };
                if (html) { delete responseHeaders['content-length']; delete responseHeaders.etag; delete responseHeaders['content-md5']; }
                socket.emit('preview-head', { id: data.id, status: response.statusCode ?? 502, headers: responseHeaders });
                void (async () => {
                    let prelude: Buffer | null = html ? Buffer.alloc(0) : null;
                    const send = async (chunk: Buffer) => {
                        for (let offset = 0; offset < chunk.length; offset += CHUNK_BYTES) await socket.timeout(30_000).emitWithAck('preview-response', { id: data.id, data: chunk.subarray(offset, offset + CHUNK_BYTES) });
                    };
                    try {
                        for await (const dataChunk of response) {
                            const chunk = Buffer.from(dataChunk);
                            if (prelude !== null) {
                                prelude = Buffer.concat([prelude, chunk]);
                                const head = /<head\b[^>]*>/i.exec(prelude.toString('latin1'));
                                if (!head && prelude.length < 16 * 1024) continue;
                                const at = head ? head.index + head[0].length : /<!doctype[^>]*>/i.exec(prelude.toString('latin1'))?.[0].length ?? 0;
                                await send(Buffer.concat([prelude.subarray(0, at), Buffer.from(`<script src="${data.prefix}__hapla_bridge.js"></script>`), prelude.subarray(at)]));
                                prelude = null;
                            } else await send(chunk);
                        }
                        if (prelude !== null) {
                            const at = /<!doctype[^>]*>/i.exec(prelude.toString('latin1'))?.[0].length ?? 0;
                            await send(Buffer.concat([prelude.subarray(0, at), Buffer.from(`<script src="${data.prefix}__hapla_bridge.js"></script>`), prelude.subarray(at)]));
                        }
                        socket.emit('preview-end', { id: data.id });
                    } catch { socket.emit('preview-error', { id: data.id }); request.destroy(); }
                    finally { requests.delete(data.id); }
                })();
            });
            request.setTimeout(15 * 60_000, () => request.destroy(new Error('Preview upstream idle timeout')));
            request.on('error', () => { requests.delete(data.id); socket.emit('preview-error', { id: data.id }); });
            requests.set(data.id, request); acknowledge({ accepted: true });
        } catch { acknowledge({ accepted: false }); }
    });
    socket.on('preview-body', async (data: { id: string; data?: Buffer; end?: boolean }, acknowledge: () => void) => {
        const request = requests.get(data.id);
        try {
            if (!request) return;
            if (data.end) request.end();
            else if (data.data && !request.write(data.data)) await once(request, 'drain');
        } catch { request?.destroy(); }
        finally { acknowledge(); }
    });
    socket.on('preview-cancel', (data: { id: string }) => { requests.get(data.id)?.destroy(); requests.delete(data.id); });
    socket.on('preview-ws-open', (data: { id: string; target: string; headers: Record<string, string>; protocols: string[] }, acknowledge: (answer: { success: boolean; protocol?: string }) => void) => {
        if (websockets.size >= 32) return acknowledge({ success: false });
        try {
            const target = new URL(validatePreviewTarget(data.target)); target.protocol = target.protocol === 'https:' ? 'wss:' : 'ws:';
            const ws = new WebSocket(target, data.protocols, { headers: { ...data.headers, ...(data.headers.origin ? { origin: target.origin.replace(/^ws/, 'http') } : {}) }, handshakeTimeout: 10_000, maxPayload: 16 * 1024 * 1024 });
            websockets.set(data.id, ws);
            let start!: () => void;
            const ready = new Promise<void>(resolve => { start = resolve; });
            const output = { ready, start, chain: Promise.resolve(), bytes: 0 };
            outgoing.set(data.id, output);
            let opened = false;
            ws.once('open', () => { opened = true; acknowledge({ success: true, protocol: ws.protocol }); });
            ws.on('message', (message, binary) => {
                const body = Buffer.from(message as Buffer);
                output.bytes += body.length;
                if (output.bytes > 16 * 1024 * 1024) { ws.terminate(); return; }
                output.chain = output.chain.then(async () => {
                    await output.ready;
                    for (let offset = 0; offset < Math.max(1, body.length); offset += CHUNK_BYTES) {
                        await socket.timeout(30_000).emitWithAck('preview-ws-data', { id: data.id, data: body.subarray(offset, offset + CHUNK_BYTES), binary, end: offset + CHUNK_BYTES >= body.length });
                    }
                    output.bytes -= body.length;
                }).catch(() => ws.terminate());
            });
            ws.on('close', (code, reason) => { websockets.delete(data.id); incoming.delete(data.id); outgoing.delete(data.id); output.start(); socket.emit('preview-ws-close', { id: data.id, code, reason: reason.toString() }); });
            ws.on('error', () => { if (!opened) acknowledge({ success: false }); socket.emit('preview-ws-close', { id: data.id, code: 1011, reason: 'Upstream unavailable' }); });
        } catch { acknowledge({ success: false }); }
    });
    socket.on('preview-ws-ready', (data: { id: string }) => outgoing.get(data.id)?.start());
    socket.on('preview-ws-data', (data: { id: string; data: Buffer; binary: boolean; end: boolean }, acknowledge: () => void) => {
        const ws = websockets.get(data.id);
        try {
            if (ws?.readyState !== WebSocket.OPEN) return;
            const frame = incoming.get(data.id) ?? { chunks: [], size: 0 };
            frame.size += data.data.length;
            if (frame.size > 16 * 1024 * 1024 || ws.bufferedAmount > 16 * 1024 * 1024) { ws.terminate(); return; }
            frame.chunks.push(Buffer.from(data.data));
            if (data.end) { incoming.delete(data.id); ws.send(Buffer.concat(frame.chunks), { binary: data.binary }); }
            else incoming.set(data.id, frame);
        } finally { acknowledge(); }
    });
    socket.on('preview-ws-close', (data: { id: string; code?: number }) => { websockets.get(data.id)?.close(data.code === 1000 ? 1000 : 1001); websockets.delete(data.id); incoming.delete(data.id); outgoing.get(data.id)?.start(); outgoing.delete(data.id); });
    return () => { closeAll(); socket.close(); };
}
