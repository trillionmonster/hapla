import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadServerVideoPreview, supportsServerVideoPreview } from './serverVideoPreview';

const mocks = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('@/sync/apiSocket', () => ({ apiSocket: { request: mocks.request } }));
afterEach(() => mocks.request.mockReset());

describe('restricted object-storage preview requests', () => {
    it('selects only supported HTTPS object-storage sources', () => {
        for (const uri of ['https://account.r2.cloudflarestorage.com/b/a.mp4?signature=x', 'https://public.r2.dev/a.mov', 'https://bucket.s3.us-east-1.amazonaws.com/a.m4v']) expect(supportsServerVideoPreview(uri)).toBe(true);
        for (const uri of ['http://account.r2.cloudflarestorage.com/a.mp4', 'https://x.r2.dev.evil.test/a.mp4', 'https://x.r2.dev:8443/a.mp4', 'https://user:password@x.r2.dev/a.mp4', 'https://github.com/a/b.mp4', 'https://x.r2.dev/a.html', '/work/a.mp4']) expect(supportsServerVideoPreview(uri)).toBe(false);
    });

    it('sends the unmodified signed URL only to the authenticated preview API', async () => {
        const url = 'https://account.r2.cloudflarestorage.com/b/a.mp4?X-Amz-Credential=a%2Fb&X-Amz-Signature=x+y';
        const value = { status: 'ready', sizeBytes: 46228740, width: 1920, height: 1080 };
        mocks.request.mockResolvedValue({ ok: true, json: async () => value });
        const controller = new AbortController();
        expect(await loadServerVideoPreview(url, controller.signal)).toEqual(value);
        expect(mocks.request).toHaveBeenCalledWith('/v1/media/video-preview', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url }), cache: 'no-store', signal: controller.signal,
        });
    });

    it('does not issue a request after the card has been released', async () => {
        const controller = new AbortController(); controller.abort();
        await expect(loadServerVideoPreview('https://account.r2.dev/a.mp4', controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
        expect(mocks.request).not.toHaveBeenCalled();
    });

    it('exposes a bounded retry delay for a busy queue without fetching the video body', async () => {
        mocks.request.mockResolvedValue({ ok: false, status: 503, headers: new Headers({ 'Retry-After': '999' }) });
        expect(await loadServerVideoPreview('https://account.r2.dev/a.mp4', new AbortController().signal))
            .toEqual({ status: 'unavailable', reason: 'preview_busy', retryable: true, retryAfterMs: 5_000 });
        expect(mocks.request).toHaveBeenCalledTimes(1);
    });

    it('distinguishes a transient network failure from a cancelled request', async () => {
        mocks.request.mockRejectedValue(new TypeError('Failed to fetch'));
        expect(await loadServerVideoPreview('https://account.r2.dev/a.mp4', new AbortController().signal))
            .toMatchObject({ reason: 'network', retryable: true });
        const controller = new AbortController();
        mocks.request.mockImplementation(async () => { controller.abort(); throw new DOMException('Cancelled', 'AbortError'); });
        await expect(loadServerVideoPreview('https://account.r2.dev/a.mp4', controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    });
});
