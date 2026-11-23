import fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MediaAccess } from '@/app/auth/mediaAccess';
import { privateFilesRoutes } from './privateFilesRoutes';
import type { Fastify } from '../types';

const mocks = vi.hoisted(() => ({ find: vi.fn(), verify: vi.fn(), preview: vi.fn(), imagePreview: vi.fn(), stat: vi.fn(), prepare: vi.fn(), resolve: vi.fn() }));
vi.mock('node:fs/promises', async importOriginal => ({ ...await importOriginal<typeof import('node:fs/promises')>(), stat: mocks.stat }));
vi.mock('@/storage/localCloudFiles', () => ({ localCloudFiles: { prepare: mocks.prepare } }));
vi.mock('@/storage/cloudFileDelivery', () => ({ cloudFiles: { resolve: mocks.resolve } }));
vi.mock('@/app/auth/auth', () => ({ auth: { verifyToken: mocks.verify } }));
vi.mock('@/storage/db', () => ({ db: { uploadedFile: { findUnique: mocks.find } } }));
vi.mock('@/storage/files', () => ({ getLocalFilesDir: () => '/private-files', getStoredFileContentType: (file: string) => file.endsWith('.png') ? 'image/png' : file.endsWith('.svg') ? 'image/svg+xml' : file.endsWith('.html') ? 'text/html' : 'video/mp4' }));
vi.mock('@/storage/imagePreview', async original => ({ ...await original<typeof import('@/storage/imagePreview')>(), getImagePreview: mocks.imagePreview }));
vi.mock('@/storage/videoPreview', () => ({ getVideoPreview: mocks.preview, VideoPreviewBusyError: class extends Error {} }));
vi.mock('../utils/serveFileRange', () => ({ serveFileRange: ({ reply, cacheControl }: any) => reply.header('Cache-Control', cacheControl).send('owned bytes') }));
afterEach(() => vi.clearAllMocks());

async function fixture() {
    const app = fastify();
    mocks.stat.mockResolvedValue({ size: 100 });
    mocks.verify.mockImplementation(async token => ['account-b', 'account-a'].includes(token) ? { userId: token } : null);
    mocks.find.mockImplementation(async ({ where }) => where.accountId_path.accountId === 'account-b' && ['owned.mp4', 'owned.png', 'owned.svg', 'owned.html'].includes(where.accountId_path.path) ? { id: 'file' } : null);
    app.decorate('authenticate', async (request: any, reply: any) => {
        const verified = await mocks.verify(request.headers.authorization?.slice(7));
        if (!verified) return reply.code(401).send();
        request.userId = verified.userId;
    });
    const access = new MediaAccess('test master secret');
    privateFilesRoutes(app as unknown as Fastify, access);
    await app.ready();
    return { app, access };
}

describe('private media access', () => {
    it('serves a bounded owner-only image preview independently of large-original Cloudflare delivery', async () => {
        const { app, access } = await fixture();
        mocks.stat.mockResolvedValue({ size: 8 * 1024 * 1024 });
        const data = Buffer.from([0xff, 0xd8, 1, 2, 0xff, 0xd9]);
        mocks.imagePreview.mockResolvedValue({ data, contentType: 'image/jpeg', width: 1280, height: 720 });
        for (const headers of [{ host: 'hapla.example.com', cookie: access.issueCookie('account-b', false) }, { host: 'hapla.example.com', authorization: 'Bearer account-b' }]) {
            const response = await app.inject({ url: '/files/owned.png?preview=image', headers });
            expect(response.statusCode).toBe(200);
            expect(response.rawPayload).toEqual(data);
            expect(response.headers['content-type']).toBe('image/jpeg');
            expect(response.headers['cache-control']).toBe('no-store');
            expect(response.headers['x-content-type-options']).toBe('nosniff');
            expect(response.headers['content-security-policy']).toContain('sandbox');
            expect(response.headers.location).toBeUndefined();
        }
        expect(mocks.imagePreview).toHaveBeenCalledWith('/private-files/owned.png');
        expect(mocks.prepare).not.toHaveBeenCalled();
        for (const headers of [{ cookie: access.issueCookie('account-a', false) }, { cookie: 'hapla_site_access=shared' }, { authorization: 'Bearer forged', cookie: access.issueCookie('account-b', false) }]) {
            const denied = await app.inject({ url: '/files/owned.png?preview=image', headers });
            expect([401, 404]).toContain(denied.statusCode);
        }
        expect(mocks.imagePreview).toHaveBeenCalledTimes(2);
        mocks.prepare.mockResolvedValue({ id: 'a', name: 'owned.png', state: 'preparing', stage: 'uploading-r2' });
        const original = await app.inject({ url: '/files/owned.png?delivery=1', headers: { host: 'hapla.example.com', authorization: 'Bearer account-b' } });
        expect(original.json()).toMatchObject({ state: 'preparing' });
        expect(mocks.prepare).toHaveBeenCalledExactlyOnceWith('account-b', '/private-files/owned.png', false);
        await app.close();
    });

    it('never previews an unsafe path, SVG, HTML or non-image source', async () => {
        const { app } = await fixture();
        const headers = { authorization: 'Bearer account-b' };
        for (const name of ['owned.mp4', 'owned.svg', 'owned.html']) {
            expect((await app.inject({ url: `/files/${name}?preview=image`, headers })).statusCode).toBe(415);
        }
        mocks.find.mockResolvedValue({ id: 'malformed database record' });
        expect((await app.inject({ url: '/files/..%2fescape.png?preview=image', headers })).statusCode).toBe(403);
        expect(mocks.imagePreview).not.toHaveBeenCalled();
        expect(mocks.prepare).not.toHaveBeenCalled();
        await app.close();
    });

    it('returns bounded busy and source-change errors without falling back to the original', async () => {
        const { ImagePreviewBusyError, ImagePreviewError } = await import('@/storage/imagePreview');
        const { app } = await fixture();
        const request = { url: '/files/owned.png?preview=image', headers: { authorization: 'Bearer account-b' } };
        mocks.imagePreview.mockRejectedValueOnce(new ImagePreviewBusyError('full'));
        const busy = await app.inject(request);
        expect(busy.statusCode).toBe(503);
        expect(busy.headers['retry-after']).toBe('2');
        mocks.imagePreview.mockRejectedValueOnce(new ImagePreviewError('图片已发生变化', 409));
        expect((await app.inject(request)).statusCode).toBe(409);
        mocks.imagePreview.mockResolvedValueOnce(null);
        expect((await app.inject(request)).statusCode).toBe(404);
        expect(mocks.prepare).not.toHaveBeenCalled();
        await app.close();
    });

    it('redirects owned large-file downloads to a fresh attachment signature, keeping previews inline', async () => {
        const { app } = await fixture();
        mocks.stat.mockResolvedValue({ size: 2 * 1024 * 1024 });
        const inline = 'https://test.r2.cloudflarestorage.com/owned.mp4?preview';
        const download = 'https://test.r2.cloudflarestorage.com/owned.mp4?attachment';
        mocks.prepare.mockResolvedValue({ id: 'a', name: 'owned.mp4', state: 'ready', url: inline, downloadUrl: inline, expiresAt: Date.now() + 3600000 });
        mocks.resolve.mockResolvedValue({ url: download });
        const response = await app.inject({ url: '/files/owned.mp4?download=1', headers: { host: 'hapla.example.com', authorization: 'Bearer account-b' } });
        expect(response.statusCode).toBe(302); expect(response.headers.location).toBe(download);
        expect(mocks.resolve).toHaveBeenCalledExactlyOnceWith('account-b', inline, true, 'owned.mp4');
        const preview = await app.inject({ url: '/files/owned.mp4', headers: { host: 'hapla.example.com', authorization: 'Bearer account-b' } });
        expect(preview.headers.location).toBe(inline);
        const denied = await app.inject({ url: '/files/owned.mp4?download=1', headers: { authorization: 'Bearer account-a' } });
        expect(denied.statusCode).toBe(404); expect(mocks.resolve).toHaveBeenCalledTimes(1);
        await app.close();
    });
    it('serves large originals directly on LAN and ignores proxy internal addresses for public visits', async () => {
        const { app } = await fixture();
        mocks.stat.mockResolvedValue({ size: 8 * 1024 * 1024 });
        for (const host of ['192.168.42.10:12345', '192.168.1.10', '[fd00::1]:12345']) {
            const headers = { host, authorization: 'Bearer account-b' };
            const response = await app.inject({ url: '/files/owned.mp4?download=1', headers });
            expect(response.statusCode).toBe(200); expect(response.body).toBe('owned bytes');
            expect(response.headers['content-disposition']).toContain('attachment');
            const metadata = await app.inject({ url: '/files/owned.mp4?delivery=1', headers });
            expect(metadata.json()).toEqual({ size: 8 * 1024 * 1024, required: false });
        }
        expect(mocks.prepare).not.toHaveBeenCalled(); expect(mocks.resolve).not.toHaveBeenCalled();
        await app.close();
    });
    it('returns only metadata and a small poster for an owned video, without streaming video bytes', async () => {
        const { app, access } = await fixture();
        const preview = { status: 'ready', width: 1920, height: 1080, durationSeconds: 12.5, aspectRatio: '16:9', sizeBytes: 123456789, posterDataUrl: 'data:image/jpeg;base64,/9g=' };
        mocks.preview.mockResolvedValue(preview);
        const response = await app.inject({ url: '/files/owned.mp4?preview=video', headers: { cookie: access.issueCookie('account-b', false) } });
        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual(preview);
        expect(response.headers['cache-control']).toBe('no-store');
        expect(mocks.preview).toHaveBeenCalledExactlyOnceWith('/private-files/owned.mp4');
        for (const headers of [{ cookie: access.issueCookie('account-a', false) }, { cookie: 'hapla_site_access=shared' }, { authorization: 'Bearer forged', cookie: access.issueCookie('account-b', false) }]) {
            const denied = await app.inject({ url: '/files/owned.mp4?preview=video', headers });
            expect([401, 404]).toContain(denied.statusCode);
        }
        expect(mocks.preview).toHaveBeenCalledTimes(1);
        await app.close();
    });

    it('requires account identity even with the shared site password cookie', async () => {
        const { app } = await fixture();
        for (const cookie of ['', 'hapla_site_access=shared', 'hapla_media_access=forged']) {
            const response = await app.inject({ url: '/files/owned.mp4', headers: { cookie } });
            expect(response.statusCode).toBe(401);
            expect(response.headers['cache-control']).toBe('no-store');
        }
        expect(mocks.find).not.toHaveBeenCalled();
        await app.close();
    });

    it('serves owners and refuses another account knowing the exact path, for cookie and bearer', async () => {
        const { app, access } = await fixture();
        for (const account of ['account-b', 'account-a']) {
            for (const headers of [{ cookie: access.issueCookie(account, false).split(';')[0] }, { authorization: `Bearer ${account}` }]) {
                const response = await app.inject({ url: '/files/owned.mp4', headers });
                expect(response.statusCode).toBe(account === 'account-b' ? 200 : 404);
                expect(response.headers['cache-control']).toBe('no-store');
                expect(response.headers.vary).toBe('Cookie, Authorization');
            }
        }
        // Explicit invalid identity must never fall back to an older cookie.
        expect((await app.inject({ url: '/files/owned.mp4', headers: { authorization: 'Bearer forged', cookie: access.issueCookie('account-b', false) } })).statusCode).toBe(401);
        await app.close();
    });

    it('issues and clears only a file-scoped cookie after bearer authentication', async () => {
        const { app, access } = await fixture();
        expect((await app.inject({ method: 'POST', url: '/v1/account/media-access', headers: { cookie: access.issueCookie('account-b', false) } })).statusCode).toBe(401);
        const response = await app.inject({ method: 'POST', url: '/v1/account/media-access', headers: { authorization: 'Bearer account-b', 'x-forwarded-proto': 'https' } });
        expect(response.statusCode).toBe(204);
        const cookie = String(response.headers['set-cookie']);
        expect(cookie).toContain('Path=/files/; HttpOnly; SameSite=Lax');
        expect(cookie).toContain('; Secure');
        expect(cookie).toContain('hapla_preview_auth=account-b; Path=/preview/; HttpOnly; SameSite=Strict; Secure');
        expect(cookie).not.toContain('Bearer');
        expect(access.accountId(cookie)).toBe('account-b');
        const logout = await app.inject({ method: 'DELETE', url: '/v1/account/media-access', headers: { authorization: 'Bearer account-b' } });
        expect(logout.statusCode).toBe(204);
        expect(String(logout.headers['set-cookie'])).toContain('Path=/files/; HttpOnly; SameSite=Lax; Max-Age=0');
        expect(String(logout.headers['set-cookie'])).toContain('hapla_preview_auth=; Path=/preview/; HttpOnly; SameSite=Strict; Max-Age=0');
        await app.close();
    });

    it('rejects expired, modified, foreign-server and malformed cookies', () => {
        let now = 0;
        const access = new MediaAccess('server1', () => now);
        const cookie = access.issueCookie('account-b', false);
        expect(access.accountId(cookie)).toBe('account-b');
        expect(new MediaAccess('server2', () => now).accountId(cookie)).toBeNull();
        expect(access.accountId(cookie.replace(/\.[^;]+/, '.forged'))).toBeNull();
        expect(access.accountId('hapla_media_access=' + 'a'.repeat(3000))).toBeNull();
        expect(access.accountId('hapla_media_access=abc.' + 'é'.repeat(43))).toBeNull();
        now = 30 * 24 * 60 * 60 * 1000;
        expect(access.accountId(cookie)).toBeNull();
    });
});
