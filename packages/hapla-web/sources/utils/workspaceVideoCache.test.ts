import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sessionResources } from '@/sync/sessionResources';
import { MAX_CACHED_VIDEO_BYTES, videoEvictionKeys, type CachedWorkspaceVideo } from './workspaceVideoStore';

const mocks = vi.hoisted(() => ({ cloud: vi.fn(), info: vi.fn(), stream: vi.fn(), read: vi.fn(), store: vi.fn(), remove: vi.fn(), mseSupport: vi.fn(), mse: vi.fn() }));
vi.mock('./cloudFileDelivery', () => ({ acquireCloudWorkspaceFile: mocks.cloud, CLOUD_FILE_THRESHOLD_BYTES: 1024 * 1024 }));
vi.mock('@/sync/ops', () => ({ sessionFileDownloadInfo: mocks.info }));
vi.mock('./workspaceStream', () => ({ createWorkspaceStream: mocks.stream }));
vi.mock('./workspaceVideoMse', () => ({ canUseWorkspaceVideoMse: mocks.mseSupport, createWorkspaceVideoMse: mocks.mse }));
vi.mock('./workspaceVideoStore', async (original) => ({
    ...await original<typeof import('./workspaceVideoStore')>(),
    readCachedWorkspaceVideo: mocks.read, storeWorkspaceVideo: mocks.store, deleteCachedWorkspaceVideos: mocks.remove,
}));
import { acquireWorkspaceVideo, clearWorkspaceVideoPersistence, releaseWorkspaceVideoMemory } from './workspaceVideoCache';

const rows = new Map<string, CachedWorkspaceVideo>();
const page = new EventTarget();
const broadcast = { onmessage: null as null | ((event: { data: unknown }) => void), postMessage: vi.fn() };
let sourceReleases: ReturnType<typeof vi.fn>[] = [];
let sequence = 0;
const options = (path = '/workspace/a.mp4') => ({ sessionId: 'video-session', path });
const defer = <T,>() => {
    let resolve!: (result: T) => void;
    const promise = new Promise<T>(done => { resolve = done; });
    return { promise, resolve };
};

beforeEach(() => {
    vi.clearAllMocks(); rows.clear(); sourceReleases = []; sequence = 0;
    vi.stubGlobal('window', page);
    vi.stubGlobal('localStorage', { setItem: vi.fn(), removeItem: vi.fn() });
    vi.stubGlobal('BroadcastChannel', class { constructor() { return broadcast; } });
    mocks.info.mockReset().mockResolvedValue({ success: true, size: 4, modified: 10, name: 'a.mp4', chunkSize: 4 });
    mocks.mseSupport.mockReset().mockReturnValue(false); mocks.mse.mockReset();
    mocks.read.mockReset().mockImplementation(async (key, modified, size) => {
        const value = rows.get(key);
        if (!value || value.modified !== modified || value.size !== size) { rows.delete(key); return null; }
        value.lastOpened = ++sequence; return value;
    });
    mocks.store.mockReset().mockImplementation(async record => {
        rows.set(record.key, { ...record, lastOpened: ++sequence });
        const keys = videoEvictionKeys([...rows.values()]);
        for (const key of keys) rows.delete(key);
        return keys;
    });
    mocks.remove.mockReset().mockImplementation(async sessionId => {
        const keys = [...rows].filter(([, row]) => !sessionId || row.sessionId === sessionId).map(([key]) => key);
        for (const key of keys) rows.delete(key);
        return keys;
    });
    mocks.stream.mockReset().mockImplementation(async () => {
        const url = `blob:rpc-${sourceReleases.length + 1}`;
        const release = vi.fn(() => URL.revokeObjectURL(url)); sourceReleases.push(release);
        return { url, blob: new Blob(['1234']), name: 'a.mp4', size: 4, release };
    });
    vi.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:cached-${++sequence}`);
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
});
afterEach(() => { releaseWorkspaceVideoMemory(); sessionResources.releaseAll(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('opened workspace video resources', () => {
    it('reuses the file screen metadata while retaining remote revision validation', async () => {
        const info = { success: true as const, size: 1024 * 1024 + 1, modified: 10, name: 'a.mp4', chunkSize: 4 };
        mocks.cloud.mockResolvedValue({ url: 'https://bucket.r2.cloudflarestorage.com/video', release: vi.fn(), signal: new AbortController().signal });
        (await acquireWorkspaceVideo({ ...options(), fileInfo: info })).release();
        expect(mocks.info).not.toHaveBeenCalled();
        expect(mocks.cloud).toHaveBeenCalledWith(expect.objectContaining({ fileInfo: info }));
    });
    it('opens HTTP MP4 viewers with independent MediaSources and no whole-original download or persistent write', async () => {
        vi.stubGlobal('isSecureContext', false);
        mocks.mseSupport.mockReturnValue(true);
        const sources: Array<{ release: ReturnType<typeof vi.fn>; attach: ReturnType<typeof vi.fn> }> = [];
        mocks.mse.mockImplementation(async options => {
            const source = { release: vi.fn(), attach: vi.fn() }; sources.push(source);
            return { ...source, url: `blob:mse-${sources.length}`, size: options.fileInfo.size, name: options.fileInfo.name };
        });
        const first = await acquireWorkspaceVideo(options());
        const second = await acquireWorkspaceVideo(options());
        expect(first.attach).toBe(sources[0].attach); expect(second.attach).toBe(sources[1].attach);
        expect(first.url).not.toBe(second.url);
        expect(mocks.mse).toHaveBeenCalledTimes(2);
        expect(mocks.mse).toHaveBeenCalledWith(expect.objectContaining({ fileInfo: expect.objectContaining({ size: 4, modified: 10 }) }));
        expect(mocks.stream).not.toHaveBeenCalled(); expect(mocks.store).not.toHaveBeenCalled();
        first.release(); expect(sources[0].release).toHaveBeenCalledTimes(1); expect(sources[1].release).not.toHaveBeenCalled();
        sessionResources.release(options().sessionId);
        expect(sources[1].release).toHaveBeenCalledTimes(1); expect(second.signal.aborted).toBe(true);
    });

    it('bypasses old originals, MSE and IndexedDB for large videos', async () => {
        mocks.info.mockResolvedValue({ success: true, size: 1024 * 1024 + 1, modified: 10, name: 'a.mp4' });
        mocks.cloud.mockResolvedValue({ url: 'https://bucket.r2.cloudflarestorage.com/video', release: vi.fn(), signal: new AbortController().signal });
        (await acquireWorkspaceVideo(options())).release();
        expect(mocks.cloud).toHaveBeenCalledOnce(); expect(mocks.read).not.toHaveBeenCalled(); expect(mocks.store).not.toHaveBeenCalled(); expect(mocks.mse).not.toHaveBeenCalled();
    });

    it('does not read any original bytes or cache merely by importing the utility', () => {
        expect(mocks.stream).not.toHaveBeenCalled();
        expect(mocks.read).not.toHaveBeenCalled();
    });

    it('caches exact originals after open without replacing the playing source and releases staging on close', async () => {
        const lease = await acquireWorkspaceVideo(options());
        expect(mocks.stream).toHaveBeenCalledWith(expect.objectContaining({ preferStreaming: true, fileInfo: expect.objectContaining({ modified: 10, size: 4 }), expectedFile: { modified: 10, size: 4 } }));
        expect(await [...rows.values()][0].blob.text()).toBe('1234');
        expect(sourceReleases[0]).not.toHaveBeenCalled();
        expect(URL.revokeObjectURL).not.toHaveBeenCalled();
        lease.release(); lease.release();
        expect(sourceReleases[0]).toHaveBeenCalledTimes(1);
        expect(URL.revokeObjectURL).toHaveBeenCalledExactlyOnceWith(lease.url);
        const reopened = await acquireWorkspaceVideo(options());
        expect(mocks.stream).toHaveBeenCalledTimes(1);
        expect(reopened.url).not.toBe(lease.url);
        reopened.release();
    });

    it('returns a playable source while the optional cache commit is still pending', async () => {
        const pending = defer<string[]>();
        mocks.store.mockImplementationOnce(() => pending.promise);
        const lease = await acquireWorkspaceVideo(options());
        expect(lease.url).toBe('blob:rpc-1');
        expect(mocks.store).toHaveBeenCalledTimes(1);
        expect(mocks.read).toHaveBeenCalledTimes(1);
        expect(sourceReleases[0]).not.toHaveBeenCalled();
        pending.resolve([]);
        await Promise.resolve();
        expect(lease.url).toBe('blob:rpc-1');
        expect(mocks.read).toHaveBeenCalledTimes(1);
        lease.release();
        expect(sourceReleases[0]).toHaveBeenCalledTimes(1);
    });

    it('closing playback immediately aborts a pending cache write and releases its active original', async () => {
        let storageSignal!: AbortSignal;
        mocks.store.mockImplementationOnce((_record, signal: AbortSignal) => {
            storageSignal = signal;
            return new Promise((_, reject) => signal.addEventListener('abort', () => reject(new DOMException('Cancelled', 'AbortError')), { once: true }));
        });
        const lease = await acquireWorkspaceVideo(options());
        lease.release();
        expect(storageSignal.aborted).toBe(true);
        expect(sourceReleases[0]).toHaveBeenCalledTimes(1);
        expect(rows.size).toBe(0);
    });

    it('removes an original committed just before session unload even when the cache callback is still pending', async () => {
        const pending = defer<string[]>();
        let record!: CachedWorkspaceVideo;
        mocks.store.mockImplementationOnce(value => { record = { ...value, lastOpened: 1 }; return pending.promise; });
        const lease = await acquireWorkspaceVideo(options());
        rows.set(record.key, record);
        pending.resolve([]);
        sessionResources.release('video-session');
        await vi.waitFor(() => expect(rows.size).toBe(0));
        expect(lease.signal.aborted).toBe(true);
        expect(sourceReleases[0]).toHaveBeenCalledTimes(1);
        expect(sessionResources.getStats().resources).toBe(0);
    });

    it.each(['close', 'unload', 'account'])('settles immediately on %s while initial metadata RPC is stalled', async reason => {
        const pending = defer<unknown>();
        mocks.info.mockImplementationOnce(() => pending.promise);
        const controller = new AbortController();
        const operation = acquireWorkspaceVideo({ ...options(), signal: controller.signal });
        const rejection = expect(operation).rejects.toMatchObject({ name: 'AbortError' });
        if (reason === 'close') controller.abort();
        else if (reason === 'unload') sessionResources.release('video-session');
        else releaseWorkspaceVideoMemory();
        await rejection;
        expect(mocks.stream).not.toHaveBeenCalled();
        pending.resolve({ success: true, size: 4, modified: 10, name: 'a.mp4', chunkSize: 4 });
        await Promise.resolve();
        expect(mocks.stream).not.toHaveBeenCalled();
    });

    it('evicts the sixth least recently opened file, including its live decoder source', async () => {
        const leases = [];
        for (let index = 0; index < 5; index++) leases.push(await acquireWorkspaceVideo(options(`/workspace/${index}.mp4`)));
        // Reopening 0 promotes it ahead of 1 without a duplicate original.
        leases[0].release();
        const reopened = await acquireWorkspaceVideo(options('/workspace/0.mp4'));
        const sixth = await acquireWorkspaceVideo(options('/workspace/5.mp4'));
        expect(rows.size).toBe(5);
        expect(leases[1].signal.aborted).toBe(true);
        expect(URL.revokeObjectURL).toHaveBeenCalledWith(leases[1].url);
        expect(reopened.signal.aborted).toBe(false);
        expect(sixth.signal.aborted).toBe(false);
    });

    it('deduplicates concurrent viewers while keeping each lease independently releasable', async () => {
        const [first, second] = await Promise.all([acquireWorkspaceVideo(options()), acquireWorkspaceVideo(options())]);
        expect(mocks.stream).toHaveBeenCalledTimes(1);
        expect(first.url).toBe(second.url);
        first.release();
        expect(second.signal.aborted).toBe(false);
        second.release();
        expect(URL.revokeObjectURL).toHaveBeenCalledExactlyOnceWith(second.url);
    });

    it('promotes a video opened again while another viewer is still using it', async () => {
        const first = await acquireWorkspaceVideo(options('/workspace/0.mp4'));
        const old = await acquireWorkspaceVideo(options('/workspace/1.mp4'));
        for (let index = 2; index < 5; index++) (await acquireWorkspaceVideo(options(`/workspace/${index}.mp4`))).release();
        const reopened = await acquireWorkspaceVideo(options('/workspace/0.mp4'));
        await acquireWorkspaceVideo(options('/workspace/5.mp4'));
        expect(old.signal.aborted).toBe(true);
        expect(first.signal.aborted).toBe(false);
        expect(reopened.url).toBe(first.url);
    });

    it('immediately releases in another tab when its persisted entry is evicted', async () => {
        const lease = await acquireWorkspaceVideo(options());
        broadcast.onmessage!({ data: { keys: [JSON.stringify(['video-session', '/workspace/a.mp4'])] } });
        expect(lease.signal.aborted).toBe(true);
        expect(URL.revokeObjectURL).toHaveBeenCalledWith(lease.url);
    });

    it('invalidates previous original bytes after a file revision changes', async () => {
        (await acquireWorkspaceVideo(options())).release();
        mocks.info.mockResolvedValue({ success: true, modified: 20, size: 4, name: 'a.mp4' });
        (await acquireWorkspaceVideo(options())).release();
        expect(mocks.stream).toHaveBeenCalledTimes(2);
        expect([...rows.values()][0].modified).toBe(20);
    });

    it('serves oversized or streaming originals without retaining them in IndexedDB', async () => {
        mocks.stream.mockResolvedValueOnce({ url: 'blob:large', blob: new Blob(['1234']), size: MAX_CACHED_VIDEO_BYTES + 1, name: 'large.mp4', release: vi.fn() });
        const large = await acquireWorkspaceVideo(options('/workspace/large.mp4'));
        expect(mocks.store).not.toHaveBeenCalled();
        large.release();
        mocks.stream.mockResolvedValueOnce({ url: '/__hapla_workspace_stream/token/a.mp4', size: 4, name: 'a.mp4', release: vi.fn() });
        const stream = await acquireWorkspaceVideo(options());
        expect(mocks.store).not.toHaveBeenCalled();
        stream.release();
    });

    it('still works when browser storage is unavailable and releases all original bytes on close', async () => {
        mocks.read.mockRejectedValue(new Error('private mode'));
        mocks.store.mockRejectedValue(new Error('quota exceeded'));
        const lease = await acquireWorkspaceVideo(options());
        expect(lease.url).toBe('blob:rpc-1');
        expect(sourceReleases[0]).not.toHaveBeenCalled();
        lease.release();
        expect(sourceReleases[0]).toHaveBeenCalledTimes(1);
        expect(rows.size).toBe(0);
    });

    it('cancels immediately while a transport is stalled and releases its late result', async () => {
        const pending = defer<{ url: string; size: number; name: string; release: () => void }>();
        const started = defer<void>();
        mocks.stream.mockImplementationOnce(() => { started.resolve(); return pending.promise; });
        const abort = new AbortController();
        const operation = acquireWorkspaceVideo({ ...options(), signal: abort.signal });
        const rejection = expect(operation).rejects.toMatchObject({ name: 'AbortError' });
        await started.promise;
        abort.abort();
        await rejection;
        const release = vi.fn();
        pending.resolve({ url: 'blob:late', size: 4, name: 'a.mp4', release });
        await vi.waitFor(() => expect(release).toHaveBeenCalledTimes(1));
        expect(mocks.store).not.toHaveBeenCalled();
    });

    it('does not publish a previous-account result if the account changes during file info', async () => {
        const pending = defer<unknown>();
        mocks.info.mockImplementationOnce(() => pending.promise);
        const operation = acquireWorkspaceVideo(options());
        const rejection = expect(operation).rejects.toMatchObject({ name: 'AbortError' });
        releaseWorkspaceVideoMemory();
        pending.resolve({ success: true, size: 4, modified: 10, name: 'a.mp4' });
        await rejection;
        expect(mocks.stream).not.toHaveBeenCalled();
    });

    it('unloads a session including its retained originals', async () => {
        const lease = await acquireWorkspaceVideo(options());
        sessionResources.release('video-session');
        expect(lease.signal.aborted).toBe(true);
        await vi.waitFor(() => expect(rows.size).toBe(0));
    });

    it('releases page resources on pagehide while preserving the bounded recent list', async () => {
        const lease = await acquireWorkspaceVideo(options());
        page.dispatchEvent(new Event('pagehide'));
        expect(lease.signal.aborted).toBe(true);
        expect(rows.size).toBe(1);
    });

    it('waits for persisted original deletion before an account switch can complete', async () => {
        const lease = await acquireWorkspaceVideo(options());
        const pending = defer<string[]>();
        mocks.remove.mockImplementationOnce(() => pending.promise);
        let completed = false;
        const clearing = clearWorkspaceVideoPersistence().then(() => { completed = true; });
        expect(lease.signal.aborted).toBe(true);
        await Promise.resolve();
        expect(completed).toBe(false);
        pending.resolve([]);
        await clearing;
        expect(completed).toBe(true);
    });

    it('reports a retryable failure instead of allowing another account to inherit undeleted originals', async () => {
        mocks.remove.mockRejectedValueOnce(new Error('transaction aborted'));
        await expect(clearWorkspaceVideoPersistence()).rejects.toThrow('无法清除上一个账号的视频缓存');
    });
});

describe('global retained video limits', () => {
    it('keeps at most five newest opens', () => {
        expect(videoEvictionKeys(Array.from({ length: 8 }, (_, index) => ({ key: String(index), size: 1, lastOpened: index })))).toEqual(['2', '1', '0']);
    });
    it('limits aggregate originals, excludes oversize entries and never evicts a newer small file for an older large one', () => {
        expect(videoEvictionKeys([
            { key: 'latest', size: 4, lastOpened: 4 },
            { key: 'too-large', size: MAX_CACHED_VIDEO_BYTES + 1, lastOpened: 3 },
            { key: 'old-large', size: MAX_CACHED_VIDEO_BYTES, lastOpened: 2 },
            { key: 'small', size: 4, lastOpened: 1 },
        ])).toEqual(['too-large', 'old-large']);
    });
});
