import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadExternalVideoPreview } from './externalVideoPreview';

const signedUrl = 'https://cdn.example.test/path/film.mp4?X-Amz-Signature=a%2Fb%2Bc&X-Amz-Credential=user%2Fscope&token=raw+value';
type NativeEvent = 'onloadedmetadata' | 'onloadeddata' | 'onseeked' | 'onerror';
let video: Record<NativeEvent, (() => void) | null> & {
    src: string; readyState: number; videoWidth: number; videoHeight: number; duration: number; currentTime: number;
    muted: boolean; playsInline: boolean; preload: string; crossOrigin: string;
    pause: ReturnType<typeof vi.fn>; play: ReturnType<typeof vi.fn>; load: ReturnType<typeof vi.fn>; removeAttribute: ReturnType<typeof vi.fn>;
};
let canvas: { width: number; height: number; getContext: ReturnType<typeof vi.fn>; toDataURL: ReturnType<typeof vi.fn> };
let fetchMock: ReturnType<typeof vi.fn>;
let cancelBody: ReturnType<typeof vi.fn>;
let createElement: ReturnType<typeof vi.fn>;
const publish = vi.fn();

beforeEach(() => {
    vi.useFakeTimers();
    publish.mockReset();
    video = {
        src: '', readyState: 0, videoWidth: 0, videoHeight: 0, duration: NaN, currentTime: 0,
        muted: false, playsInline: false, preload: '', crossOrigin: '',
        onloadedmetadata: null, onloadeddata: null, onseeked: null, onerror: null,
        pause: vi.fn(), play: vi.fn(), load: vi.fn(), removeAttribute: vi.fn(name => { if (name === 'src') video.src = ''; }),
    };
    canvas = { width: 0, height: 0, getContext: vi.fn(() => ({ drawImage: vi.fn() })), toDataURL: vi.fn(() => 'data:image/jpeg;base64,cG9zdGVy') };
    createElement = vi.fn(name => name === 'video' ? video : name === 'canvas' ? canvas : undefined);
    cancelBody = vi.fn().mockResolvedValue(undefined);
    fetchMock = vi.fn().mockResolvedValue({ status: 206, headers: new Headers({ 'Content-Range': 'bytes 0-0/33554432' }), body: { cancel: cancelBody } });
    vi.stubGlobal('document', { createElement, body: { appendChild: vi.fn() } });
    vi.stubGlobal('window', { location: { href: 'http://hapla.test/session/a' } });
    vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

function metadata() {
    video.videoWidth = 1920; video.videoHeight = 1080; video.duration = 24.5; video.readyState = 1;
    video.onloadedmetadata?.();
}

function firstFrame() {
    metadata();
    video.readyState = 2;
    video.onseeked?.();
}

async function expectStarted() {
    await vi.advanceTimersByTimeAsync(0);
    expect(createElement).toHaveBeenCalledWith('video');
    expect(video.src).toBe(signedUrl);
}

function expectReleased() {
    expect(video.pause).toHaveBeenCalledTimes(1);
    expect(video.play).not.toHaveBeenCalled();
    expect(video.removeAttribute).toHaveBeenCalledWith('src');
    expect(video.src).toBe('');
    expect(video.onloadedmetadata).toBeNull();
    expect(video.onloadeddata).toBeNull();
    expect(video.onseeked).toBeNull();
    expect(video.onerror).toBeNull();
    expect(video.load).toHaveBeenCalledTimes(2);
}

describe('external signed video preview lifetime', () => {
    it('keeps the exact signed GET URL, asks only for one size byte, then releases the decoder after the first small poster', async () => {
        const controller = new AbortController();
        const operation = loadExternalVideoPreview(signedUrl, controller.signal, publish);
        expect(fetchMock).toHaveBeenCalledWith(signedUrl, expect.objectContaining({
            headers: { Range: 'bytes=0-0' }, credentials: 'omit', cache: 'no-store', signal: expect.any(AbortSignal),
        }));
        expect(fetchMock.mock.calls[0][1].method).not.toBe('HEAD');
        expect(createElement).not.toHaveBeenCalled();
        expect(video.src).toBe('');
        await expectStarted();
        expect(video.preload).toBe('metadata');
        expect(video.muted).toBe(true);
        expect(video.crossOrigin).toBe('anonymous');
        firstFrame();
        expectReleased();
        const result = await operation;
        expect(result).toEqual({ status: 'ready', width: 1920, height: 1080, durationSeconds: 24.5, sizeBytes: 33554432, posterDataUrl: 'data:image/jpeg;base64,cG9zdGVy' });
        expect(canvas.width).toBe(320); expect(canvas.height).toBe(180);
        expect(cancelBody).toHaveBeenCalledTimes(1);
        expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(true);
        expect(document.body.appendChild).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
    });

    it('cancels a Range-ignoring response body and never starts a native decoder for that host', async () => {
        const response = { status: 200, headers: new Headers({ 'Content-Length': '33554432' }), body: { cancel: cancelBody }, arrayBuffer: vi.fn(), blob: vi.fn() };
        fetchMock.mockResolvedValueOnce(response);
        const operation = loadExternalVideoPreview(signedUrl, new AbortController().signal, publish);
        await expect(operation).resolves.toEqual({ status: 'unavailable', sizeBytes: 33554432 });
        expect(cancelBody).toHaveBeenCalledTimes(1);
        expect(response.arrayBuffer).not.toHaveBeenCalled();
        expect(response.blob).not.toHaveBeenCalled();
        expect(createElement).not.toHaveBeenCalled();
        expect(video.src).toBe('');
        expect(video.load).not.toHaveBeenCalled();
        expect(video.play).not.toHaveBeenCalled();
        expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(true);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('aborts both requests and decoder immediately when the last preview consumer leaves', async () => {
        const controller = new AbortController();
        const operation = loadExternalVideoPreview(signedUrl, controller.signal, publish);
        await expectStarted();
        const lateMetadata = video.onloadedmetadata;
        controller.abort();
        expectReleased();
        const countAfterAbort = publish.mock.calls.length;
        video.videoWidth = 1920; video.videoHeight = 1080; video.duration = 24.5;
        lateMetadata?.();
        await operation;
        expect(publish).toHaveBeenCalledTimes(countAfterAbort);
        expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(true);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('does not create a native decoder or make requests for an already cancelled probe', async () => {
        const controller = new AbortController(); controller.abort();
        await expect(loadExternalVideoPreview(signedUrl, controller.signal, publish)).resolves.toEqual({ status: 'unavailable' });
        expect(createElement).not.toHaveBeenCalled();
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('aborts a stalled size probe at the five-second total deadline without ever creating a decoder', async () => {
        fetchMock.mockImplementationOnce(() => new Promise(() => {}));
        const operation = loadExternalVideoPreview(signedUrl, new AbortController().signal, publish);
        await vi.advanceTimersByTimeAsync(5_000);
        await expect(operation).resolves.toEqual({ status: 'unavailable' });
        expect(createElement).not.toHaveBeenCalled();
        expect(video.src).toBe('');
        expect(video.load).not.toHaveBeenCalled();
        expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(true);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('includes time spent confirming Range in the native decoder deadline', async () => {
        fetchMock.mockImplementationOnce(() => new Promise(resolve => setTimeout(() => resolve({
            status: 206, headers: new Headers({ 'Content-Range': 'bytes 0-0/33554432' }), body: { cancel: cancelBody },
        }), 3_000)));
        const operation = loadExternalVideoPreview(signedUrl, new AbortController().signal, publish);
        await vi.advanceTimersByTimeAsync(2_999);
        expect(createElement).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        expect(createElement).toHaveBeenCalledWith('video');
        metadata();
        await vi.advanceTimersByTimeAsync(2_000);
        expectReleased();
        const result = await operation;
        expect(result.durationSeconds).toBe(24.5);
        expect(result.posterDataUrl).toBeUndefined();
        expect(result.sizeBytes).toBe(33554432);
        expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(true);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('keeps readable metadata but drops a CORS-tainted frame without retrying a second decoder', async () => {
        canvas.toDataURL.mockImplementationOnce(() => { throw new DOMException('Tainted canvas', 'SecurityError'); });
        const operation = loadExternalVideoPreview(signedUrl, new AbortController().signal, publish);
        await expectStarted();
        firstFrame();
        const result = await operation;
        expect(result).toMatchObject({ status: 'ready', width: 1920, height: 1080, durationSeconds: 24.5 });
        expect(result.posterDataUrl).toBeUndefined();
        expect(createElement.mock.calls.filter(([name]) => name === 'video')).toHaveLength(1);
        expectReleased();
    });

    it('releases the decoder on native failure and keeps any independently available original file size', async () => {
        const operation = loadExternalVideoPreview(signedUrl, new AbortController().signal, publish);
        await expectStarted();
        video.onerror?.();
        expectReleased();
        await expect(operation).resolves.toMatchObject({ status: 'unavailable', sizeBytes: 33554432 });
        expect(vi.getTimerCount()).toBe(0);
    });

    it('uses no size GET for an existing Blob and bounds retained poster data', async () => {
        canvas.toDataURL.mockReturnValueOnce('data:image/jpeg;base64,' + 'A'.repeat(190_000));
        const operation = loadExternalVideoPreview('blob:http://hapla.test/owned', new AbortController().signal, publish);
        firstFrame();
        const result = await operation;
        expect(fetchMock).not.toHaveBeenCalled();
        expect(result.status).toBe('ready');
        expect(result.posterDataUrl).toBeUndefined();
        expectReleased();
    });

    it('does not create a decoder after CORS rejects the signed Range request', async () => {
        fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
        await expect(loadExternalVideoPreview(signedUrl, new AbortController().signal, publish)).resolves.toEqual({ status: 'unavailable' });
        expect(createElement).not.toHaveBeenCalled();
        expect(video.src).toBe('');
        expect(video.load).not.toHaveBeenCalled();
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(true);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('cancels a late response after timeout without publishing metadata or creating a decoder', async () => {
        let finishResponse!: (response: unknown) => void;
        fetchMock.mockImplementationOnce(() => new Promise(resolve => { finishResponse = resolve; }));
        const operation = loadExternalVideoPreview(signedUrl, new AbortController().signal, publish);
        await vi.advanceTimersByTimeAsync(5_000);
        await expect(operation).resolves.toEqual({ status: 'unavailable' });
        finishResponse({ status: 206, headers: new Headers({ 'Content-Range': 'bytes 0-0/33554432' }), body: { cancel: cancelBody } });
        await vi.advanceTimersByTimeAsync(0);
        expect(cancelBody).toHaveBeenCalledTimes(1);
        expect(createElement).not.toHaveBeenCalled();
        expect(video.src).toBe('');
        expect(publish).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
    });
});
