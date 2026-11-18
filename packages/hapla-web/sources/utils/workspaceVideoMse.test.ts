import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createFile, type MP4BoxBuffer } from 'mp4box';
const rpc = vi.hoisted(() => ({ chunk: vi.fn() }));
vi.mock('@/sync/ops', () => ({ sessionFileDownloadChunk: rpc.chunk }));
import { createWorkspaceVideoMse, WORKSPACE_VIDEO_RANGE_BYTES, canUseWorkspaceVideoMse } from './workspaceVideoMse';

const original = readFileSync(new URL('./__fixtures__/workspace-video.mp4', import.meta.url));
function fixture(tail: boolean): Buffer {
    const file = Buffer.from(original);
    let offset = 0, moov: Buffer | undefined, mdat = -1;
    while (offset < file.length) {
        const size = file.readUInt32BE(offset), type = file.toString('ascii', offset + 4, offset + 8);
        if (type === 'moov') { moov = Buffer.from(file.subarray(offset, offset + size)); if (tail) file.write('free', offset + 4); }
        if (type === 'mdat') mdat = offset;
        offset += size;
    }
    if (!moov || mdat < 0) throw new Error('Missing fixture moov/mdat');
    const padding = Buffer.alloc(32 * 1024 * 1024 - file.length - (tail ? moov.length : 0));
    // Expand mdat with unreferenced padding, retaining real sample offsets.
    // The tail variant mirrors a camera MOV whose index follows its media.
    file.writeUInt32BE(file.readUInt32BE(mdat) + padding.length, mdat);
    return Buffer.concat([file, padding, ...(tail ? [moov] : [])]);
}
const fixtures = { head: fixture(false), tail: fixture(true) };
const pause = () => new Promise(resolve => setTimeout(resolve, 5));
async function waitFor(condition: () => boolean) { for (let n = 0; n < 300; n++) { if (condition()) return; await pause(); } throw new Error('Media condition did not settle'); }

class Ranges {
    ranges: number[][] = [];
    get length() { return this.ranges.length; }
    start(index: number) { return this.ranges[index][0]; }
    end(index: number) { return this.ranges[index][1]; }
    add(start: number, end: number) {
        this.ranges.push([start, end]); this.ranges.sort((a, b) => a[0] - b[0]);
        this.ranges = this.ranges.reduce<number[][]>((all, next) => {
            const last = all.at(-1); if (last && next[0] <= last[1] + 0.03) last[1] = Math.max(last[1], next[1]); else all.push([...next]); return all;
        }, []);
    }
}
class FakeSourceBuffer extends EventTarget {
    buffered = new Ranges(); updating = false;
    removals: Array<{ start: number; end: number }> = [];
    parser = createFile(false); offset = 0; count = 0;
    mediaFragments: Array<{ start: number; end: number; bytes: number; startsWithSync: boolean; syncSamples: number; sampleCount: number; decodeStart: number; decodeEnd: number; requestedBytes: number }> = [];
    appendBuffer(value: ArrayBuffer) {
        if (this.updating) throw new Error('Concurrent append');
        this.updating = true;
        const bytes = Buffer.from(value);
        if (bytes.toString('ascii', 4, 8) === 'ftyp') { this.parser = createFile(false); this.offset = 0; this.count = 0; }
        const input = value.slice(0) as MP4BoxBuffer; input.fileStart = this.offset; this.offset += input.byteLength;
        this.parser.appendBuffer(input);
        const track = this.parser.getInfo().tracks[0];
        const samples = track ? this.parser.getTrackSamplesInfo(track.id).slice(this.count) : [];
        if (samples.length) {
            this.count += samples.length;
            const start = Math.min(...samples.map(s => s.cts / s.timescale)), end = Math.max(...samples.map(s => (s.cts + s.duration) / s.timescale));
            this.buffered.add(start, end); this.mediaFragments.push({ start, end, bytes: value.byteLength,
                startsWithSync: samples[0].is_sync, syncSamples: samples.filter(sample => sample.is_sync).length,
                sampleCount: samples.length, decodeStart: samples[0].dts / samples[0].timescale,
                decodeEnd: (samples.at(-1)!.dts + samples.at(-1)!.duration) / samples.at(-1)!.timescale,
                requestedBytes: rpc.chunk.mock.calls.reduce((total, args) => total + args[3], 0) });
        }
        queueMicrotask(() => { this.updating = false; this.dispatchEvent(new Event('updateend')); });
    }
    remove(start: number, end: number) {
        this.removals.push({ start, end });
        this.updating = true;
        this.buffered.ranges = this.buffered.ranges.flatMap(([a, b]) => b <= start || a >= end ? [[a, b]] : [...(a < start ? [[a, start]] : []), ...(b > end ? [[end, b]] : [])]);
        queueMicrotask(() => { this.updating = false; this.dispatchEvent(new Event('updateend')); });
    }
    abort() { this.updating = false; this.dispatchEvent(new Event('abort')); }
}
class FakeMediaSource extends EventTarget {
    static instances: FakeMediaSource[] = [];
    static isTypeSupported = vi.fn(() => true);
    sourceBuffers: FakeSourceBuffer[] = []; readyState = 'closed'; duration = NaN;
    constructor() { super(); FakeMediaSource.instances.push(this); }
    addSourceBuffer() { const buffer = new FakeSourceBuffer(); this.sourceBuffers.push(buffer); return buffer; }
    endOfStream() { this.readyState = 'ended'; }
    open() { this.readyState = 'open'; this.dispatchEvent(new Event('sourceopen')); }
}
class FakeVideo extends EventTarget {
    currentTime = 0; paused = true; seeking = false; readyState = 0;
    disableRemotePlayback = false; dataset: Record<string, string> = {};
}
let releases: Array<() => void> = [];
let input: Buffer;
let requestedChunkSize = WORKSPACE_VIDEO_RANGE_BYTES;
const options = () => ({ sessionId: 'session', path: '/workspace/movie.mp4', fileInfo: { success: true as const, size: input.length, modified: 17, name: 'movie.mp4', chunkSize: requestedChunkSize }, signal: new AbortController().signal });
function chunk(_session: string, _path: string, offset: number, length: number) {
    const bytes = input.subarray(offset, offset + length);
    return { success: true, bytesRead: bytes.length, content: bytes.toString('base64'), eof: offset + bytes.length >= input.length };
}
beforeEach(() => {
    input = fixtures.head; requestedChunkSize = WORKSPACE_VIDEO_RANGE_BYTES; releases = []; FakeMediaSource.instances = [];
    FakeMediaSource.isTypeSupported.mockReset().mockReturnValue(true);
    vi.stubGlobal('MediaSource', FakeMediaSource); vi.stubGlobal('ManagedMediaSource', undefined);
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:workspace-mse'); vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    rpc.chunk.mockReset().mockImplementation(async (...args) => chunk(...args as [string, string, number, number]));
});
afterEach(() => { releases.forEach(release => release()); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
async function open() {
    const lease = await createWorkspaceVideoMse(options()); releases.push(lease.release);
    const video = new FakeVideo(), error = vi.fn();
    lease.attach(video as unknown as HTMLVideoElement, error);
    const source = FakeMediaSource.instances[0]; source.open();
    await waitFor(() => error.mock.calls.length > 0 || source.sourceBuffers.length === 2 && source.sourceBuffers.every(buffer => buffer.buffered.length > 0));
    expect(error).not.toHaveBeenCalled();
    return { lease, video, source, error };
}

describe('encrypted workspace MP4 MediaSource playback', () => {
    it.each(['head', 'tail'] as const)('reads %s moov and playable video/audio fragments before fetching a 32MiB original', async location => {
        input = fixtures[location];
        const { source, video } = await open();
        await pause();
        expect(source.duration).toBeCloseTo(8, 1);
        expect(video.dataset.workspaceVideoTransport).toBe('mse');
        expect(source.sourceBuffers.every(buffer => buffer.mediaFragments.length > 0)).toBe(true);
        expect(rpc.chunk.mock.calls.reduce((total, args) => total + args[3], 0)).toBeLessThan(2 * 1024 * 1024);
        expect(rpc.chunk.mock.calls.every(args => args[3] <= WORKSPACE_VIDEO_RANGE_BYTES && args[4] === 17)).toBe(true);
        if (location === 'tail') expect(rpc.chunk.mock.calls.some(args => args[2] > input.length - 64 * 1024)).toBe(true);
        const count = rpc.chunk.mock.calls.length;
        await new Promise(resolve => setTimeout(resolve, 30));
        expect(rpc.chunk).toHaveBeenCalledTimes(count);
    });

    it('seeks to later keyframes and back without mixing timestamps or continuing beyond the paused buffer', async () => {
        const { video, source, error } = await open();
        video.currentTime = 6; video.dispatchEvent(new Event('seeking'));
        await waitFor(() => error.mock.calls.length > 0 || source.sourceBuffers.every(buffer => buffer.buffered.length > 0 && buffer.buffered.end(0) > 6.3));
        expect(error).not.toHaveBeenCalled();
        expect(source.sourceBuffers.every(buffer => buffer.buffered.start(0) >= 5.8)).toBe(true);
        video.currentTime = 1; video.dispatchEvent(new Event('seeking'));
        await waitFor(() => error.mock.calls.length > 0 || source.sourceBuffers.every(buffer => buffer.buffered.length > 0 && buffer.buffered.start(0) <= 1.1 && buffer.buffered.end(0) > 1.3));
        expect(error).not.toHaveBeenCalled();
        const count = rpc.chunk.mock.calls.length; await new Promise(resolve => setTimeout(resolve, 30));
        expect(rpc.chunk).toHaveBeenCalledTimes(count);
    });

    it('stops reads immediately when paused with a current frame and less than one second ahead, then resumes', async () => {
        const { video, source, error } = await open();
        video.currentTime = Math.min(...source.sourceBuffers.map(buffer => buffer.buffered.end(0))) - 0.4;
        video.readyState = 2;
        video.paused = true;
        video.dispatchEvent(new Event('pause'));
        const pausedCount = rpc.chunk.mock.calls.length;
        await new Promise(resolve => setTimeout(resolve, 30));
        expect(rpc.chunk).toHaveBeenCalledTimes(pausedCount);
        video.paused = false; video.dispatchEvent(new Event('play'));
        await waitFor(() => error.mock.calls.length > 0 || rpc.chunk.mock.calls.length > pausedCount);
        expect(error).not.toHaveBeenCalled();
        expect(rpc.chunk.mock.calls.length).toBeGreaterThan(pausedCount);
    });

    it('still fetches a target frame for a paused seek, then stops once that frame is available', async () => {
        const { video, source, error } = await open();
        const initialCount = rpc.chunk.mock.calls.length;
        video.currentTime = 5.25; video.paused = true; video.seeking = true; video.readyState = 1;
        video.dispatchEvent(new Event('seeking'));
        await waitFor(() => error.mock.calls.length > 0 || source.sourceBuffers.every(buffer => buffer.buffered.length > 0 && buffer.buffered.start(0) <= 5.25 && buffer.buffered.end(0) > 5.25));
        expect(error).not.toHaveBeenCalled();
        expect(rpc.chunk.mock.calls.length).toBeGreaterThan(initialCount);
        video.seeking = false; video.readyState = 2; video.dispatchEvent(new Event('timeupdate'));
        const settledCount = rpc.chunk.mock.calls.length;
        await new Promise(resolve => setTimeout(resolve, 30));
        expect(rpc.chunk).toHaveBeenCalledTimes(settledCount);
    });

    it('opens with a short video/audio prefix and continues the first GOP without skipping decoded samples', async () => {
        requestedChunkSize = 16 * 1024;
        const { source, error, video: element } = await open();
        element.paused = false; element.dispatchEvent(new Event('play'));
        const video = source.sourceBuffers[0], audio = source.sourceBuffers[1];
        await waitFor(() => error.mock.calls.length > 0 || video.buffered.end(0) >= 2);
        expect(error).not.toHaveBeenCalled();
        const [prefix, continuation] = video.mediaFragments;
        expect(prefix.start).toBe(0);
        expect(prefix.end).toBeCloseTo(8 / 15);
        expect(prefix.startsWithSync).toBe(true);
        expect(audio.mediaFragments[0].end - audio.mediaFragments[0].start).toBeLessThan(0.55);
        expect(prefix.requestedBytes).toBeLessThan(continuation.requestedBytes);
        expect(continuation.startsWithSync).toBe(false);
        expect(prefix.decodeEnd).toBeCloseTo(continuation.decodeStart);
        const firstGop = video.mediaFragments.filter(fragment => fragment.start < 2);
        expect(firstGop.length).toBeGreaterThan(2);
        expect(firstGop.at(-1)?.end).toBe(2);
        expect(firstGop.reduce((total, fragment) => total + fragment.sampleCount, 0)).toBe(30);
        for (let index = 1; index < firstGop.length; index++) expect(firstGop[index].decodeStart).toBeCloseTo(firstGop[index - 1].decodeEnd);
    });

    it('keeps complete GOP boundaries on non-keyframe seeks after the short startup prefix', async () => {
        const { video, source, error } = await open();
        const track = source.sourceBuffers[0];
        expect(track.mediaFragments[0].end - track.mediaFragments[0].start).toBeLessThan(0.6);
        const initialFragments = track.mediaFragments.length;
        video.currentTime = 5.25; video.dispatchEvent(new Event('seeking'));
        await waitFor(() => error.mock.calls.length > 0 || track.buffered.length > 0 && track.buffered.start(0) === 4 && track.buffered.end(0) >= 6);
        expect(error).not.toHaveBeenCalled();
        expect(track.mediaFragments.length).toBeGreaterThan(1);
        expect(track.mediaFragments.slice(initialFragments).every(fragment => fragment.startsWithSync && fragment.syncSamples === 1)).toBe(true);
        expect(track.mediaFragments.some(fragment => fragment.start === 4 && fragment.end === 6)).toBe(true);
    });

    it('rebuilds a complete GOP even when seeking into the already buffered startup continuation', async () => {
        const { video, source, error } = await open();
        const track = source.sourceBuffers[0];
        video.paused = false; video.dispatchEvent(new Event('play'));
        await waitFor(() => track.buffered.end(0) >= 2);
        const before = track.mediaFragments.length;
        video.currentTime = 1.25; video.dispatchEvent(new Event('seeking'));
        await waitFor(() => error.mock.calls.length > 0 || track.mediaFragments.length > before);
        expect(error).not.toHaveBeenCalled();
        expect(track.mediaFragments[before]).toMatchObject({ start: 0, end: 2, startsWithSync: true, syncSamples: 1, sampleCount: 30 });
    });

    it('preserves B-frame decode order across startup chunks and reconstructs its long GOP for a buffered seek', async () => {
        input = readFileSync(new URL('./__fixtures__/workspace-video-bframes.mp4', import.meta.url));
        requestedChunkSize = 16 * 1024;
        const { video, source, error } = await open();
        const track = source.sourceBuffers[0];
        video.paused = false; video.dispatchEvent(new Event('play'));
        await waitFor(() => error.mock.calls.length > 0 || track.buffered.end(0) >= 128 / 24);
        expect(error).not.toHaveBeenCalled();
        const firstGop = track.mediaFragments.filter(fragment => fragment.decodeStart < 126 / 24 - 0.001);
        expect(firstGop.length).toBeGreaterThan(8);
        expect(firstGop[0].startsWithSync).toBe(true);
        expect(firstGop[0].decodeStart).toBeLessThan(firstGop[0].start);
        expect(firstGop[0].decodeEnd - firstGop[0].decodeStart).toBeCloseTo(0.5);
        expect(firstGop.reduce((count, fragment) => count + fragment.sampleCount, 0)).toBe(128);
        for (let index = 1; index < firstGop.length; index++) expect(firstGop[index].decodeStart).toBeCloseTo(firstGop[index - 1].decodeEnd);
        const before = track.mediaFragments.length;
        video.currentTime = 2.1; video.dispatchEvent(new Event('seeking'));
        await waitFor(() => error.mock.calls.length > 0 || track.mediaFragments.length > before);
        expect(error).not.toHaveBeenCalled();
        expect(track.mediaFragments[before]).toMatchObject({ start: firstGop[0].start, startsWithSync: true, syncSamples: 1, sampleCount: 128 });
        expect(track.mediaFragments[before].end - track.mediaFragments[before].start).toBeCloseTo(128 / 24);
    });

    it('keeps the startup IDR while current pictures depend on it, then trims before both edit-adjusted and raw-CTS keyframes', async () => {
        input = readFileSync(new URL('./__fixtures__/workspace-video-bframes.mp4', import.meta.url));
        requestedChunkSize = 16 * 1024;
        const { video, source, error } = await open();
        const track = source.sourceBuffers[0];
        video.paused = false; video.dispatchEvent(new Event('play'));
        await waitFor(() => error.mock.calls.length > 0 || track.buffered.end(0) >= 6);
        expect(error).not.toHaveBeenCalled();
        video.currentTime = 4.524; video.dispatchEvent(new Event('timeupdate'));
        await new Promise(resolve => setTimeout(resolve, 20));
        // The original regression removed [0, .524] here, which drops the
        // first IDR and all still-needed pictures up to the next keyframe.
        expect(track.removals).toHaveLength(0);
        expect(track.buffered.start(0)).toBeLessThan(0.1);

        video.currentTime = 9.6; video.dispatchEvent(new Event('timeupdate'));
        await waitFor(() => error.mock.calls.length > 0 || track.removals.length > 0);
        expect(error).not.toHaveBeenCalled();
        expect(track.removals[0].end).toBeCloseTo(128 / 24);
        // The fixture's raw CTS is two frames later. Trimming there would
        // delete Chromium's edit-adjusted keyframe at 128 / 24 seconds.
        expect(track.removals[0].end).toBeLessThan((128 + 2) / 24);
    });

    it('cancels a pending startup continuation without issuing or appending further reads', async () => {
        requestedChunkSize = 16 * 1024;
        let resolveRead!: (value: ReturnType<typeof chunk>) => void;
        let requested: [string, string, number, number] | undefined;
        rpc.chunk.mockImplementation(async (...args) => {
            const source = FakeMediaSource.instances[0];
            if (source?.sourceBuffers.length === 2 && source.sourceBuffers.every(buffer => buffer.mediaFragments.length > 0)) {
                requested = args as [string, string, number, number];
                return new Promise(resolve => { resolveRead = resolve; });
            }
            return chunk(...args as [string, string, number, number]);
        });
        const { lease, source, error } = await open();
        await waitFor(() => Boolean(requested));
        const calls = rpc.chunk.mock.calls.length;
        const fragments = source.sourceBuffers.reduce((total, buffer) => total + buffer.mediaFragments.length, 0);
        lease.release(); resolveRead(chunk(...requested!));
        await new Promise(resolve => setTimeout(resolve, 30));
        expect(rpc.chunk).toHaveBeenCalledTimes(calls);
        expect(source.sourceBuffers.reduce((total, buffer) => total + buffer.mediaFragments.length, 0)).toBe(fragments);
        expect(error).not.toHaveBeenCalled();
    });

    it('does not append a stale seek response or issue further ranges after closing', async () => {
        const { video, source, lease, error } = await open();
        let resolveRead!: (value: ReturnType<typeof chunk>) => void;
        let requested: [string, string, number, number] | undefined;
        rpc.chunk.mockImplementationOnce((...args) => { requested = args as [string, string, number, number]; return new Promise(resolve => { resolveRead = resolve; }); });
        video.currentTime = 6; video.dispatchEvent(new Event('seeking'));
        await waitFor(() => Boolean(requested));
        const count = rpc.chunk.mock.calls.length, fragments = source.sourceBuffers.reduce((sum, buffer) => sum + buffer.mediaFragments.length, 0);
        lease.release(); resolveRead(chunk(...requested!));
        await new Promise(resolve => setTimeout(resolve, 30));
        expect(rpc.chunk).toHaveBeenCalledTimes(count);
        expect(source.sourceBuffers.reduce((sum, buffer) => sum + buffer.mediaFragments.length, 0)).toBe(fragments);
        expect(error).not.toHaveBeenCalled();
        expect(URL.revokeObjectURL).toHaveBeenCalledWith(lease.url);
        expect(video.dataset.workspaceVideoTransport).toBeUndefined();
    });

    it('configures ManagedMediaSource remote playback and restores it on detach', async () => {
        vi.stubGlobal('MediaSource', undefined); vi.stubGlobal('ManagedMediaSource', FakeMediaSource);
        const { lease, video } = await open();
        expect(video.dataset.workspaceVideoTransport).toBe('managed-mse');
        expect(video.disableRemotePlayback).toBe(true);
        lease.release();
        expect(video.disableRemotePlayback).toBe(false);
    });

    it('rejects unsupported codecs after bounded index reads without creating a decoder', async () => {
        FakeMediaSource.isTypeSupported.mockReturnValue(false);
        await expect(createWorkspaceVideoMse(options())).rejects.toThrow('浏览器不支持此视频编码');
        expect(FakeMediaSource.instances).toHaveLength(0);
        expect(rpc.chunk).toHaveBeenCalledTimes(1);
    });

    it('settles cancellation during an unresponsive index range without reading again', async () => {
        rpc.chunk.mockImplementationOnce(() => new Promise(() => {}));
        const controller = new AbortController();
        const pending = createWorkspaceVideoMse({ ...options(), signal: controller.signal });
        const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
        await waitFor(() => rpc.chunk.mock.calls.length === 1);
        controller.abort(); await rejected;
        expect(rpc.chunk).toHaveBeenCalledTimes(1); expect(FakeMediaSource.instances).toHaveLength(0);
    });

    it('restricts this path to supported MP4-family containers', () => {
        expect(canUseWorkspaceVideoMse('/work/movie.mp4')).toBe(true);
        expect(canUseWorkspaceVideoMse('/work/movie.MOV')).toBe(true);
        expect(canUseWorkspaceVideoMse('/work/movie.webm')).toBe(false);
    });
});
