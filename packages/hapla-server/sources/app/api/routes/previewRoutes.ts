import { z } from 'zod';
import { WebSocketServer } from 'ws';
import type { IncomingMessage } from 'node:http';
import type { Fastify } from '../types';
import { auth } from '@/app/auth/auth';
import { previewRegistry } from '@/app/preview/previewRegistry';
import { previewBroker } from '@/app/preview/previewBroker';
import { previewHtmlBridge, previewRequestHeaders, previewResponseHeaders, previewTargetUrl } from '@/app/preview/previewRouting';

const COOKIE = 'hapla_preview_auth';
const handleSchema = z.string().regex(/^[a-f0-9]{32}$/);
function secure(request: { headers: Record<string, unknown>; protocol?: string }) { return request.protocol === 'https' || String(request.headers['x-forwarded-proto'] ?? '').split(',')[0].trim() === 'https'; }
function cookie(token: string, tls: boolean) { return `${COOKIE}=${encodeURIComponent(token)}; Path=/preview/; HttpOnly; SameSite=Strict${tls ? '; Secure' : ''}`; }

async function owner(request: IncomingMessage): Promise<string | null> {
    const value = request.headers.cookie?.split(';').map(value => value.trim()).find(value => value.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);
    if (!value || value.length > 8192) return null;
    try { return (await auth.verifyToken(decodeURIComponent(value)))?.userId ?? null; } catch { return null; }
}

function path(raw: string) {
    const match = /^\/preview\/([a-f0-9]{32})(?:\/(.*))?$/.exec(raw.split('?')[0]);
    if (!match) return null;
    return { handle: match[1], suffix: `${match[2] ?? ''}${raw.includes('?') ? raw.slice(raw.indexOf('?')) : ''}` };
}

export function previewRoutes(app: Fastify) {
    app.post('/v1/preview/access', { preHandler: app.authenticate }, async (request, reply) => reply.header('Set-Cookie', cookie(request.headers.authorization!.slice(7), secure(request))).header('Cache-Control', 'no-store').send({ success: true }));
    app.post('/preview/:handle/__hapla_auth', { preHandler: app.authenticate }, async (request, reply) => reply.header('Set-Cookie', cookie(request.headers.authorization!.slice(7), secure(request))).header('Cache-Control', 'no-store').send({ success: true }));
    app.delete('/v1/preview/access', { preHandler: app.authenticate }, async (request, reply) => reply.header('Set-Cookie', cookie('', secure(request)) + '; Max-Age=0').send({ success: true }));
    app.get('/v1/previews', { preHandler: app.authenticate }, async request => ({ registrations: await previewRegistry.list(request.userId) }));
    app.post('/v1/previews', { preHandler: app.authenticate, bodyLimit: 8192, schema: { body: z.object({ handle: handleSchema.optional(), name: z.string().trim().min(1).max(100), machineId: z.string().min(1).max(128), target: z.string().max(4096), revision: z.number().int().nonnegative().optional() }) } }, async (request, reply) => {
        try { return await previewRegistry.save(request.userId, request.body); }
        catch (error) { return reply.code(409).send({ error: error instanceof Error ? error.message : '代理配置失败' }); }
    });
    app.delete('/v1/previews/:handle', { preHandler: app.authenticate, schema: { params: z.object({ handle: handleSchema }) } }, async request => { await previewRegistry.remove(request.userId, request.params.handle); return { success: true }; });
    app.register(async scope => {
        scope.removeAllContentTypeParsers();
        scope.addContentTypeParser('*', (_request, payload, done) => done(null, payload));
        scope.all('/preview/:handle/*', async (request, reply) => {
            const account = await owner(request.raw);
            if (!account) return reply.code(401).header('Cache-Control', 'no-store').type('text/html; charset=utf-8').send(`<!doctype html><meta charset="utf-8"><title>Hapla 开发代理</title><p id="status">正在验证当前 Hapla 账号…</p><a href="/">返回 Hapla 登录</a><script>(async()=>{try{const saved=JSON.parse(localStorage.getItem('auth_credentials')||'null');if(!saved?.token)throw Error();const response=await fetch('/preview/'+location.pathname.split('/')[2]+'/__hapla_auth',{method:'POST',headers:{Authorization:'Bearer '+saved.token},credentials:'same-origin'});if(!response.ok)throw Error();location.reload()}catch{document.getElementById('status').textContent='请先登录 Hapla 当前账号，再打开此固定链接。'}})();</script>`);
            const selected = path(request.raw.url ?? '');
            const registration = selected && await previewRegistry.get(account, selected.handle);
            if (!selected || !registration) return reply.code(404).send('代理不存在或不属于当前账号');
            if (selected.suffix === '__hapla_bridge.js') return reply.header('Cache-Control', 'no-store').type('application/javascript; charset=utf-8').send(previewHtmlBridge(`/preview/${selected.handle}/`, registration.target).slice(8, -9));
            try {
                const socket = previewBroker.machine(account, registration.machineId);
                const target = previewTargetUrl(registration.target, selected.suffix);
                reply.hijack();
                await previewBroker.proxyHttp(socket, request.raw, reply.raw, { target, prefix: `/preview/${selected.handle}/`, method: request.method, headers: previewRequestHeaders(request.headers) }, head => previewResponseHeaders(head.headers, selected.handle, target));
            } catch {
                if (reply.raw.headersSent) reply.raw.destroy();
                else if (reply.sent) { reply.raw.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' }); reply.raw.end('工作台暂时离线，重新连接后此固定链接可继续使用。'); }
                else return reply.code(503).send('工作台暂时离线，重新连接后此固定链接可继续使用。');
            }
        });
    });
    // Keep the trailing slash so relative resources stay inside the handle.
    app.get('/preview/:handle', async (request, reply) => { const selected = path(request.raw.url ?? ''); return selected ? reply.redirect(`/preview/${selected.handle}/${(request.raw.url ?? '').includes('?') ? (request.raw.url ?? '').slice((request.raw.url ?? '').indexOf('?')) : ''}`) : reply.code(404).send(); });

    const upgrade = (request: IncomingMessage, socket: any, head: Buffer) => {
        const selected = path(request.url ?? '');
        if (!selected) { if (!/^\/v1\/updates(?:\/|\?|$)/.test(request.url ?? '')) socket.destroy(); return; }
        void (async () => {
            const account = await owner(request);
            const registration = account && await previewRegistry.get(account, selected.handle);
            if (!account || !registration) { socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n'); return; }
            const origin = request.headers.origin;
            // Only this browser's actual origin may use its account cookie.
            if (origin && ![request.headers.host, String(request.headers['x-forwarded-host'] ?? '').split(',')[0].trim()].includes(new URL(origin).host)) { socket.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return; }
            const target = previewTargetUrl(registration.target, selected.suffix);
            const tunnel = await previewBroker.openWebsocket(previewBroker.machine(account, registration.machineId), {
                target, headers: previewRequestHeaders(request.headers), protocols: String(request.headers['sec-websocket-protocol'] ?? '').split(',').map(value => value.trim()).filter(Boolean),
            });
            const server = new WebSocketServer({ noServer: true, handleProtocols: () => tunnel.protocol || false, maxPayload: 16 * 1024 * 1024 });
            server.handleUpgrade(request, socket, head, ws => { tunnel.attach(ws); ws.once('close', () => server.close()); });
        })().catch(() => socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'));
    };
    app.server.on('upgrade', upgrade);
    app.addHook('onClose', async () => { app.server.off('upgrade', upgrade); });
}
