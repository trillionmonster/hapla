import type { ISOFile, Movie, MP4BoxBuffer, Track } from 'mp4box';
import { sessionFileDownloadChunk, type SessionFileDownloadInfoResponse } from '@/sync/ops';

export const WORKSPACE_VIDEO_RANGE_BYTES = 256 * 1024;
export const WORKSPACE_VIDEO_INDEX_BYTES = 8 * 1024 * 1024;
export const WORKSPACE_VIDEO_BUFFER_BYTES = 16 * 1024 * 1024;
const FORWARD_SECONDS = 6;
const PAUSED_SECONDS = 1;
const KEEP_BEHIND_SECONDS = 4;
const STARTUP_SECONDS = 0.5;
type FileInfo = Extract<SessionFileDownloadInfoResponse, { success: true }>;
export type AttachWorkspaceVideo = (video: HTMLVideoElement, onError?: (message: string) => void) => () => void;
type Mse = MediaSource & { streaming?: boolean };
type MseConstructor = { new(): Mse; isTypeSupported(type: string): boolean };
type Fragment = { bytes: ArrayBuffer; start: number; end: number };
type TrackBuffer = { track: Track; buffer: SourceBuffer; queue: Fragment[]; appended: Array<{ start: number; end: number; bytes: number }>; trimTimes?: number[] };
const aborted = () => new DOMException('Cancelled', 'AbortError');

function constructorForBrowser(): { constructor: MseConstructor; managed: boolean } | undefined {
    const browser = globalThis as typeof globalThis & { ManagedMediaSource?: MseConstructor };
    if (browser.ManagedMediaSource) return { constructor: browser.ManagedMediaSource, managed: true };
    if (typeof MediaSource !== 'undefined') return { constructor: MediaSource, managed: false };
}

export function canUseWorkspaceVideoMse(path: string): boolean {
    return /\.(?:mp4|m4v|mov)$/i.test(path) && Boolean(constructorForBrowser());
}

/** Repackages original MP4 samples without re-encoding or exposing workspace
 * bytes to the server. Only the existing authenticated encrypted range RPC is
 * used. This source deliberately has no persistent original-file cache. */
export async function createWorkspaceVideoMse(options: {
    sessionId: string; path: string; fileInfo: FileInfo; signal: AbortSignal;
    onProgress?: (value: number) => void;
}): Promise<{ url: string; size: number; name: string; release: () => void; attach: AttachWorkspaceVideo }> {
    const support = constructorForBrowser();
    if (!support) throw new Error('此浏览器暂不支持分段播放，可下载原视频查看');
    const managed = support.managed;
    const { createFile, DataStream } = await import('mp4box');
    if (options.signal.aborted) throw aborted();
    const controller = new AbortController();
    const cancel = () => controller.abort();
    options.signal.addEventListener('abort', cancel, { once: true });
    const info = options.fileInfo;
    const chunkSize = Math.min(WORKSPACE_VIDEO_RANGE_BYTES, info.chunkSize);
    if (!Number.isSafeInteger(chunkSize) || chunkSize <= 0 || info.size <= 0) {
        options.signal.removeEventListener('abort', cancel);
        throw new Error('视频文件信息无效，请重新打开');
    }
    let parser: ISOFile | undefined;
    let movie: Movie | undefined;
    let source: Mse | undefined;
    let url: string | undefined;
    let video: HTMLVideoElement | undefined;
    let reportError: ((message: string) => void) | undefined;
    let detach: (() => void) | undefined;
    let closed = false;
    let running = false;
    let prepared = false;
    let initializing = false;
    let eof = false;
    let epoch = 0;
    let desiredSeek: number | undefined;
    let offset = 0;
    let indexBytes = 0;
    let startupDeadline: ReturnType<typeof setTimeout> | undefined;
    const index: Array<{ offset: number; bytes: ArrayBuffer }> = [];
    const tracks: TrackBuffer[] = [];
    let selected: Track[] = [];
    let parserFailure: Error | undefined;
    let startupSplitRange: { start: number; end: number } | undefined;
    const check = () => { if (closed || controller.signal.aborted) throw aborted(); };
    const clearParser = () => {
        parser?.stop();
        if (parser) { parser.onReady = parser.onSegment = parser.onSamples = parser.onError = undefined; }
        parser = undefined;
    };
    const release = () => {
        if (closed) return;
        closed = true;
        epoch++;
        controller.abort();
        detach?.();
        clearTimeout(startupDeadline);
        source?.removeEventListener('sourceopen', sourceOpen);
        source?.removeEventListener('startstreaming', wake);
        source?.removeEventListener('endstreaming', wake);
        for (const item of tracks) { item.queue.length = 0; item.appended.length = 0; try { if (item.buffer.updating) item.buffer.abort(); } catch {} }
        tracks.length = 0;
        clearParser();
        index.length = 0;
        movie = undefined;
        selected = [];
        if (url) URL.revokeObjectURL(url);
        options.signal.removeEventListener('abort', cancel);
    };
    controller.signal.addEventListener('abort', release, { once: true });
    const fail = (problem: unknown) => {
        if (closed) return;
        const message = problem instanceof Error ? problem.message : '视频分段读取失败，请重试';
        const notify = reportError;
        release();
        notify?.(message);
    };
    const read = async (start: number): Promise<ArrayBuffer> => {
        check();
        const length = Math.min(chunkSize, info.size - start);
        if (!Number.isSafeInteger(start) || start < 0 || length <= 0) throw new Error('视频分段位置无效');
        let stop!: () => void;
        const cancelled = new Promise<never>((_, reject) => {
            stop = () => reject(aborted());
            controller.signal.addEventListener('abort', stop, { once: true });
        });
        let timeout: ReturnType<typeof setTimeout> | undefined;
        try {
            const reply = await Promise.race([
                sessionFileDownloadChunk(options.sessionId, options.path, start, length, info.modified), cancelled,
                new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error('视频分段读取超时，请重试')), 20_000); }),
            ]);
            check();
            if (!reply.success) throw new Error(reply.error);
            const binary = atob(reply.content);
            if (reply.bytesRead !== binary.length || reply.bytesRead <= 0 || reply.bytesRead > length) throw new Error('视频分段内容不完整，请重试');
            return Uint8Array.from(binary, character => character.charCodeAt(0)).buffer;
        } finally { clearTimeout(timeout); controller.signal.removeEventListener('abort', stop); }
    };
    const appendToParser = (bytes: ArrayBuffer, start: number) => {
        const input = bytes as MP4BoxBuffer;
        input.fileStart = start;
        const next = parser!.appendBuffer(input);
        if (parserFailure) throw parserFailure;
        return next;
    };
    const makeParser = () => {
        parser = createFile(true);
        parser.onError = (_module, message) => { parserFailure = new Error(`视频索引无法读取：${message}`); };
        parser.onReady = value => { movie = value; };
    };
    const duration = () => movie!.duration / movie!.timescale;
    const rangesEnd = (ranges: TimeRanges, at: number): number => {
        for (let i = 0; i < ranges.length; i++) if (ranges.start(i) <= at + 0.25 && ranges.end(i) > at) return ranges.end(i);
        return at;
    };
    const waitForBuffer = async (buffer: SourceBuffer, action: () => void): Promise<void> => {
        check();
        await new Promise<void>((resolve, reject) => {
            const finish = (problem?: Error) => {
                clearTimeout(timer);
                buffer.removeEventListener('updateend', done); buffer.removeEventListener('error', error); buffer.removeEventListener('abort', error);
                controller.signal.removeEventListener('abort', cancelled);
                problem ? reject(problem) : resolve();
            };
            const done = () => finish();
            const error = () => finish(new Error('浏览器无法解码此视频分片，可下载原文件查看'));
            const cancelled = () => finish(aborted());
            const timer = setTimeout(() => finish(new Error('视频缓冲超时，请重新打开')), 15_000);
            buffer.addEventListener('updateend', done, { once: true }); buffer.addEventListener('error', error, { once: true }); buffer.addEventListener('abort', error, { once: true });
            controller.signal.addEventListener('abort', cancelled, { once: true });
            try { action(); } catch (problem) { finish(problem instanceof Error ? problem : new Error('视频缓冲失败')); }
        });
    };
    const configureSegmentation = (initialOpen = false) => {
        // Seek fragments begin with a random-access sample and include their
        // whole GOP. WebKit otherwise starts a non-keyframe seek at the
        // later one-second fragment and skips the earlier fragment's IDR.
        // MP4Box's rapAlignement option splits *after* the next sync sample,
        // so use its public extraction/remux APIs to split before that sample.
        parser!.onSegment = () => {};
        for (const track of selected) parser!.setSegmentOptions(track.id, undefined, { nbSamples: 1, rapAlignement: false });
        const initial = parser!.initializeSegmentation('per-track');
        for (const track of selected) {
            parser!.unsetSegmentOptions(track.id);
            parser!.setExtractionOptions(track.id, undefined, { nbSamples: 1 });
        }
        parser!.onSegment = undefined;
        const starts = new Map<number, number>();
        const startupVideoGops = new Map<number, number>();
        startupSplitRange = undefined;
        if (initialOpen) {
            for (const track of selected.filter(track => track.video)) {
                const samples = parser!.getTrackSamplesInfo(track.id);
                const nextSync = samples.findIndex((sample, index) => index > 0 && sample.is_sync);
                const gopEnd = nextSync < 0 ? samples.length : nextSync;
                const first = samples[0];
                if (!first?.is_sync) continue;
                const split = samples.findIndex(sample => (sample.dts + sample.duration - first.dts) / first.timescale >= STARTUP_SECONDS);
                // Only the first open needs a small decodable prefix. Preserve
                // sample decode order; all seeks reconstruct complete GOPs.
                if (split >= 0 && split + 1 < gopEnd) {
                    startupVideoGops.set(track.id, gopEnd);
                    let start = Infinity, end = 0;
                    for (let number = 0; number < gopEnd; number++) {
                        const sample = samples[number];
                        start = Math.min(start, sample.cts / sample.timescale);
                        end = Math.max(end, (sample.cts + sample.duration) / sample.timescale);
                    }
                    startupSplitRange = { start, end };
                }
            }
        }
        const emit = (target: TrackBuffer, firstNumber: number, lastNumber: number) => {
            const samples = parser!.getTrackSamplesInfo(target.track.id);
            const first = samples[firstNumber];
            const fragment = parser!.createFragment(target.track.id, firstNumber, lastNumber, new DataStream());
            if (!fragment) throw new Error('视频关键帧分片不完整，请重新打开');
            let start = first.cts / first.timescale, end = 0;
            for (let number = firstNumber; number <= lastNumber; number++) {
                const sample = samples[number];
                start = Math.min(start, sample.cts / sample.timescale);
                end = Math.max(end, (sample.cts + sample.duration) / sample.timescale);
            }
            target.queue.push({ bytes: fragment.buffer, start, end });
            parser!.releaseUsedSamples(target.track.id, lastNumber + 1);
        };
        parser!.onSamples = (id, _user, samples) => {
            const target = tracks.find(item => item.track.id === id);
            if (!target || closed) return;
            for (const sample of samples) {
                let firstNumber = starts.get(id);
                if (target.track.video && sample.is_sync && firstNumber !== undefined && sample.number > firstNumber) {
                    emit(target, firstNumber, sample.number - 1);
                    firstNumber = undefined;
                }
                if (firstNumber === undefined) { firstNumber = sample.number; starts.set(id, firstNumber); }
                const first = parser!.getTrackSamplesInfo(id)[firstNumber];
                const startupGopEnd = startupVideoGops.get(id);
                const startupVideoChunk = startupGopEnd !== undefined && sample.number + 1 < startupGopEnd
                    && (sample.dts + sample.duration - first.dts) / sample.timescale >= STARTUP_SECONDS;
                const audioSeconds = initialOpen && first.cts / first.timescale < (startupSplitRange?.end ?? STARTUP_SECONDS) ? STARTUP_SECONDS : 1;
                if (startupVideoChunk
                    || (!target.track.video && (sample.cts + sample.duration - first.cts) / sample.timescale >= audioSeconds)
                    || sample.number === target.track.nb_samples - 1) {
                    emit(target, firstNumber, sample.number);
                    starts.delete(id);
                }
            }
        };
        return initial;
    };
    const resetForSeek = async (at: number) => {
        clearParser(); parserFailure = undefined;
        makeParser();
        for (const chunk of index) appendToParser(chunk.bytes.slice(0), chunk.offset);
        for (const track of tracks) { track.queue.length = 0; track.appended.length = 0; }
        const initial = configureSegmentation();
        const seek = parser!.seek(Math.max(0, Math.min(at, duration() - 0.001)), true);
        offset = seek.offset;
        eof = false;
        for (const init of initial) {
            const target = tracks.find(item => item.track.id === init.id)!;
            if (target.buffer.buffered.length) await waitForBuffer(target.buffer, () => target.buffer.remove(0, Math.max(duration(), target.buffer.buffered.end(target.buffer.buffered.length - 1))));
            await waitForBuffer(target.buffer, () => target.buffer.appendBuffer(init.buffer));
        }
        parser!.start();
    };
    async function pump() {
        if (closed || running || !prepared || initializing || !video || !source || source.readyState === 'closed') return;
        running = true;
        try {
            while (!closed && video && (source.readyState as ReadyState) !== 'closed') {
                if (desiredSeek !== undefined) {
                    const target = desiredSeek; desiredSeek = undefined;
                    await resetForSeek(target);
                }
                // Once a paused viewer has its current frame, do not pull an
                // entire next GOP merely to fill the ahead-buffer threshold.
                // Initial loading and paused seeks still need their first frame.
                if (video.paused && !video.seeking && video.readyState >= 2) break;
                const currentEpoch = epoch;
                const at = video.currentTime || 0;
                for (const track of tracks) {
                    let before = Math.max(0, at - KEEP_BEHIND_SECONDS);
                    if (track.trimTimes) {
                        // Removing an IDR inside a GOP also removes pictures
                        // that still depend on it. Keep the whole current GOP.
                        let low = 0, high = track.trimTimes.length;
                        while (low < high) {
                            const middle = (low + high) >>> 1;
                            if (track.trimTimes[middle] <= before) low = middle + 1;
                            else high = middle;
                        }
                        before = low > 0 ? track.trimTimes[low - 1] : 0;
                    }
                    if (track.buffer.buffered.length && track.buffer.buffered.start(0) + 0.5 < before) {
                        await waitForBuffer(track.buffer, () => track.buffer.remove(0, before));
                        track.appended = track.appended.filter(fragment => fragment.end > before);
                    }
                    if (track.queue.length && epoch === currentEpoch) {
                        const fragment = track.queue.shift()!;
                        await waitForBuffer(track.buffer, () => track.buffer.appendBuffer(fragment.bytes));
                        track.appended.push({ start: fragment.start, end: fragment.end, bytes: fragment.bytes.byteLength });
                    }
                }
                if (epoch !== currentEpoch) continue;
                const ahead = Math.min(...tracks.map(track => rangesEnd(track.buffer.buffered, at) - at));
                const nativeBytes = tracks.reduce((sum, track) => sum + track.appended.reduce((total, fragment) => total + fragment.bytes, 0), 0);
                if (nativeBytes >= WORKSPACE_VIDEO_BUFFER_BYTES) {
                    if (ahead <= 0) throw new Error('视频缓冲无法对齐播放位置，请重新打开');
                    break;
                }
                if (ahead >= (video.paused ? PAUSED_SECONDS : FORWARD_SECONDS)) break;
                // ManagedMediaSource asks the page when data is useful. Permit
                // initial/seek data, then respect its stop-streaming signal.
                if (managed && source.streaming === false && ahead > 0.25) break;
                if (tracks.some(track => track.queue.length)) continue;
                if (eof) { if (source.readyState === 'open') source.endOfStream(); break; }
                if (offset >= info.size) { parser!.flush(); eof = true; continue; }
                const bytes = await read(offset);
                if (epoch !== currentEpoch) continue;
                const next = appendToParser(bytes, offset);
                if (!Number.isSafeInteger(next) || next < 0 || next === offset) throw new Error('视频分段索引无法继续，请重新打开');
                offset = next;
                const retained = parser!.stream.buffers.reduce((sum, chunk) => sum + chunk.byteLength, 0) + parser!.getAllocatedSampleDataSize()
                    + tracks.reduce((sum, track) => sum + track.queue.reduce((total, fragment) => total + fragment.bytes.byteLength, 0), 0);
                if (retained > WORKSPACE_VIDEO_BUFFER_BYTES) throw new Error('视频分片超过浏览器缓冲预算，可下载原文件查看');
            }
        } catch (problem) { if (!closed) fail(problem); }
        finally { running = false; if (!closed && desiredSeek !== undefined) void pump(); }
    }
    function wake() { void pump(); }
    async function sourceOpen() {
        if (closed || prepared || !video || source?.readyState !== 'open') return;
        prepared = true;
        initializing = true;
        clearTimeout(startupDeadline);
        try {
            source.duration = duration();
            for (const track of selected) {
                const mime = `${track.video ? 'video' : 'audio'}/mp4; codecs="${track.codec}"`;
                let trimTimes: number[] | undefined;
                if (track.video) {
                    // Chromium applies the edit-list presentation offset while
                    // WebKit can expose the raw CTS timeline. Trim no later
                    // than either engine's random-access frame, never after it.
                    let editOffset = 0;
                    for (const edit of track.edits ?? []) editOffset = Math.max(editOffset, edit.media_time);
                    trimTimes = parser!.getTrackSamplesInfo(track.id).filter(sample => sample.is_sync)
                        .map(sample => Math.max(0, Math.min(sample.dts, sample.cts - editOffset)) / sample.timescale)
                        .sort((a, b) => a - b);
                }
                tracks.push({ track, buffer: source.addSourceBuffer(mime), queue: [], appended: [], trimTimes });
            }
            const initial = configureSegmentation(true);
            offset = parser!.seek(0, true).offset;
            for (const init of initial) await waitForBuffer(tracks.find(item => item.track.id === init.id)!.buffer, () => tracks.find(item => item.track.id === init.id)!.buffer.appendBuffer(init.buffer));
            parser!.start();
            initializing = false;
            wake();
        } catch (problem) { if (!closed) fail(problem); }
    }
    try {
        makeParser();
        const started = Date.now();
        while (!movie) {
            if (Date.now() - started > 30_000 || indexBytes >= WORKSPACE_VIDEO_INDEX_BYTES) throw new Error('视频索引过大或读取超时，可下载原文件查看');
            const bytes = await read(offset);
            index.push({ offset, bytes: bytes.slice(0) }); indexBytes += bytes.byteLength;
            const next = appendToParser(bytes, offset);
            options.onProgress?.(Math.min(1, indexBytes / info.size));
            if (movie) break;
            if (!Number.isSafeInteger(next) || next <= offset || next >= info.size) throw new Error('未找到可用的视频索引，可下载原文件查看');
            offset = next;
        }
        check();
        const parsed = movie as Movie;
        if (parsed.isFragmented) throw new Error('此分片MP4暂不支持工作区分段播放，可下载原文件查看');
        selected = [parsed.videoTracks[0], parsed.audioTracks[0]].filter((track): track is Track => Boolean(track));
        if (!parsed.videoTracks.length || !Number.isFinite(duration()) || duration() <= 0) throw new Error('视频轨道或时长无效');
        for (const track of selected) {
            if (!support.constructor.isTypeSupported(`${track.video ? 'video' : 'audio'}/mp4; codecs="${track.codec}"`)) throw new Error('浏览器不支持此视频编码，可下载原文件查看');
            if (parser!.getTrackSamplesInfo(track.id).some(sample => sample.size > WORKSPACE_VIDEO_BUFFER_BYTES)) throw new Error('视频单帧超过浏览器缓冲预算，可下载原文件查看');
        }
        source = new support.constructor();
        source.addEventListener('sourceopen', sourceOpen);
        source.addEventListener('startstreaming', wake);
        source.addEventListener('endstreaming', wake);
        url = URL.createObjectURL(source);
        const attach: AttachWorkspaceVideo = (element, onError) => {
            if (closed) return () => {};
            if (video && video !== element) throw new Error('视频流已连接到另一个播放器');
            detach?.(); video = element; reportError = onError;
            const previousRemote = element.disableRemotePlayback;
            if (support.managed) element.disableRemotePlayback = true;
            element.dataset.workspaceVideoTransport = support.managed ? 'managed-mse' : 'mse';
            const seeking = () => {
                // WebKit may select the non-IDR remainder when seeking inside
                // a buffered split startup GOP. Rebuild that GOP even if its
                // target is already buffered; ordinary GOPs keep the fast path.
                const splitStartupSeek = startupSplitRange && element.currentTime >= startupSplitRange.start && element.currentTime < startupSplitRange.end;
                if (!splitStartupSeek && tracks.length && tracks.every(track => rangesEnd(track.buffer.buffered, element.currentTime) > element.currentTime + 0.25)) { wake(); return; }
                desiredSeek = element.currentTime; epoch++; wake();
            };
            element.addEventListener('seeking', seeking);
            for (const event of ['timeupdate', 'play', 'pause', 'waiting']) element.addEventListener(event, wake);
            detach = () => {
                element.removeEventListener('seeking', seeking);
                for (const event of ['timeupdate', 'play', 'pause', 'waiting']) element.removeEventListener(event, wake);
                if (support.managed) element.disableRemotePlayback = previousRemote;
                delete element.dataset.workspaceVideoTransport;
                if (video === element) video = undefined;
                detach = undefined;
            };
            startupDeadline = setTimeout(() => fail(new Error('视频流未能连接播放器，请重新打开')), 15_000);
            void sourceOpen();
            return () => detach?.();
        };
        return { url, size: info.size, name: info.name, release, attach };
    } catch (problem) { release(); throw problem; }
}
