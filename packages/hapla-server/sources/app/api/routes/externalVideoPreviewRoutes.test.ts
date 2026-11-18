import fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { externalVideoPreviewRoutes } from './externalVideoPreviewRoutes';
import { ExternalVideoPreviewError } from '@/storage/externalVideoPreview';
import type { Fastify } from '../types';

const mocks = vi.hoisted(() => ({ preview: vi.fn() }));
vi.mock('@/storage/externalVideoPreview', () => ({ getExternalVideoPreview: mocks.preview, ExternalVideoPreviewError: class extends Error {
    constructor(public statusCode: number, message: string, public reason = 'request_rejected', public retryable = false, public retryAfterMs?: number) { super(message); }
} }));
afterEach(() => vi.clearAllMocks());

async function fixture() {
    const app = fastify();
    app.decorate('authenticate', async (request: any, reply: any) => {
        const token = request.headers.authorization?.slice(7);
        if (!['account-b', 'account-a'].includes(token)) return reply.code(401).send();
        request.userId = token;
    });
    externalVideoPreviewRoutes(app as unknown as Fastify);
    await app.ready(); return app;
}

describe('authenticated external video preview route', () => {
    it('requires an account and passes only its identity, unchanged URL, and cancellation signal', async () => {
        const app = await fixture();
        const url = 'https://bucket.r2.dev/final.mp4?X-Amz-Signature=FAKE%2Fvalue';
        const result = { status: 'ready', posterDataUrl: 'data:image/jpeg;base64,/9g=', width: 320, height: 180, durationSeconds: 2, sizeBytes: 999 };
        mocks.preview.mockResolvedValue(result);
        expect((await app.inject({ method: 'POST', url: '/v1/media/video-preview', payload: { url }, headers: { cookie: 'hapla_site_access=shared' } })).statusCode).toBe(401);
        expect(mocks.preview).not.toHaveBeenCalled();
        for (const account of ['account-b', 'account-a']) {
            const response = await app.inject({ method: 'POST', url: '/v1/media/video-preview', payload: { url }, headers: { authorization: `Bearer ${account}` } });
            expect(response.statusCode).toBe(200); expect(response.json()).toEqual(result);
            expect(response.headers['cache-control']).toBe('no-store');
            expect(mocks.preview).toHaveBeenLastCalledWith(account, url, expect.any(AbortSignal));
        }
        await app.close();
    });
    it('rejects invalid bodies and translates controlled failures without exposing source URLs', async () => {
        const app = await fixture();
        const request = { method: 'POST' as const, url: '/v1/media/video-preview', headers: { authorization: 'Bearer account-b' } };
        expect((await app.inject({ ...request, payload: {} })).statusCode).toBe(400);
        mocks.preview.mockRejectedValueOnce(new ExternalVideoPreviewError(503, 'Video preview is busy', 'preview_busy', true, 1000));
        const busy = await app.inject({ ...request, payload: { url: 'https://bucket.r2.dev/v.mp4?secret=not-shown' } });
        expect(busy.statusCode).toBe(503); expect(busy.headers['retry-after']).toBe('1'); expect(busy.body).not.toContain('secret');
        expect(busy.json()).toMatchObject({ reason: 'preview_busy', retryable: true, retryAfterMs: 1000 });
        mocks.preview.mockRejectedValueOnce(new Error('https://secret-source.invalid/private'));
        const failed = await app.inject({ ...request, payload: { url: 'https://bucket.r2.dev/v.mp4' } });
        expect(failed.statusCode).toBe(502); expect(failed.body).not.toContain('secret-source');
        await app.close();
    });
});
