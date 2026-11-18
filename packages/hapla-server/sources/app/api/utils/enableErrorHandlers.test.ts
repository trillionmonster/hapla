import fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { enableErrorHandlers } from './enableErrorHandlers';
import { enableJsonParser } from './enableJsonParser';
import { CloudDeliveryError } from '@/storage/cloudFileDelivery';

const { log } = vi.hoisted(() => ({ log: vi.fn() }));
vi.mock('@/utils/log', () => ({ log }));

describe('access password error redaction', () => {
    beforeEach(() => log.mockClear());
    it.each(['/access/login', '/access/%6cogin', '/v1/media/video-preview', '/v1/media/video-%70review', '/v1/files/cloud/resolve', '/v1/files/cloud/%72esolve'])('redacts malformed JSON from responses and every log hook on %s', async (url) => {
        const app = fastify();
        enableErrorHandlers(app as any);
        enableJsonParser(app as any);
        app.post('/access/login', async () => ({ ok: true }));
        app.post('/v1/media/video-preview', async () => ({ ok: true }));
        app.post('/v1/files/cloud/resolve', async () => ({ ok: true }));
        const probe = 'password-canary-NEVER-LOG';
        const response = await app.inject({ method: 'POST', url,
            headers: { 'content-type': 'application/json' }, payload: `{"password":"${probe}" BROKEN` });
        expect(response.statusCode).toBe(400);
        expect(response.body).not.toContain(probe);
        expect(JSON.stringify(log.mock.calls)).not.toContain(probe);
        expect(log).toHaveBeenCalledWith(expect.objectContaining({ module: 'site-access-error' }), 'Site access request failed');
        await app.close();
    });
    it.each(['/v1/files/cloud/resolve', '/v1/files/cloud/example/source'])('preserves safe file errors on %s while hiding unexpected exceptions', async url => {
        const app = fastify();
        enableErrorHandlers(app as any);
        const failure = new CloudDeliveryError(503, 'Cloudflare 上传暂时暂停，请稍后重试');
        app.post(url, async () => { throw failure; });
        const response = await app.inject({ method: 'POST', url, payload: {} });
        expect(response.statusCode).toBe(503);
        expect(response.json()).toEqual({ error: 'file_delivery_failed', message: failure.message, statusCode: 503 });
        expect(response.headers['cache-control']).toBe('no-store');
        await app.close();
    });
    it('preserves parsed webhook bodies and their original signature input', async () => {
        const app = fastify();
        enableJsonParser(app as any);
        app.post('/webhook', async request => ({ parsed: request.body, raw: (request as any).rawBody }));
        const raw = '{ "event": "example" }';
        const response = await app.inject({ method: 'POST', url: '/webhook', headers: { 'content-type': 'application/json' }, payload: raw });
        expect(response.json()).toEqual({ parsed: { event: 'example' }, raw });
        await app.close();
    });
    it('redacts unexpected login errors, including their stack', async () => {
        const app = fastify();
        enableErrorHandlers(app as any);
        app.post('/access/login', async () => { throw new Error('private-password-value'); });
        const response = await app.inject({ method: 'POST', url: '/access/login', payload: {} });
        expect(response.statusCode).toBe(500);
        expect(response.body).not.toContain('private-password-value');
        expect(JSON.stringify(log.mock.calls)).not.toContain('private-password-value');
        await app.close();
    });
});
