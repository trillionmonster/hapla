import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const rpc = vi.hoisted(() => ({ machine: vi.fn(), session: vi.fn(), request: vi.fn(), direct: vi.fn() }));
vi.mock('./lanFileDelivery', () => ({ usesDirectFileDelivery: rpc.direct }));
vi.mock('@/sync/apiSocket', () => ({ apiSocket: { machineRPC: rpc.machine, sessionRPC: rpc.session, request: rpc.request } }));
vi.mock('@/sync/storage', () => ({ storage: { getState: () => ({ sessions: { s: { metadata: { path: '/work', machineId: 'machine-one' } } } }) } }));
vi.mock('@/sync/serverConfig', () => ({ getServerUrl: () => 'http://hapla.test' }));
import { acquireCloudWorkspaceFile, acquireStoredCloudFile, acquireCloudFileLink, readCloudFileRange, storedCloudPath, storedImagePreviewUrl, validateCloudDelivery } from './cloudFileDelivery';
import { clearManagedDownloads } from './downloadManager';
import { sessionResources } from '@/sync/sessionResources';

const delivery = { id: 'a'.repeat(64), size: 1024 * 1024 + 1, name: 'a.mp4', state: 'ready' as const, stage: 'ready' as const, progress: 1, expiresAt: Date.now() + 3_600_000,
    url: 'https://bucket.r2.cloudflarestorage.com/a?preview', downloadUrl: 'https://bucket.r2.cloudflarestorage.com/a?download', headUrl: 'https://bucket.r2.cloudflarestorage.com/a?head' };
const options = { sessionId: 's', path: '/work/a.mp4', fileInfo: { size: delivery.size, modified: 100, name: 'a.mp4' } };
beforeEach(() => { vi.resetAllMocks(); rpc.direct.mockResolvedValue(false); rpc.machine.mockResolvedValue({ success: true, jobId: 'job', state: 'ready', delivery }); });
afterEach(() => { clearManagedDownloads(); sessionResources.releaseAll(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('Cloudflare browser delivery', () => {
    it('uses small previews only for same-server stored uploads and leaves original addresses intact', () => {
        const uri = 'http://hapla.test/files/public/users/owner/chat-images/image.png?delivery=1';
        expect(storedImagePreviewUrl(uri)).toBe('http://hapla.test/files/public/users/owner/chat-images/image.png?preview=image');
        expect(storedImagePreviewUrl('/files/public/users/owner/chat-images/image.png')).toContain('?preview=image');
        for (const url of ['/files/direct/' + delivery.id, '/files/public/users/owner/image.svg', '/files/public/users/owner/file.html', 'https://foreign.test/files/public/users/owner/image.png', delivery.url, 'data:image/png;base64,AAAA']) {
            expect(storedImagePreviewUrl(url)).toBeNull();
        }
        expect(uri).toContain('?delivery=1');
    });
    it('recovers an interrupted status poll without starting another upload task', async () => {
        vi.useFakeTimers();
        rpc.machine.mockImplementationOnce(async () => ({ success: true, jobId: 'same-job', state: 'preparing', stage: 'uploading-r2', progress: .775 }))
            .mockRejectedValueOnce(new Error('RPC target disconnected'))
            .mockResolvedValue({ success: true, jobId: 'same-job', state: 'ready', delivery });
        const pending = acquireCloudWorkspaceFile(options);
        await vi.advanceTimersByTimeAsync(2000);
        const source = await pending;
        expect(rpc.machine.mock.calls.filter(c => c[1] === 'file-cloud-prepare')).toHaveLength(1);
        const checks = rpc.machine.mock.calls.filter(c => c[1] === 'file-cloud-status');
        expect(checks).toHaveLength(2); expect(checks.every(c => c[2].jobId === 'same-job')).toBe(true);
        source.release();
    });
    it('retries temporary download-address failures and preserves cancellation', async () => {
        vi.useFakeTimers();
        rpc.request.mockRejectedValueOnce(new TypeError('Load failed'))
            .mockResolvedValueOnce(Response.json({ message: 'temporary' }, { status: 502 }))
            .mockResolvedValueOnce(Response.json({ url: delivery.url, expiresAt: delivery.expiresAt }));
        const pending = acquireCloudFileLink(delivery.url);
        await vi.advanceTimersByTimeAsync(2000);
        (await pending)?.release(); expect(rpc.request).toHaveBeenCalledTimes(3);
        rpc.request.mockReset().mockRejectedValue(new TypeError('Load failed'));
        const abort = new AbortController();
        const cancelled = acquireCloudFileLink(delivery.url, { signal: abort.signal });
        const assertion = expect(cancelled).rejects.toMatchObject({ name: 'AbortError' });
        await vi.advanceTimersByTimeAsync(100); abort.abort(); await assertion;
        await vi.advanceTimersByTimeAsync(5000); expect(rpc.request).toHaveBeenCalledTimes(1);
    });
    it('does not replay a rejected account request or wait forever on repeated proxy failures', async () => {
        rpc.request.mockResolvedValue(Response.json({ message: '请重新登录' }, { status: 401 }));
        await expect(acquireCloudFileLink(delivery.url)).rejects.toThrow('请重新登录');
        expect(rpc.request).toHaveBeenCalledTimes(1);
        vi.useFakeTimers(); rpc.request.mockReset().mockImplementation(async () => Response.json({ message: '文件服务不可用' }, { status: 503 }));
        const pending = expect(acquireCloudFileLink(delivery.url)).rejects.toThrow('文件服务不可用');
        await vi.advanceTimersByTimeAsync(2000); await pending;
        expect(rpc.request).toHaveBeenCalledTimes(3);
    });
    it('uses direct RPCs and authenticated same-origin ranges on LAN, including old R2 URLs', async () => {
        rpc.direct.mockResolvedValue(true);
        const local = { ...delivery, url: '/files/direct/' + delivery.id, downloadUrl: '/files/direct/' + delivery.id + '?download=1' };
        rpc.machine.mockResolvedValue({ success: true, jobId: 'job', state: 'ready', delivery: local });
        const source = await acquireCloudWorkspaceFile({ ...options, download: true });
        expect(rpc.machine.mock.calls.map(c => c[1])).toEqual(['file-direct-prepare', 'file-direct-release']);
        expect(rpc.request).not.toHaveBeenCalled(); expect(source.downloadUrl).toBe('http://hapla.test' + local.downloadUrl);
        const fetcher = vi.fn().mockResolvedValue(new Response(new Uint8Array([42]), { status: 206, headers: { 'Content-Range': `bytes 0-0/${delivery.size}` } })); vi.stubGlobal('fetch', fetcher);
        expect([...await readCloudFileRange(source, 0, 1, source.signal)]).toEqual([42]);
        expect(fetcher).toHaveBeenCalledWith(source.url, expect.objectContaining({ credentials: 'include' })); source.release();
        rpc.request.mockResolvedValue(Response.json(local)); const old = delivery.url + '&expired=1';
        const restored = await acquireCloudFileLink(old, { attachmentName: 'a.mp4' });
        expect(rpc.request).toHaveBeenCalledWith('/v1/files/direct/resolve', expect.objectContaining({ body: JSON.stringify({ url: old, downloadFilename: 'a.mp4' }) }));
        expect(restored?.url).toBe('http://hapla.test' + local.url); restored?.release();
    });
    it('rejects a foreign direct endpoint without falling back to R2', async () => {
        rpc.direct.mockResolvedValue(true); rpc.machine.mockResolvedValue({ success: true, jobId: 'job', state: 'ready', delivery });
        await expect(acquireCloudWorkspaceFile(options)).rejects.toThrow(/本地文件地址/); expect(rpc.request).not.toHaveBeenCalled();
    });
    it('requires a signed attachment URL for workspace and external downloads without changing preview URLs', async () => {
        const url = delivery.url + '&response-content-disposition=attachment%3B%20filename%3Dvideo.mp4&response-content-type=application%2Foctet-stream';
        rpc.request.mockResolvedValue(Response.json({ url, expiresAt: delivery.expiresAt }));
        const download = await acquireCloudWorkspaceFile({ ...options, download: true, attachmentName: '猫咪.mp4' });
        expect(download.downloadUrl).toBe(url);
        expect(JSON.parse(rpc.request.mock.calls[0][1].body)).toEqual({ url: delivery.url, force: true, downloadFilename: '猫咪.mp4' });
        download.release();
        const preview = await acquireCloudWorkspaceFile(options); expect(preview.url).toBe(delivery.url); preview.release();
        rpc.request.mockResolvedValue(Response.json({ url: delivery.url, expiresAt: delivery.expiresAt }));
        await expect(acquireCloudFileLink(delivery.url, { attachmentName: '猫咪.mp4' })).rejects.toThrow(/可保存/);
    });
    it('forces NAS restoration on an explicit retry even when the CLI still has a ready URL', async () => {
        const fresh = { url: delivery.url + '&fresh=1', expiresAt: Date.now() + 3_600_000 };
        rpc.request.mockResolvedValue(Response.json(fresh));
        const source = await acquireCloudWorkspaceFile({ ...options, forceRestore: true });
        expect(source.url).toBe(fresh.url); expect(source.size).toBe(delivery.size);
        expect(rpc.request).toHaveBeenCalledWith('/v1/files/cloud/resolve', expect.objectContaining({ body: JSON.stringify({ url: delivery.url, force: true }) }));
        sessionResources.release('s'); expect(source.signal.aborted).toBe(true);
    });
    it('replaces a registered expired URL before playback and never fetches the old original', async () => {
        const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
        rpc.request.mockResolvedValue(Response.json({ url: delivery.url, expiresAt: delivery.expiresAt }));
        const old = 'https://bucket.r2.cloudflarestorage.com/a?expired-signature';
        const source = await acquireCloudFileLink(old);
        expect(source?.url).toBe(delivery.url);
        expect(rpc.request).toHaveBeenCalledWith('/v1/files/cloud/resolve', expect.objectContaining({ method: 'POST', body: JSON.stringify({ url: old }) }));
        expect(fetcher).not.toHaveBeenCalled(); source?.release();
        rpc.request.mockResolvedValue(new Response('', { status: 404 }));
        await expect(acquireCloudFileLink(old)).rejects.toThrow(/NAS 原文件/);
        rpc.request.mockResolvedValue(new Response('', { status: 401 }));
        await expect(acquireCloudFileLink(old)).rejects.toThrow();
    });
    it('checks an already preparing file promptly, then backs off without overlapping polls', async () => {
        vi.useFakeTimers(); const started = Date.now(); const times: number[] = [];
        rpc.machine.mockImplementation(async (_machine, method) => {
            if (method === 'file-cloud-status') times.push(Date.now() - started);
            return times.length < 4 ? { success: true, jobId: 'job', state: 'preparing' } : { success: true, jobId: 'job', state: 'ready', delivery };
        });
        const promise = acquireCloudWorkspaceFile(options);
        await vi.advanceTimersByTimeAsync(3250);
        const source = await promise;
        expect(times).toEqual([250, 750, 1750, 3250]); source.release();
    });
    it('does not return a late resolved link after an account is cleared', async () => {
        let resolve!: (value: Response) => void;
        rpc.request.mockImplementation(() => new Promise(done => { resolve = done; }));
        const promise = acquireCloudFileLink(delivery.url);
        await vi.waitFor(() => expect(resolve).toBeTypeOf('function'));
        clearManagedDownloads(); resolve(Response.json(delivery));
        await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
    });
    it('uses the owning daemon and exchanges only task metadata', async () => {
        const source = await acquireCloudWorkspaceFile(options);
        expect(source.url).toBe(delivery.url);
        expect(rpc.machine).toHaveBeenCalledWith('machine-one', 'file-cloud-prepare', expect.objectContaining({ sessionId: 's', workspaceRoot: '/work', size: delivery.size }), 20_000);
        expect(rpc.machine.mock.calls.map(c => c[1])).toEqual(['file-cloud-prepare', 'file-cloud-release']);
        expect(rpc.session).not.toHaveBeenCalled(); source.release();
    });
    it('retains a queued download across session unload and cancels on account clear', async () => {
        const source = await acquireCloudWorkspaceFile({ ...options, download: true });
        sessionResources.release('s'); expect(source.signal.aborted).toBe(false);
        clearManagedDownloads(); expect(source.signal.aborted).toBe(true);
    });
    it('releases a late prepare response after immediate cancellation', async () => {
        let resolve!: (value: unknown) => void;
        rpc.machine.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
        const abort = new AbortController(); const promise = acquireCloudWorkspaceFile({ ...options, signal: abort.signal });
        await vi.waitFor(() => expect(resolve).toBeTypeOf('function'));
        abort.abort(); await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
        resolve({ success: true, jobId: 'late', state: 'preparing' });
        await vi.waitFor(() => expect(rpc.machine).toHaveBeenCalledWith('machine-one', 'file-cloud-release', expect.objectContaining({ jobId: 'late' }), 20_000));
    });
    it('falls back only when the daemon lacks the method, never for ambiguous timeouts', async () => {
        rpc.machine.mockRejectedValueOnce(new Error('RPC method not available'));
        rpc.session.mockResolvedValue({ success: true, jobId: 'job', state: 'ready', delivery });
        (await acquireCloudWorkspaceFile(options)).release(); expect(rpc.session).toHaveBeenCalled();
        rpc.session.mockClear(); rpc.machine.mockRejectedValueOnce(new Error('timed out'));
        await expect(acquireCloudWorkspaceFile(options)).rejects.toThrow('timed out'); expect(rpc.session).not.toHaveBeenCalled();
    });
    it('rejects foreign workspaces, unsigned endpoints, expired or wrong revisions', async () => {
        await expect(acquireCloudWorkspaceFile({ ...options, path: '/other/a.mp4' })).rejects.toThrow(/工作区/);
        expect(() => validateCloudDelivery({ ...delivery, url: 'https://evil.test/a' })).toThrow();
        expect(() => validateCloudDelivery({ ...delivery, expiresAt: 0 })).toThrow();
        expect(() => validateCloudDelivery(delivery, delivery.size + 1)).toThrow();
        expect(storedCloudPath('http://evil.test/files/a')).toBeNull();
        expect(storedCloudPath('/files/a.mp4')).toBe('/files/a.mp4');
    });
    it('reads only the requested bounded Range from Cloudflare and rejects full-file responses', async () => {
        const source = await acquireCloudWorkspaceFile(options);
        const fetcher = vi.fn().mockResolvedValue(new Response(new Uint8Array([1, 2, 3]), { status: 206, headers: { 'Content-Range': `bytes 10-12/${delivery.size}` } })); vi.stubGlobal('fetch', fetcher);
        expect([...await readCloudFileRange(source, 10, 3, source.signal)]).toEqual([1, 2, 3]);
        expect(fetcher).toHaveBeenCalledWith(delivery.url, expect.objectContaining({ credentials: 'omit', headers: { Range: 'bytes=10-12' } }));
        fetcher.mockResolvedValue(new Response('full file')); await expect(readCloudFileRange(source, 10, 3, source.signal)).rejects.toThrow(/分段/);
        source.release();
    });
    it('checks stored file metadata without downloading the small original', async () => {
        rpc.request.mockResolvedValue(Response.json({ size: 1024 * 1024, required: false }));
        expect(await acquireStoredCloudFile('/files/exact.bin')).toBeNull();
        expect(rpc.request).toHaveBeenCalledWith('/files/exact.bin?delivery=1&retry=1', expect.objectContaining({ cache: 'no-store' }));
    });
    it('renews an active player and preserves playback position', async () => {
        vi.useFakeTimers();
        const source = await acquireCloudWorkspaceFile(options);
        const media = Object.assign(new EventTarget(), { currentTime: 42, paused: false, playbackRate: 1.5, src: source.url, load: vi.fn(), play: vi.fn(async () => {}) });
        source.attach(media as unknown as HTMLMediaElement);
        rpc.request.mockImplementation(async () => Response.json({ ...delivery, expiresAt: Date.now() + 3_600_000, url: delivery.url + '&renewed=1' }));
        await vi.advanceTimersByTimeAsync(3_510_000);
        expect(media.src).toContain('renewed'); media.dispatchEvent(new Event('loadedmetadata')); expect(media.currentTime).toBe(42); expect(media.play).toHaveBeenCalled();
        source.release(); const count = rpc.request.mock.calls.length; await vi.advanceTimersByTimeAsync(3_600_000); expect(rpc.request).toHaveBeenCalledTimes(count);
    });
});
