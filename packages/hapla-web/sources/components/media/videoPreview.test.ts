import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { clearVideoPreviewCache, formatVideoDuration, formatVideoSize, loadVideoPreview, peekVideoPreview, rememberVideoPreview, videoAspectRatio, videoPreviewEndpoint, videoPreviewNotice } from './videoPreview';

const mocks = vi.hoisted(() => ({ sessionVideoPreview: vi.fn(), request: vi.fn(), direct: vi.fn(async () => false), cloud: vi.fn(async () => null) }));
vi.mock('@/utils/cloudFileDelivery', () => ({ acquireCloudFileLink: mocks.cloud }));
vi.mock('@/utils/lanFileDelivery', () => ({ usesDirectFileDelivery: mocks.direct }));
vi.mock('@/sync/ops', () => ({ sessionVideoPreview: mocks.sessionVideoPreview }));
vi.mock('@/sync/apiSocket', () => ({ apiSocket: { request: mocks.request } }));
// Resolve the mocked module before concurrent dynamic imports; Vite's first
// simultaneous mocked imports otherwise race into native Flow dependencies.
beforeAll(async () => { await import('@/sync/ops'); });

afterEach(() => { clearVideoPreviewCache(); vi.useRealTimers(); vi.unstubAllGlobals(); mocks.sessionVideoPreview.mockReset(); mocks.request.mockReset(); mocks.direct.mockResolvedValue(false); mocks.cloud.mockClear(); });

describe('lightweight video previews', () => {
    it('reads the NAS poster for an expired R2 link on LAN without requesting a cloud lease', async () => {
        vi.stubGlobal('window', { location: { origin: 'http://192.168.42.10' } }); vi.stubGlobal('document', {});
        mocks.direct.mockResolvedValue(true);
        mocks.request.mockResolvedValue({ ok: true, json: async () => ({ status: 'ready', width: 1280, height: 720, posterDataUrl: 'data:image/jpeg;base64,AA==' }) });
        const uri = 'https://test.r2.cloudflarestorage.com/video/final.mp4?expired=1';
        expect(await loadVideoPreview({ uri })).toMatchObject({ status: 'ready', width: 1280 });
        expect(mocks.cloud).not.toHaveBeenCalled();
        expect(mocks.request).toHaveBeenCalledWith('/v1/media/video-preview', expect.objectContaining({ body: JSON.stringify({ url: uri }) }));
    });
    it('only calls our same-origin authenticated preview endpoint', () => {
        expect(videoPreviewEndpoint('/files/public/users/a/video.mp4?x=1', 'http://192.168.42.10:12345')).toBe('http://192.168.42.10:12345/files/public/users/a/video.mp4?x=1&preview=video');
        for (const url of ['https://github.com/a/movie.mp4', 'https://evil.test/files/movie.mp4', 'blob:http://192.168.42.10:12345/123', 'data:video/mp4;base64,AA==']) {
            expect(videoPreviewEndpoint(url, 'http://192.168.42.10:12345')).toBeNull();
        }
    });

    it('does not attempt browser video probing without a DOM', async () => {
        const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
        vi.stubGlobal('window', { location: { origin: 'http://localhost' } });
        expect(await loadVideoPreview({ uri: 'https://example.org/movie.mp4' })).toEqual({ status: 'unavailable' });
        expect(fetch).not.toHaveBeenCalled();
    });

    it('deduplicates requests, stores only small validated posters and clears account data', async () => {
        vi.stubGlobal('window', { location: { origin: 'http://localhost' } });
        const fetch = vi.fn(async () => ({ ok: true, json: async () => ({ status: 'ready', width: 1920, height: 1080, sizeBytes: 555,
            durationSeconds: 65, aspectRatio: '16:9', posterDataUrl: 'https://evil.test/track', videoBytes: 'must never retain' }) }));
        vi.stubGlobal('fetch', fetch);
        const source = { uri: '/files/video.mp4' };
        const [first, second] = await Promise.all([loadVideoPreview(source), loadVideoPreview(source)]);
        expect(fetch).toHaveBeenCalledTimes(1);
        expect(first).toEqual(second);
        expect(first.posterDataUrl).toBeUndefined();
        expect(first).not.toHaveProperty('videoBytes');
        expect(fetch.mock.calls[0]).toEqual(['http://localhost/files/video.mp4?preview=video', expect.objectContaining({ credentials: 'same-origin', cache: 'no-store' })]);
        clearVideoPreviewCache(); expect(peekVideoPreview(source)).toBeUndefined();
    });

    it('bounds small metadata cache and does not reuse another session path', () => {
        for (let i = 0; i < 65; i++) rememberVideoPreview({ uri: `video-${i}` }, { status: 'ready', sizeBytes: i });
        expect(peekVideoPreview({ uri: 'video-0' })).toBeUndefined();
        expect(peekVideoPreview({ uri: 'video-64' })?.sizeBytes).toBe(64);
        rememberVideoPreview({ uri: 'x', workspaceVideo: { sessionId: 'a', path: '/file.mp4' } }, { status: 'ready' });
        expect(peekVideoPreview({ uri: 'x', workspaceVideo: { sessionId: 'b', path: '/file.mp4' } })).toBeUndefined();
    });

    it('refreshes metadata for an overwritten artifact without fetching its video body', async () => {
        const source = { uri: '/work/final.mp4', workspaceVideo: { sessionId: 'session', path: '/work/final.mp4' }, previewRevision: 'first-event' };
        mocks.sessionVideoPreview.mockResolvedValueOnce({ status: 'ready', width: 640, height: 360, sizeBytes: 100 });
        await expect(loadVideoPreview(source)).resolves.toMatchObject({ sizeBytes: 100 });
        const updated = { ...source, previewRevision: 'second-event' };
        expect(peekVideoPreview(updated)).toBeUndefined();
        mocks.sessionVideoPreview.mockResolvedValueOnce({ status: 'ready', width: 1920, height: 1080, sizeBytes: 200 });
        await expect(loadVideoPreview(updated)).resolves.toMatchObject({ sizeBytes: 200, width: 1920 });
        expect(mocks.sessionVideoPreview).toHaveBeenCalledTimes(2);
        expect(mocks.sessionVideoPreview.mock.calls).toEqual([['session', '/work/final.mp4'], ['session', '/work/final.mp4']]);
    });

    it('settles hung workspace RPCs after 20 seconds and lets queued cards obtain metadata', async () => {
        vi.useFakeTimers();
        const source = (name: string) => ({ uri: `/workspace/${name}.mp4`, workspaceVideo: { sessionId: 'a', path: `/workspace/${name}.mp4` } });
        mocks.sessionVideoPreview.mockImplementation((_session, file) => file.includes('hung')
            ? new Promise(() => {})
            : Promise.resolve({ status: 'ready', width: 640, height: 360, sizeBytes: 1234 }));
        let settled = 0; const resolvedValues: unknown[] = [];
        const first = loadVideoPreview(source('hung-1')).then(value => { settled++; resolvedValues.push(value); return value; });
        const second = loadVideoPreview(source('hung-2')).then(value => { settled++; resolvedValues.push(value); return value; });
        const queued = loadVideoPreview(source('ready'));
        await vi.dynamicImportSettled();
        expect(mocks.sessionVideoPreview).toHaveBeenCalledTimes(2);
        await vi.advanceTimersByTimeAsync(19_000);
        expect(settled).toBe(0);
        expect(resolvedValues).toEqual([]);
        expect(mocks.sessionVideoPreview.mock.calls).toEqual([['a', '/workspace/hung-1.mp4'], ['a', '/workspace/hung-2.mp4']]);
        await vi.advanceTimersByTimeAsync(1_000);
        await expect(first).resolves.toEqual({ status: 'unavailable' });
        await expect(second).resolves.toEqual({ status: 'unavailable' });
        await vi.dynamicImportSettled();
        await expect(queued).resolves.toMatchObject({ status: 'ready', width: 640, height: 360, sizeBytes: 1234 });
        expect(mocks.sessionVideoPreview).toHaveBeenCalledTimes(3);
        expect(peekVideoPreview(source('ready'))?.sizeBytes).toBe(1234);
    });

    it('account clearing immediately abandons running and queued RPCs and ignores their late results', async () => {
        const source = (name: string) => ({ uri: `/workspace/${name}.mp4`, workspaceVideo: { sessionId: 'a', path: `/workspace/${name}.mp4` } });
        const complete: Array<(value: unknown) => void> = [];
        mocks.sessionVideoPreview.mockImplementation(() => new Promise(resolve => complete.push(resolve)));
        const old = [loadVideoPreview(source('one')), loadVideoPreview(source('two')), loadVideoPreview(source('queued'))];
        await vi.dynamicImportSettled();
        expect(mocks.sessionVideoPreview).toHaveBeenCalledTimes(2);
        clearVideoPreviewCache();
        await expect(Promise.all(old)).resolves.toEqual([{ status: 'unavailable' }, { status: 'unavailable' }, { status: 'unavailable' }]);
        expect(mocks.sessionVideoPreview).toHaveBeenCalledTimes(2);
        expect(peekVideoPreview(source('one'))).toBeUndefined();
        mocks.sessionVideoPreview.mockResolvedValue({ status: 'ready', width: 320, height: 180, sizeBytes: 888 });
        await expect(loadVideoPreview(source('one'))).resolves.toMatchObject({ status: 'ready', sizeBytes: 888 });
        complete.forEach(resolve => resolve({ status: 'ready', width: 1920, height: 1080, sizeBytes: 999999 }));
        await Promise.resolve();
        await Promise.resolve();
        expect(peekVideoPreview(source('one'))).toMatchObject({ status: 'ready', sizeBytes: 888 });
        expect(peekVideoPreview(source('two'))).toBeUndefined();
        expect(peekVideoPreview(source('queued'))).toBeUndefined();
        expect(mocks.sessionVideoPreview).toHaveBeenCalledTimes(3);
    });

    it('formats original facts, including portrait, long duration and exact zero', () => {
        expect(formatVideoDuration(125)).toBe('2:05');
        expect(formatVideoDuration(3661)).toBe('1:01:01');
        expect(formatVideoDuration()).toBe('时长未知');
        expect(videoAspectRatio(1080, 1920)).toBe('9:16');
        expect(formatVideoSize(10485760)).toBe('原文件 10.0 MiB');
        expect(formatVideoSize(0)).toBe('原文件 0 B');
    });

    it('lets transient partial previews recover and clears stale error fields after a successful poster', async () => {
        vi.useFakeTimers();
        vi.stubGlobal('document', {});
        vi.stubGlobal('window', { location: { origin: 'http://localhost' } });
        const source = { uri: 'https://account.r2.dev/clip.mp4?signature=unchanged' };
        mocks.request.mockResolvedValueOnce({ ok: true, json: async () => ({ status: 'ready', width: 720, height: 1280,
            posterStatus: 'unavailable', reason: 'source_busy', retryable: true, retryAfterMs: 1000 }) });
        expect(await loadVideoPreview(source)).toMatchObject({ width: 720, reason: 'source_busy' });
        await loadVideoPreview(source);
        expect(mocks.request).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(1001);
        mocks.request.mockResolvedValueOnce({ ok: true, json: async () => ({ status: 'ready', posterStatus: 'ready', posterDataUrl: 'data:image/jpeg;base64,AA==' }) });
        const recovered = await loadVideoPreview(source);
        expect(mocks.request).toHaveBeenCalledTimes(2);
        expect(recovered).toMatchObject({ width: 720, height: 1280, posterStatus: 'ready', posterDataUrl: 'data:image/jpeg;base64,AA==' });
        expect(recovered.reason).toBeUndefined();
        expect(recovered.retryable).toBeUndefined();
        expect(recovered.retryAfterMs).toBeUndefined();
    });

    it('does not lose known player facts when a preview fails and does not retry a denied source automatically', async () => {
        vi.stubGlobal('document', {});
        vi.stubGlobal('window', { location: { origin: 'http://localhost' } });
        const source = { uri: 'https://account.r2.dev/clip.mp4?signature=denied' };
        rememberVideoPreview(source, { status: 'ready', width: 1920, height: 1080, durationSeconds: 60 });
        mocks.request.mockResolvedValue({ ok: true, json: async () => ({ status: 'unavailable', reason: 'source_denied', retryable: false,
            posterDataUrl: 'https://evil.invalid/track', unexpectedSecret: 'never-cache', retryAfterMs: -1 }) });
        const result = await loadVideoPreview(source, true);
        expect(result).toMatchObject({ status: 'ready', width: 1920, durationSeconds: 60, reason: 'source_denied', retryable: false });
        expect(result.posterDataUrl).toBeUndefined(); expect(result).not.toHaveProperty('unexpectedSecret');
        await loadVideoPreview(source);
        expect(mocks.request).toHaveBeenCalledTimes(1);
    });

    it('preserves a source-confirmed expiry without exposing provider details or automatically retrying it', async () => {
        vi.stubGlobal('document', {});
        vi.stubGlobal('window', { location: { origin: 'http://localhost' } });
        const source = { uri: 'https://account.r2.dev/clip.mp4?signature=expired' };
        mocks.request.mockResolvedValue({ ok: true, json: async () => ({ status: 'unavailable', reason: 'source_expired', retryable: false,
            providerMessage: 'PRIVATE_PROVIDER_DETAIL' }) });
        const result = await loadVideoPreview(source);
        expect(result).toMatchObject({ status: 'unavailable', reason: 'source_expired', retryable: false });
        expect(result).not.toHaveProperty('providerMessage');
        expect(videoPreviewNotice(result)).toBe('链接已过期，请更新链接');
        await loadVideoPreview(source);
        expect(mocks.request).toHaveBeenCalledTimes(1);
    });
});
