import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sessionResources } from '@/sync/sessionResources';
import { clearManagedDownloads } from './downloadManager';

const rpc = vi.hoisted(() => ({ info: vi.fn(), chunk: vi.fn() }));
const cloud = vi.hoisted(() => ({ acquire: vi.fn() }));
vi.mock('./cloudFileDelivery', () => ({ acquireCloudWorkspaceFile: cloud.acquire, CLOUD_FILE_THRESHOLD_BYTES: 1024 * 1024 }));
const temporary = vi.hoisted(() => ({ open: vi.fn(), append: vi.fn(), close: vi.fn() }));
vi.mock('@/sync/ops', () => ({ sessionFileDownloadInfo: rpc.info, sessionFileDownloadChunk: rpc.chunk }));
vi.mock('./workspacePreviewStore', () => ({ openWorkspacePreviewStore: temporary.open }));
import { createWorkspaceStream, TEMPORARY_PREVIEW_THRESHOLD_BYTES, releaseSessionWorkspaceStreams } from './workspaceStream';

const sessionId = 'http-image-preview';
const bytes = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 255, 127]);
const info = { success: true, size: bytes.length, modified: 1234, name: 'image.png', chunkSize: 4 };
const largeSize = TEMPORARY_PREVIEW_THRESHOLD_BYTES + 19;
const chunkBytes = 256 * 1024;
const deferred = <T,>() => {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(done => { resolve = done; });
    return { promise, resolve };
};
const configureLargeFile = () => {
    rpc.info.mockResolvedValue({ ...info, size: largeSize, name: 'movie.mp4', chunkSize: 1024 * 1024 });
    rpc.chunk.mockImplementation(async (_session, _path, offset, length) => ({
        success: true, bytesRead: length, content: Buffer.alloc(length, (offset / chunkBytes) % 251).toString('base64'),
    }));
};
let blobs: Blob[];
let revoke: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
    vi.stubGlobal('isSecureContext', false);
    vi.stubGlobal('navigator', {});
    rpc.info.mockReset().mockResolvedValue(info);
    rpc.chunk.mockReset().mockImplementation(async (_session, _path, offset, length) => ({
        success: true, bytesRead: length, content: Buffer.from(bytes.slice(offset, offset + length)).toString('base64'),
    }));
    temporary.append.mockReset().mockImplementation(async (blob: Blob) => blob);
    temporary.close.mockReset();
    temporary.open.mockReset().mockResolvedValue({ append: temporary.append, close: temporary.close });
    blobs = [];
    vi.spyOn(URL, 'createObjectURL').mockImplementation((blob) => { blobs.push(blob as Blob); return `blob:test-${blobs.length}`; });
    revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
});
afterEach(() => {
    clearManagedDownloads();
    releaseSessionWorkspaceStreams(sessionId);
    sessionResources.release(sessionId);
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

describe('workspace previews through HTTP and proxy entry points', () => {
    it('keeps an HTTP download alive across session unload and releases it on account clearing', async () => {
        const pending = deferred<{ success: true; bytesRead: number; content: string }>();
        rpc.chunk.mockReturnValueOnce(pending.promise);
        const operation = createWorkspaceStream({ sessionId, path: '/workspace/download.png', download: true });
        await vi.waitFor(() => expect(rpc.chunk).toHaveBeenCalledTimes(1));
        sessionResources.release(sessionId); releaseSessionWorkspaceStreams(sessionId);
        pending.resolve({ success: true, bytesRead: 4, content: Buffer.from(bytes.slice(0, 4)).toString('base64') });
        const stream = await operation;
        expect(new Uint8Array(await blobs[0].arrayBuffer())).toEqual(bytes);
        expect(revoke).not.toHaveBeenCalled();
        sessionResources.release(sessionId); releaseSessionWorkspaceStreams(sessionId);
        expect(revoke).not.toHaveBeenCalled();
        clearManagedDownloads(); expect(revoke).toHaveBeenCalledExactlyOnceWith(stream.url);
    });
    it('reconstructs exact PNG bytes with MIME without a service worker or secure context', async () => {
        const preview = await createWorkspaceStream({ sessionId, path: '/workspace/image.png' });
        expect(preview.url).toMatch(/^blob:/);
        expect(blobs[0].type).toBe('image/png');
        expect(new Uint8Array(await blobs[0].arrayBuffer())).toEqual(bytes);
        expect(rpc.chunk.mock.calls.map((args) => args.slice(2))).toEqual([[0, 4, 1234], [4, 4, 1234], [8, 3, 1234]]);
        preview.release(); preview.release();
        expect(revoke).toHaveBeenCalledTimes(1);
        expect(sessionResources.getStats().resources).toBe(0);
    });

    it('also uses the small-file path when a secure browser cannot register a worker', async () => {
        const register = vi.fn().mockRejectedValue(new Error('worker blocked'));
        vi.stubGlobal('isSecureContext', true);
        vi.stubGlobal('navigator', { serviceWorker: { register } });
        await createWorkspaceStream({ sessionId, path: '/workspace/report.pdf' });
        expect(register).not.toHaveBeenCalled();
        expect(blobs[0].type).toBe('application/pdf');
    });

    it('streams even small opened videos on HTTPS without fetching their original into a Blob', async () => {
        const register = vi.fn().mockResolvedValue({});
        vi.stubGlobal('isSecureContext', true);
        vi.stubGlobal('navigator', { serviceWorker: { register, ready: Promise.resolve(), controller: {}, addEventListener: vi.fn() } });
        const preview = await createWorkspaceStream({ sessionId, path: '/workspace/movie.mp4', preferStreaming: true });
        expect(preview.url).toMatch(/^\/__hapla_workspace_stream\//);
        expect(register).toHaveBeenCalledTimes(1);
        expect(rpc.chunk).not.toHaveBeenCalled();
        expect(blobs).toHaveLength(0);
        preview.release();
    });

    it('rejects a revision changed between cache lookup and stream creation before reading original bytes', async () => {
        await expect(createWorkspaceStream({ sessionId, path: '/workspace/movie.mp4', expectedFile: { modified: 1233, size: bytes.length } })).rejects.toThrow('视频在读取期间发生变化');
        expect(rpc.chunk).not.toHaveBeenCalled();
        expect(blobs).toHaveLength(0);
    });
    it('keeps a secure download grant after session unload but releases it on account clearing', async () => {
        vi.stubGlobal('isSecureContext', true);
        vi.stubGlobal('navigator', { serviceWorker: { register: vi.fn().mockResolvedValue({}), ready: Promise.resolve(), controller: {}, addEventListener: vi.fn() } });
        const stream = await createWorkspaceStream({ sessionId, path: '/workspace/download.png', download: true });
        let completed = false; void stream.done.then(() => { completed = true; });
        sessionResources.release(sessionId); releaseSessionWorkspaceStreams(sessionId); await Promise.resolve();
        expect(completed).toBe(false);
        clearManagedDownloads(); await stream.done; expect(completed).toBe(true);
        expect(rpc.chunk).not.toHaveBeenCalled();
    });

    it('reuses video-open metadata without a duplicate RPC while checking revision on every byte range', async () => {
        const preview = await createWorkspaceStream({ sessionId, path: '/workspace/movie.mp4', fileInfo: { ...info, success: true }, expectedFile: { modified: info.modified, size: info.size } });
        expect(rpc.info).not.toHaveBeenCalled();
        expect(rpc.chunk.mock.calls.map(args => args.slice(2))).toEqual([[0, 4, 1234], [4, 4, 1234], [8, 3, 1234]]);
        expect(new Uint8Array(await blobs[0].arrayBuffer())).toEqual(bytes);
        preview.release();
    });

    it('revokes previews on either abort, explicit session stream release or resource unload', async () => {
        const abort = new AbortController();
        const first = await createWorkspaceStream({ sessionId, path: '/workspace/a.png', signal: abort.signal });
        abort.abort();
        expect(revoke).toHaveBeenCalledWith(first.url);
        const second = await createWorkspaceStream({ sessionId, path: '/workspace/b.png' });
        releaseSessionWorkspaceStreams(sessionId);
        expect(revoke).toHaveBeenCalledWith(second.url);
        const third = await createWorkspaceStream({ sessionId, path: '/workspace/c.png' });
        sessionResources.release(sessionId);
        expect(revoke).toHaveBeenCalledWith(third.url);
        expect(revoke).toHaveBeenCalledTimes(3);
    });

    it.each(['abort', 'unload'])('does not publish a Blob when %s occurs during a chunk read', async (method) => {
        const abort = new AbortController();
        rpc.chunk.mockImplementationOnce(async () => {
            if (method === 'abort') abort.abort(); else sessionResources.release(sessionId);
            return { success: true, bytesRead: 4, content: Buffer.from(bytes.slice(0, 4)).toString('base64') };
        });
        await expect(createWorkspaceStream({ sessionId, path: '/workspace/a.png', signal: abort.signal })).rejects.toMatchObject({ name: 'AbortError' });
        expect(blobs).toHaveLength(0);
        expect(rpc.chunk).toHaveBeenCalledTimes(1);
    });

    it('checks cancellation before making a request', async () => {
        const abort = new AbortController(); abort.abort();
        await expect(createWorkspaceStream({ sessionId, path: '/workspace/a.png', signal: abort.signal })).rejects.toMatchObject({ name: 'AbortError' });
        expect(rpc.info).not.toHaveBeenCalled();
    });

    it.each([
        { success: true, content: '', bytesRead: 0 },
        { success: true, content: 'AA==', bytesRead: 4 },
        { success: true, content: 'AAAAAAA=', bytesRead: 5 },
    ])('rejects incomplete or oversized chunks before displaying corrupt content', async (chunk) => {
        rpc.chunk.mockResolvedValueOnce(chunk);
        await expect(createWorkspaceStream({ sessionId, path: '/workspace/a.png' })).rejects.toThrow('文件分段内容不完整');
        expect(blobs).toHaveLength(0);
        expect(rpc.chunk).toHaveBeenCalledTimes(1);
    });

    it('propagates a file revision change without mixing versions or leaking a Blob', async () => {
        rpc.chunk.mockResolvedValueOnce({ success: false, error: 'File changed during transfer' });
        await expect(createWorkspaceStream({ sessionId, path: '/workspace/a.png' })).rejects.toThrow('File changed');
        expect(blobs).toHaveLength(0);
    });

    it.each([false, true])('delivers large files from R2 regardless of secure context (%s)', async secure => {
        configureLargeFile(); vi.stubGlobal('isSecureContext', secure);
        const release = vi.fn();
        cloud.acquire.mockResolvedValue({ url: 'https://bucket.r2.cloudflarestorage.com/original', downloadUrl: 'https://bucket.r2.cloudflarestorage.com/download', size: largeSize, name: 'movie.mp4', release });
        const preview = await createWorkspaceStream({ sessionId, path: '/workspace/movie.mp4' });
        expect(preview.url).toContain('.r2.cloudflarestorage.com/');
        expect(rpc.chunk).not.toHaveBeenCalled(); expect(temporary.open).not.toHaveBeenCalled(); expect(blobs).toHaveLength(0);
        preview.release(); expect(release).toHaveBeenCalledOnce();
    });
    it('never falls back to original RPC chunks when Cloudflare is unavailable', async () => {
        configureLargeFile(); cloud.acquire.mockRejectedValue(new Error('cache unavailable'));
        await expect(createWorkspaceStream({ sessionId, path: '/workspace/movie.mp4' })).rejects.toThrow('cache unavailable');
        expect(rpc.chunk).not.toHaveBeenCalled(); expect(temporary.open).not.toHaveBeenCalled(); expect(blobs).toHaveLength(0);
    });
});
