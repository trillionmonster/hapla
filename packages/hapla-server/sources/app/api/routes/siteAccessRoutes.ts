import { randomBytes } from 'node:crypto';
import type { FastifyBaseLogger, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { SiteAccess, safeReturnPath } from '@/app/auth/siteAccess';

function html(value: string): string {
    return value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
}

function loginPage(next: string, nonce: string): string {
    return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="dark light"><meta name="theme-color" content="#101820"><title>Hapla · 访问验证</title><link rel="icon" type="image/svg+xml" sizes="any" href="/brand/hapla-favicon-v1.svg"><link rel="apple-touch-icon" sizes="180x180" href="/brand/hapla-icon-180-v1.png"><style nonce="${nonce}">
*{box-sizing:border-box}body{margin:0;min-height:100dvh;display:grid;place-items:center;padding:24px;background:#191919;color:#f2f2f2;font:16px/1.5 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}.card{width:min(100%,390px);padding:32px;border:1px solid #3a3a3a;border-radius:22px;background:#232323;box-shadow:0 18px 60px #0003}.brand{display:flex;align-items:center;gap:10px;font-size:18px;font-weight:650;color:#e5f3ff;letter-spacing:.02em;margin:0 0 24px}.brand img{display:block;width:32px;height:32px}h1{font-size:24px;line-height:1.3;margin:0 0 10px;font-weight:650}.hint{color:#aaa;margin:0 0 26px;font-size:14px}label{display:block;font-size:14px;margin-bottom:8px}input,button{font:inherit;width:100%;min-height:48px;border-radius:12px}input{padding:11px 13px;border:1px solid #555;background:#181818;color:#fff;outline:none}input:focus{border-color:#63ddf2;box-shadow:0 0 0 3px #63ddf222}button{margin-top:16px;background:#d4f5fa;color:#122e36;border:0;font-weight:650;cursor:pointer}button:disabled{opacity:.55;cursor:wait}.error{color:#ffadad;min-height:22px;margin:14px 0 0;font-size:14px}@media(prefers-color-scheme:light){body{background:#f3f3f0;color:#222}.card{background:#fff;border-color:#ddd;box-shadow:0 18px 60px #0001}.brand,.hint{color:#52616d}input{background:#fafafa;color:#222;border-color:#bbb}.error{color:#b42727}}
</style></head><body><main class="card"><p class="brand"><img src="/brand/hapla-favicon-v1.svg" width="32" height="32" alt="" aria-hidden="true"><span>Hapla</span></p><h1>输入系统密码</h1><p class="hint">验证后，使用您的用户密钥登录。</p><form id="access-form" data-next="${html(next)}"><label for="password">系统密码</label><input id="password" name="password" type="password" autocomplete="current-password" required maxlength="1024" autofocus><button type="submit">进入</button><p class="error" role="status" aria-live="polite"></p></form></main><script nonce="${nonce}">
const form=document.getElementById('access-form');form.addEventListener('submit',async(event)=>{event.preventDefault();const button=form.querySelector('button'),error=form.querySelector('.error');button.disabled=true;button.textContent='正在验证…';error.textContent='';try{const response=await fetch('/access/login',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:form.password.value,next:form.dataset.next})});const data=await response.json();if(!response.ok){error.textContent=data.error||'验证失败，请重试。';return}const target=new URL(data.next,location.href);if(!target.hash)target.hash=location.hash;if(target.href===location.href)location.reload();else location.replace(target.href)}catch{error.textContent='连接失败，请重试。'}finally{button.disabled=false;button.textContent='进入'}});
</script></body></html>`;
}

function noStore(reply: FastifyReply) {
    reply.header('Cache-Control', 'no-store').header('Referrer-Policy', 'no-referrer').header('X-Content-Type-Options', 'nosniff');
}

function sameOrigin(request: FastifyRequest): boolean {
    const origin = request.headers.origin;
    if (!origin || origin === 'null') return false;
    try {
        const parsed = new URL(origin);
        const protocol = request.headers['x-forwarded-proto']?.toString().split(',')[0].trim() || request.protocol;
        return parsed.host === request.headers.host && parsed.protocol === `${protocol}:`;
    } catch { return false; }
}

type AccessServer<Logger extends FastifyBaseLogger> = FastifyInstance<Server, IncomingMessage, ServerResponse, Logger>;

export function siteAccessRoutes<Logger extends FastifyBaseLogger>(app: AccessServer<Logger>, access: SiteAccess | null) {
    app.get('/access/check', async (request, reply) => {
        noStore(reply);
        return reply.code(!access || access.hasSession(request.headers.cookie) ? 204 : 401).send();
    });
    app.get('/access/login', async (request, reply) => {
        noStore(reply);
        const next = safeReturnPath(request.headers['x-hapla-return-to'] || (request.query as { next?: string }).next);
        if (!access || access.hasSession(request.headers.cookie)) return reply.redirect(next);
        const nonce = randomBytes(18).toString('base64');
        reply.header('Content-Security-Policy', `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; img-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`);
        reply.header('X-Frame-Options', 'DENY');
        return reply.type('text/html; charset=utf-8').send(loginPage(next, nonce));
    });
    app.post('/access/login', { bodyLimit: 4096 }, async (request, reply) => {
        noStore(reply);
        if (!sameOrigin(request)) return reply.code(403).send({ error: '请从当前页面提交密码。' });
        const body = request.body as { password?: unknown; next?: unknown } | null;
        if (access) {
            const result = await access.verifyPassword(body?.password, request.ip);
            if (result === 'limited') return reply.header('Retry-After', '60').code(429).send({ error: '尝试过于频繁，请稍后重试。' });
            if (result !== 'accepted') return reply.code(401).send({ error: '密码不正确，请重试。' });
            const secure = request.protocol === 'https' || request.headers['x-forwarded-proto']?.toString().split(',')[0].trim() === 'https';
            reply.header('Set-Cookie', access.issueCookie(secure));
        }
        return reply.send({ next: safeReturnPath(body?.next) });
    });
}

export function enableSiteAccess<Logger extends FastifyBaseLogger>(app: AccessServer<Logger>, access: SiteAccess | null, verifyToken: (token: string) => Promise<unknown>) {
    app.addHook('onRequest', async (request, reply) => {
        if (!access) return;
        const path = request.url.split('?')[0];
        // Preview routes enforce owner/account/key access themselves, including
        // on isolated hosts. A public share must not need the main site password.
        if (/^\/preview\/[a-f0-9]{32}(?:\/|$)/.test(path)) return;
        if (path === '/health' || path === '/access/login' || path === '/access/check' || path === '/v1/updates' || path === '/v1/updates/') return;
        if (access.hasSession(request.headers.cookie)) return;
        const authorization = request.headers.authorization;
        if (authorization?.startsWith('Bearer ') && authorization.length < 16384) {
            try { if (await verifyToken(authorization.slice(7))) return; } catch { /* Fail closed. */ }
        }
        noStore(reply);
        return reply.code(401).send({ error: 'Site access password required', code: 'SITE_ACCESS_REQUIRED' });
    });
    siteAccessRoutes(app, access);
}
