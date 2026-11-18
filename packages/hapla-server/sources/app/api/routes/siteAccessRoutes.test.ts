import fastify from 'fastify';
import { scryptSync } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { SiteAccess } from '@/app/auth/siteAccess';
import { enableSiteAccess } from './siteAccessRoutes';

const salt = Buffer.alloc(16, 2);
const hash = `scrypt$${salt.toString('hex')}$${scryptSync('test password', salt, 32).toString('hex')}`;
const options = { host: 'hapla.local:12345', origin: 'http://hapla.local:12345' };

async function fixture(enabled = true) {
    const app = fastify();
    const verify = vi.fn(async (token: string) => token === 'valid-token' ? { userId: 'owner' } : null);
    const access = enabled ? new SiteAccess(hash, 'test secret') : null;
    enableSiteAccess(app, access, verify);
    for (const path of ['/health', '/v1/auth', '/v1/sessions', '/files/test', '/v1/updates/', '/v1/updates-evil']) {
        app.route({ method: ['GET', 'POST'], url: path, handler: async () => ({ reached: true }) });
    }
    await app.ready();
    return { app, verify, access };
}

describe('global site access routes', () => {
    it('blocks anonymous auth, files, APIs and unknown routes before they run', async () => {
        const { app } = await fixture();
        for (const url of ['/v1/auth', '/v1/sessions', '/files/test', '/unknown', '/v1/updates-evil']) {
            const response = await app.inject({ method: 'POST', url, payload: {} });
            expect(response.statusCode).toBe(401);
            expect(response.json().code).toBe('SITE_ACCESS_REQUIRED');
        }
        expect((await app.inject('/health')).statusCode).toBe(200);
        expect((await app.inject('/v1/updates/')).statusCode).toBe(200);
        await app.close();
    });

    it('accepts verified CLI bearer tokens for API but never for page checks', async () => {
        const { app, verify } = await fixture();
        expect((await app.inject({ url: '/v1/sessions', headers: { authorization: 'Bearer fake' } })).statusCode).toBe(401);
        const headers = { authorization: 'Bearer valid-token' };
        expect((await app.inject({ url: '/v1/sessions', headers })).statusCode).toBe(200);
        expect((await app.inject({ url: '/access/check', headers })).statusCode).toBe(401);
        expect(verify).toHaveBeenCalledWith('valid-token');
        await app.close();
    });

    it('returns a self-contained password page, then unlocks with the signed cookie', async () => {
        const { app } = await fixture();
        const page = await app.inject('/access/login?next=%2Fsession%2Fabc');
        expect(page.statusCode).toBe(200);
        expect(page.headers['cache-control']).toBe('no-store');
        expect(page.headers['content-security-policy']).toContain("frame-ancestors 'none'");
        expect(page.headers['content-security-policy']).toContain("img-src 'self'");
        expect(page.headers['content-security-policy']).toContain("default-src 'none'");
        expect(page.headers['content-security-policy']).not.toContain('unsafe-inline');
        expect(page.body).toContain('rel="icon" type="image/svg+xml" sizes="any" href="/brand/hapla-favicon-v1.svg"');
        expect(page.body).toContain('<img src="/brand/hapla-favicon-v1.svg" width="32" height="32" alt=""');
        expect(page.body).toContain('type="password"');
        const wrong = await app.inject({ method: 'POST', url: '/access/login', headers: options, payload: { password: 'wrong' } });
        expect(wrong.statusCode).toBe(401);
        expect(wrong.headers['set-cookie']).toBeUndefined();
        const response = await app.inject({ method: 'POST', url: '/access/login', headers: options, payload: { password: 'test password', next: '/session/abc' } });
        expect(response.json()).toEqual({ next: '/session/abc' });
        const cookie = String(response.headers['set-cookie']).split(';')[0];
        expect((await app.inject({ url: '/access/check', headers: { cookie } })).statusCode).toBe(204);
        expect((await app.inject({ url: '/files/test', headers: { cookie } })).statusCode).toBe(200);
        await app.close();
    });

    it('rejects cross-origin and missing-origin login, and honors HTTPS proxy cookie security', async () => {
        const { app } = await fixture();
        for (const origin of ['http://evil.invalid', 'https://hapla.local:12345', 'null', undefined]) {
            const headers: Record<string, string> = { host: options.host };
            if (origin) headers.origin = origin;
            expect((await app.inject({ method: 'POST', url: '/access/login', headers, payload: { password: 'test password' } })).statusCode).toBe(403);
        }
        const response = await app.inject({ method: 'POST', url: '/access/login', headers: { host: 'tunnel.example', origin: 'https://tunnel.example', 'x-forwarded-proto': 'https' }, payload: { password: 'test password', next: '//evil.invalid' } });
        expect(response.statusCode).toBe(200);
        expect(response.json().next).toBe('/');
        expect(response.headers['set-cookie']).toContain('; Secure');
        await app.close();
    });

    it('retains complete return paths when nginx renders the gate for a deep link', async () => {
        const { app } = await fixture();
        const page = await app.inject({ url: '/access/login', headers: { 'x-hapla-return-to': '/session/abc/file?path=encoded&view=preview' } });
        expect(page.body).toContain('data-next="/session/abc/file?path=encoded&amp;view=preview"');
        await app.close();
    });

    it('keeps installations without a configured password compatible', async () => {
        const { app } = await fixture(false);
        expect((await app.inject('/access/check')).statusCode).toBe(204);
        expect((await app.inject('/v1/auth')).statusCode).toBe(200);
        expect((await app.inject('/access/login')).statusCode).toBe(302);
        await app.close();
    });
});
