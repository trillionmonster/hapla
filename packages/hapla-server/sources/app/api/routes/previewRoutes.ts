import { z } from 'zod';
import { previewAccessSchema } from '@hapla/wire';
import { matchesPreviewKey } from '@/app/preview/previewRegistry';
import { browserOrigin, isolatedPreviewOrigin, issuePreviewGrant, verifyPreviewGrant, previewSharingConfigured } from '@/app/preview/previewAccess';
import { WebSocketServer } from 'ws';
import type { IncomingMessage } from 'node:http';
import type { Fastify } from '../types';
import { auth } from '@/app/auth/auth';
import { previewRegistry } from '@/app/preview/previewRegistry';
import { previewBroker } from '@/app/preview/previewBroker';
import { previewEvents } from '@/app/preview/previewEvents';
import { previewSessions, previewSessionCookie } from '@/app/preview/previewSessions';
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

function readCookie(request: IncomingMessage, name: string): string | undefined {
    const value = request.headers.cookie?.split(';').map(item => item.trim()).find(item => item.startsWith(name + '='))?.slice(name.length + 1);
    try { return value && decodeURIComponent(value); } catch { return undefined; }
}
function escapedJson(value: unknown) { return JSON.stringify(value).replace(/</g, '\\u003c'); }
async function upstreamHeaders(request: IncomingMessage, isolated: boolean) {
    let forward = isolated;
    const authorization = request.headers.authorization;
    // Isolated services can keep their own Basic/Bearer authentication. A valid
    // Hapla account bearer must never be delivered to an upstream application.
    if (forward && authorization?.startsWith('Bearer ')) {
        try { forward = authorization.length <= 8192 && !await auth.verifyToken(authorization.slice(7)); }
        catch { forward = false; }
    }
    return previewRequestHeaders(request.headers, forward);
}
async function grantUrl(request: { headers: IncomingMessage['headers']; protocol?: string }, row: { handle: string; accessVersion: number }, viewer: string | null, suffix: string, reply: { header: (name: string, value: string) => unknown }): Promise<string> {
    const origin = isolatedPreviewOrigin(request, row.handle);
    if (!origin || origin.origin === browserOrigin(request).origin) throw new Error('共享需要独立预览域名');
    const session = viewer ? await previewSessions.ensure(viewer, request.headers.cookie) : null;
    if (viewer && !session) throw new Error('账号代理授权不可用');
    if (session) reply.header('Set-Cookie', previewSessionCookie(viewer!, session.id, secure(request)));
    const url = new URL(`/preview/${row.handle}/__hapla_grant`, origin);
    url.hash = new URLSearchParams({ grant: issuePreviewGrant(row.handle, viewer, row.accessVersion, session ?? undefined), next: `/preview/${row.handle}/${suffix}` }).toString();
    return url.toString();
}
function accessPage(handle: string, canLogin: boolean): string {
    return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Hapla · 代理访问</title><style>body{font:16px/1.5 system-ui;margin:0;min-height:100dvh;display:grid;place-items:center;background:#191919;color:#eee}main{width:min(360px,calc(100% - 64px));padding:24px;border:1px solid #555;border-radius:16px}input,button{box-sizing:border-box;width:100%;padding:12px;border-radius:8px;font:inherit;margin-top:12px}input{background:#242424;color:#fff;border:1px solid #777}button{cursor:pointer}a{color:#a9d8ff}p{color:#bbb}h1{font-size:22px}</style><main><h1>代理访问验证</h1><p id="status">使用当前 Hapla 账号，或输入创建者提供的共享密钥。</p><form id="share"><label for="key">共享密钥</label><input id="key" name="key" type="password" required maxlength="256" autocomplete="off"><button>验证并打开</button></form><p role="alert" id="error"></p><a href="/">返回 Hapla</a></main><script>
    const handle=${escapedJson(handle)};const form=document.getElementById('share');
    async function submit(key){const r=await fetch('/preview/'+handle+'/__hapla_share',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({key,next:location.pathname+location.search})});const d=await r.json();if(!r.ok)throw Error(d.error||'密钥无效或已撤销');location.replace(d.url)}
    form.onsubmit=async e=>{e.preventDefault();const b=form.querySelector('button');b.disabled=true;try{await submit(form.key.value)}catch(e){document.getElementById('error').textContent=e.message}finally{b.disabled=false}};
    (async()=>{const params=new URLSearchParams(location.hash.slice(1));const key=params.get('hapla-key');if(key){params.delete('hapla-key');history.replaceState(null,'',location.pathname+location.search+(params.size?'#'+params:''));try{await submit(key);return}catch(e){document.getElementById('error').textContent=e.message}}
    if(!${canLogin ? 'true' : 'false'})return;try{const saved=JSON.parse(localStorage.getItem('auth_credentials')||'null');if(!saved?.token)return;const r=await fetch('/preview/'+handle+'/__hapla_auth',{method:'POST',headers:{Authorization:'Bearer '+saved.token}});if(r.ok)location.reload()}catch{}})();</script></html>`;
}
async function authorized(request: IncomingMessage, selected: { handle: string }) {
    const row = await previewRegistry.lookup(selected.handle);
    if (!row) return null;
    const isolated = isolatedPreviewOrigin({ headers: request.headers }, selected.handle);
    if (isolated && browserOrigin({ headers: request.headers }).hostname === isolated.hostname) {
        const grant = verifyPreviewGrant(readCookie(request, 'hapla_preview_grant'), selected.handle, row.accessVersion);
        if (grant && await previewSessions.valid(grant.session, grant.viewer) && (grant.viewer === row.accountId || (row.access === 'users' && !!grant.viewer) || (row.access === 'key' && !!row.shareKeyHash))) return { ...row, viewerSession: grant.session, grantExpires: grant.expires };
        return null;
    }
    const account = await owner(request);
    return account && (row.accountId === account || row.access === 'users') ? { ...row, viewerSession: undefined, grantExpires: undefined } : null;
}

export function previewRoutes(app: Fastify) {
    const active = new Map<string, Set<() => void>>();
    const sessions = new Map<string, Set<() => void>>();
    const changed = (handle: string) => { for (const close of active.get(handle) ?? []) close(); };
    const revoked = (id: string) => { for (const close of sessions.get(id) ?? []) close(); };
    const track = (handle: string, session: string | undefined, expires: number | undefined, close: () => void) => {
        const connections = active.get(handle) ?? new Set<() => void>(); connections.add(close); active.set(handle, connections);
        const leases = session ? sessions.get(session) ?? new Set<() => void>() : null;
        if (session && leases) { leases.add(close); sessions.set(session, leases); }
        const timer = expires ? setTimeout(close, Math.max(0, expires - Date.now())) : null;
        timer?.unref();
        return () => { if (timer) clearTimeout(timer); connections.delete(close); if (!connections.size) active.delete(handle); if (session && leases) { leases.delete(close); if (!leases.size) sessions.delete(session); } };
    };
    previewEvents.on('changed', changed); previewEvents.on('session-revoked', revoked);
    app.post('/v1/preview/access', { preHandler: app.authenticate }, async (request, reply) => reply.header('Set-Cookie', cookie(request.headers.authorization!.slice(7), secure(request))).header('Cache-Control', 'no-store').send({ success: true }));
    app.post('/preview/:handle/__hapla_auth', { preHandler: app.authenticate }, async (request, reply) => reply.header('Set-Cookie', cookie(request.headers.authorization!.slice(7), secure(request))).header('Cache-Control', 'no-store').send({ success: true }));
    app.delete('/v1/preview/access', { preHandler: app.authenticate }, async (request, reply) => {
        await previewSessions.revoke(request.userId, request.headers.cookie);
        return reply.header('Set-Cookie', [cookie('', secure(request)) + '; Max-Age=0', previewSessionCookie(request.userId, '', secure(request))]).send({ success: true });
    });
    app.get('/v1/previews', { preHandler: app.authenticate }, async request => ({ registrations: (request.query as { scope?: string }).scope === 'visible' ? await previewRegistry.visible(request.userId) : await previewRegistry.list(request.userId), sharingConfigured: previewSharingConfigured() }));
    app.post('/v1/previews', { preHandler: app.authenticate, bodyLimit: 8192, schema: { body: z.object({ handle: handleSchema.optional(), name: z.string().trim().min(1).max(100), machineId: z.string().min(1).max(128), target: z.string().max(4096), revision: z.number().int().nonnegative().optional(), access: previewAccessSchema.optional() }) } }, async (request, reply) => {
        try { return await previewRegistry.save(request.userId, request.body); }
        catch (error) { return reply.code(409).send({ error: error instanceof Error ? error.message : '代理配置失败' }); }
    });
    app.delete('/v1/previews/:handle', { preHandler: app.authenticate, schema: { params: z.object({ handle: handleSchema }) } }, async (request, reply) => { if (!await previewRegistry.remove(request.userId, request.params.handle)) return reply.code(404).send({ error: '代理不存在或不属于当前账号' }); return { success: true }; });
    app.post('/v1/previews/:handle/share-key', { preHandler: app.authenticate, bodyLimit: 1024, schema: { params: z.object({ handle: handleSchema }), body: z.object({ revision: z.number().int().nonnegative(), operation: z.enum(['rotate', 'revoke']) }) } }, async (request, reply) => {
        reply.header('Cache-Control', 'no-store');
        try { return await previewRegistry.shareKey(request.userId, request.params.handle, request.body.revision, request.body.operation); }
        catch (error) { return reply.code(409).send({ error: error instanceof Error ? error.message : '密钥更新失败' }); }
    });
    app.post('/preview/:handle/__hapla_share', { bodyLimit: 1024, schema: { params: z.object({ handle: handleSchema }), body: z.object({ key: z.string().max(256), next: z.string().max(8192).optional() }) } }, async (request, reply) => {
        reply.header('Cache-Control', 'no-store').header('Referrer-Policy', 'no-referrer');
        const row = await previewRegistry.lookup(request.params.handle);
        if (!row || row.access !== 'key' || !matchesPreviewKey(row.shareKeyHash, request.body.key)) return reply.code(403).send({ error: '密钥无效、已撤销或未开启公网共享' });
        const next = request.body.next ?? `/preview/${row.handle}/`;
        if (!next.startsWith(`/preview/${row.handle}/`) || /[\r\n]/.test(next)) return reply.code(400).send({ error: '无效的返回地址' });
        try { return { url: await grantUrl(request, row, null, next.slice(`/preview/${row.handle}/`.length), reply) }; }
        catch { return reply.code(503).send({ error: '独立预览域名尚未就绪' }); }
    });
    app.post('/preview/:handle/__hapla_grant', { bodyLimit: 4096, schema: { params: z.object({ handle: handleSchema }), body: z.object({ grant: z.string().max(2048) }) } }, async (request, reply) => {
        const row = await previewRegistry.lookup(request.params.handle);
        const isolated = isolatedPreviewOrigin(request, request.params.handle);
        const grant = row && verifyPreviewGrant(request.body.grant, row.handle, row.accessVersion);
        if (!row || !isolated || isolated.origin !== browserOrigin(request).origin || !grant || !await previewSessions.valid(grant.session, grant.viewer)) return reply.code(403).send({ error: '访问授权无效或已过期' });
        return reply.header('Cache-Control', 'no-store').header('Set-Cookie', `hapla_preview_grant=${encodeURIComponent(request.body.grant)}; Path=/preview/${row.handle}/; HttpOnly; SameSite=Lax; Max-Age=86400${secure(request) ? '; Secure' : ''}`).send({ success: true });
    });
    app.register(async scope => {
        scope.removeAllContentTypeParsers();
        scope.addContentTypeParser('*', (_request, payload, done) => done(null, payload));
        scope.all('/preview/:handle/*', async (request, reply) => {
            const selected = path(request.raw.url ?? '');
            if (!selected) return reply.code(404).send();
            const isolated = isolatedPreviewOrigin(request, selected.handle);
            const onIsolated = isolated?.origin === browserOrigin(request).origin;
            reply.header('Cache-Control', 'no-store').header('Referrer-Policy', 'no-referrer');
            if (onIsolated && selected.suffix.split('?')[0] === '__hapla_grant') return reply.type('text/html; charset=utf-8').send(`<!doctype html><meta charset="utf-8"><title>Hapla · 打开代理</title><p id="status">正在打开代理…</p><script>(async()=>{try{const p=new URLSearchParams(location.hash.slice(1));const grant=p.get('grant'),next=p.get('next');history.replaceState(null,'',location.pathname);if(!next?.startsWith('/preview/${selected.handle}/'))throw Error();const r=await fetch(location.pathname,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({grant})});if(!r.ok)throw Error();location.replace(next)}catch{document.getElementById('status').textContent='访问授权无效或已过期，请重新打开原始链接。'}})();</script>`);
            const registration = await authorized(request.raw, selected);
            if (!registration) {
                if (onIsolated) return reply.code(401).send('访问已过期或共享已撤销，请从原始 Hapla 链接重新打开。');
                const account = await owner(request.raw);
                return reply.code(account ? 403 : 401).type('text/html; charset=utf-8').send(accessPage(selected.handle, !account));
            }
            if (isolated && !onIsolated) {
                const url = await grantUrl(request, registration, await owner(request.raw), selected.suffix, reply);
                return reply.type('text/html; charset=utf-8').send(`<!doctype html><meta charset="utf-8"><title>Hapla · 打开代理</title><script>history.replaceState(null,'',location.pathname+location.search);location.replace(${escapedJson(url)})</script>`);
            }
            if (registration.access !== 'private' && !onIsolated) return reply.code(503).send('独立预览域名尚未配置，暂不可访问共享代理。');
            if (selected.suffix === '__hapla_bridge.js') return reply.header('Cache-Control', 'no-store').type('application/javascript; charset=utf-8').send(previewHtmlBridge(`/preview/${selected.handle}/`, registration.target).slice(8, -9));
            try {
                const socket = previewBroker.machine(registration.accountId, registration.machineId);
                const target = previewTargetUrl(registration.target, selected.suffix);
                const release = track(selected.handle, registration.viewerSession, registration.grantExpires, () => reply.raw.end());
                reply.raw.once('close', release);
                reply.hijack();
                const headers = await upstreamHeaders(request.raw, !!onIsolated);
                if (reply.raw.destroyed) return;
                await previewBroker.proxyHttp(socket, request.raw, reply.raw, { target, prefix: `/preview/${selected.handle}/`, method: request.method, headers }, head => previewResponseHeaders(head.headers, selected.handle, target));
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
            const registration = await authorized(request, selected);
            if (!registration) { socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n'); return; }
            const origin = request.headers.origin;
            // Only this browser's actual origin may use its account cookie.
            if (origin && ![request.headers.host, String(request.headers['x-forwarded-host'] ?? '').split(',')[0].trim()].includes(new URL(origin).host)) { socket.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return; }
            const target = previewTargetUrl(registration.target, selected.suffix);
            const tunnel = await previewBroker.openWebsocket(previewBroker.machine(registration.accountId, registration.machineId), {
                target, headers: await upstreamHeaders(request, !!isolatedPreviewOrigin({ headers: request.headers }, selected.handle)), protocols: String(request.headers['sec-websocket-protocol'] ?? '').split(',').map(value => value.trim()).filter(Boolean),
            });
            // The upstream handshake is asynchronous; permission may have changed
            // while it was connecting, before this socket could be tracked.
            const fresh = await authorized(request, selected);
            if (!fresh || fresh.accessVersion !== registration.accessVersion || fresh.target !== registration.target || fresh.machineId !== registration.machineId) { tunnel.cancel(); socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n'); return; }
            const server = new WebSocketServer({ noServer: true, handleProtocols: () => tunnel.protocol || false, maxPayload: 16 * 1024 * 1024 });
            server.handleUpgrade(request, socket, head, ws => {
                const release = track(selected.handle, fresh.viewerSession, fresh.grantExpires, () => ws.close(1008, 'Preview access or target changed'));
                tunnel.attach(ws);
                ws.once('close', () => { release(); server.close(); });
            });
        })().catch(() => socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'));
    };
    app.server.on('upgrade', upgrade);
    app.addHook('preClose', async () => { for (const handle of active.keys()) changed(handle); });
    app.addHook('onClose', async () => { app.server.off('upgrade', upgrade); previewEvents.off('changed', changed); previewEvents.off('session-revoked', revoked); for (const handle of active.keys()) changed(handle); });
}
