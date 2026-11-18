import { afterEach, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';

const rpc = vi.hoisted(() => ({ chunk: vi.fn() }));
vi.mock('@/sync/ops', () => ({ sessionFileDownloadChunk: rpc.chunk }));
vi.mock('mp4box', async () => {
    const actual = await vi.importActual<typeof import('mp4box')>('mp4box');
    return { ...actual, createFile: (...args: Parameters<typeof actual.createFile>) => {
        const parser = actual.createFile(...args);
        const createFragment = parser.createFragment.bind(parser);
        parser.createFragment = (...fragmentArgs) => {
            const fragment = createFragment(...fragmentArgs);
            if (!fragment) return fragment;
            // Valid trailing MP4 padding represents expensive native buffers
            // without committing a multi-megabyte binary test fixture.
            const bytes = new Uint8Array(fragment.buffer);
            const padded = new Uint8Array(bytes.length + 2 * 1024 * 1024);
            padded.set(bytes);
            new DataView(padded.buffer).setUint32(bytes.length, padded.length - bytes.length);
            padded.set([102, 114, 101, 101], bytes.length + 4); // free box
            return new actual.DataStream(padded.buffer);
        };
        return parser;
    } };
});
import { createWorkspaceVideoMse, WORKSPACE_VIDEO_BUFFER_BYTES } from './workspaceVideoMse';

class GapBuffer extends EventTarget {
    updating = false;
    buffered = { length: 1, start: () => 5.416, end: () => 60 };
    appendedBytes = 0;
    appendBuffer(bytes: ArrayBuffer) {
        this.appendedBytes += bytes.byteLength;
        this.updating = true;
        queueMicrotask(() => { this.updating = false; this.dispatchEvent(new Event('updateend')); });
    }
    abort() { this.updating = false; }
}
class GapSource extends EventTarget {
    static current: GapSource;
    static isTypeSupported() { return true; }
    readyState = 'closed';
    duration = 0;
    buffers: GapBuffer[] = [];
    constructor() { super(); GapSource.current = this; }
    addSourceBuffer() { const buffer = new GapBuffer(); this.buffers.push(buffer); return buffer; }
    open() { this.readyState = 'open'; this.dispatchEvent(new Event('sourceopen')); }
    endOfStream() { this.readyState = 'ended'; }
}
class GapVideo extends EventTarget {
    currentTime = 0;
    paused = false;
    seeking = false;
    readyState = 1;
    dataset: Record<string, string> = {};
}

let release: (() => void) | undefined;
afterEach(() => { release?.(); release = undefined; vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('releases an unplayable buffer gap at the byte budget instead of fetching the complete original', async () => {
    const input = readFileSync(new URL('./__fixtures__/workspace-video.mp4', import.meta.url));
    rpc.chunk.mockImplementation(async (_session, _path, offset: number, length: number) => {
        const bytes = input.subarray(offset, offset + length);
        return { success: true, bytesRead: bytes.length, content: bytes.toString('base64'), eof: offset + bytes.length >= input.length };
    });
    vi.stubGlobal('MediaSource', GapSource);
    vi.stubGlobal('ManagedMediaSource', undefined);
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:gap-budget');
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    const lease = await createWorkspaceVideoMse({
        sessionId: 'session', path: '/workspace/movie.mp4', signal: new AbortController().signal,
        fileInfo: { success: true, name: 'movie.mp4', size: input.length, modified: 17, chunkSize: 4096 },
    });
    release = lease.release;
    const video = new GapVideo();
    const failed = vi.fn();
    lease.attach(video as unknown as HTMLVideoElement, failed);
    GapSource.current.open();
    await vi.waitFor(() => expect(failed).toHaveBeenCalledOnce());
    expect(failed.mock.calls[0][0]).toMatch(/缓冲无法对齐/);
    expect(GapSource.current.buffers.reduce((sum, buffer) => sum + buffer.appendedBytes, 0)).toBeGreaterThanOrEqual(WORKSPACE_VIDEO_BUFFER_BYTES);
    expect(Math.max(...rpc.chunk.mock.calls.map(args => args[2] + args[3]))).toBeLessThan(input.length);
    const requests = rpc.chunk.mock.calls.length;
    video.dispatchEvent(new Event('timeupdate'));
    video.dispatchEvent(new Event('play'));
    await new Promise(resolve => setTimeout(resolve, 25));
    expect(rpc.chunk).toHaveBeenCalledTimes(requests);
    expect(revoke).toHaveBeenCalledWith('blob:gap-budget');
    expect(video.dataset.workspaceVideoTransport).toBeUndefined();
});
