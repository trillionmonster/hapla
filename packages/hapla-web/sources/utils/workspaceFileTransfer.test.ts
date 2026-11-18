import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fixtures = vi.hoisted(() => ({ cloud: vi.fn(), info: vi.fn(), chunk: vi.fn(), stream: vi.fn(), openStore: vi.fn(), append: vi.fn(), close: vi.fn() }));
vi.mock('./cloudFileDelivery', () => ({ acquireCloudWorkspaceFile: fixtures.cloud, CLOUD_FILE_THRESHOLD_BYTES: 1024 * 1024, cloudStageLabel: () => '准备文件' }));
vi.mock('@/sync/ops', () => ({
    sessionFileDownloadInfo: fixtures.info, machineFileDownloadInfo: fixtures.info,
    sessionFileDownloadChunk: fixtures.chunk, machineFileDownloadChunk: fixtures.chunk,
}));
vi.mock('./workspaceStream', () => ({ createWorkspaceStream: fixtures.stream }));
vi.mock('./workspacePreviewStore', () => ({ openWorkspacePreviewStore: fixtures.openStore }));
import { base64ToBytes, bytesToBase64, downloadWorkspaceFile, fetchWorkspaceFile, formatFileSize } from './workspaceFileTransfer';
import { clearManagedDownloads, getDownloadJobs } from './downloadManager';

const largeSize = 32 * 1024 * 1024 + 17;
const deferred = <T,>() => {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(done => { resolve = done; });
    return { promise, resolve };
};
type Element = { tag: string; href: string; download: string; rel: string; src: string; hidden: boolean; style: { display: string }; click: ReturnType<typeof vi.fn>; remove: ReturnType<typeof vi.fn> };
let elements: Element[];
let release: ReturnType<typeof vi.fn>;

beforeEach(() => {
    vi.useFakeTimers();
    fixtures.info.mockReset().mockResolvedValue({ success: true, size: largeSize, name: 'movie.mp4', modified: 1234, chunkSize: 256 * 1024 });
    fixtures.chunk.mockReset();
    fixtures.append.mockReset().mockImplementation(async (blob: Blob) => blob);
    fixtures.close.mockReset();
    fixtures.openStore.mockReset().mockResolvedValue({ append: fixtures.append, close: fixtures.close });
    release = vi.fn();
    fixtures.stream.mockReset().mockResolvedValue({ url: 'blob:large-download', name: 'movie.mp4', size: largeSize, done: Promise.resolve(), release });
    fixtures.cloud.mockReset().mockResolvedValue({ url: 'https://bucket.r2.cloudflarestorage.com/preview', downloadUrl: 'https://bucket.r2.cloudflarestorage.com/download', name: 'movie.mp4', size: largeSize, release });
    elements = [];
    vi.stubGlobal('document', {
        createElement: vi.fn((tag: string) => {
            const element = { tag, href: '', download: '', rel: '', src: '', hidden: false, style: { display: '' }, click: vi.fn(), remove: vi.fn() };
            elements.push(element);
            return element;
        }),
        body: { appendChild: vi.fn() },
    });
    vi.stubGlobal('window', { setTimeout });
});
afterEach(() => {
    clearManagedDownloads();
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

describe('workspaceFileTransfer', () => {
    it('round trips binary chunks without argument-spread overflow', () => {
        const source = new Uint8Array(512 * 1024);
        source.forEach((_, index) => { source[index] = index % 251; });
        expect(base64ToBytes(bytesToBase64(source))).toEqual(source);
    });

    it('formats file sizes for compact transfer UI', () => {
        expect(formatFileSize(0)).toBe('0 B');
        expect(formatFileSize(1536)).toBe('1.5 KiB');
        expect(formatFileSize(12 * 1024 * 1024)).toBe('12 MiB');
    });

    it('hands a large file directly to the browser without a Blob or iframe', async () => {
        await downloadWorkspaceFile({ sessionId: 'session-1', path: '/workspace/movie.mp4' });
        expect(elements.map(e => e.tag)).toEqual(['a']);
        expect(elements[0].href).toBe('https://bucket.r2.cloudflarestorage.com/download');
        expect(elements[0].click).toHaveBeenCalledOnce(); expect(release).toHaveBeenCalledOnce();
        expect(fixtures.chunk).not.toHaveBeenCalled(); expect(fixtures.stream).not.toHaveBeenCalled(); expect(fixtures.openStore).not.toHaveBeenCalled();
    });

    it('releases a staged download immediately when the browser cannot start it', async () => {
        vi.mocked(document.createElement).mockImplementation(((tag: string) => {
            const element = { tag, href: '', download: '', rel: '', src: '', hidden: false, style: { display: '' }, click: vi.fn(() => { throw new Error('Download blocked'); }), remove: vi.fn() };
            elements.push(element);
            return element;
        }) as unknown as typeof document.createElement);
        await expect(downloadWorkspaceFile({ sessionId: 'session-1', path: '/workspace/movie.mp4' })).rejects.toThrow('Download blocked');
        expect(release).toHaveBeenCalledTimes(1);
        expect(elements[0].remove).toHaveBeenCalledTimes(1);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('refuses direct large Blob staging and reports cloud failures without fallback', async () => {
        await expect(fetchWorkspaceFile({ machineId: 'machine-1', path: '/workspace/movie.mp4' })).rejects.toThrow('Cloudflare');
        fixtures.cloud.mockRejectedValueOnce(new Error('cache busy'));
        await expect(downloadWorkspaceFile({ machineId: 'machine-1', path: '/workspace/movie.mp4' })).rejects.toThrow('cache busy');
        expect(fixtures.chunk).not.toHaveBeenCalled(); expect(elements).toHaveLength(0);
    });
    it('immediately revokes a small completed Blob on account clearing rather than retaining it for its timer', async () => {
        fixtures.info.mockResolvedValue({ success: true, size: 4, name: 'file.bin', modified: 1234, chunkSize: 4 });
        fixtures.chunk.mockResolvedValue({ success: true, bytesRead: 4, content: 'AQIDBA==' });
        const create = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:small-download');
        const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
        await downloadWorkspaceFile({ sessionId: 'small-session', path: '/workspace/file.bin' });
        await Promise.resolve(); await Promise.resolve();
        expect(getDownloadJobs()[0].state).toBe('handed-off'); expect(create).toHaveBeenCalledTimes(1);
        expect(revoke).not.toHaveBeenCalled();
        clearManagedDownloads();
        expect(revoke).toHaveBeenCalledExactlyOnceWith('blob:small-download');
        await vi.advanceTimersByTimeAsync(60_000); expect(revoke).toHaveBeenCalledTimes(1);
    });
});
