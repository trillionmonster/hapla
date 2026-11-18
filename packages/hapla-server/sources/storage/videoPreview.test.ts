import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getVideoPreview, parseVideoProbe, VideoPreviewBusyError } from './videoPreview';

const mocks = vi.hoisted(() => ({ exec: vi.fn() }));
vi.mock('node:child_process', () => ({ execFile: mocks.exec }));
const directories: string[] = [];
const probe = { streams: [{ width: 1920, height: 1080, display_aspect_ratio: '16:9' }], format: { duration: '12.5' } };
const jpeg = Buffer.from([0xff, 0xd8, 1, 2, 3, 0xff, 0xd9]);

async function fixture(name = 'video.mp4') {
    const directory = await mkdtemp(path.join(tmpdir(), 'hapla-video-preview-'));
    directories.push(directory);
    const file = path.join(directory, name);
    await writeFile(file, Buffer.alloc(1234));
    return file;
}

afterEach(async () => {
    vi.clearAllMocks();
    await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

describe('video probe interpretation', () => {
    it('keeps original resolution and duration while rotating display geometry', () => {
        expect(parseVideoProbe(probe)).toEqual({ width: 1920, height: 1080, durationSeconds: 12.5, aspectRatio: '16:9' });
        expect(parseVideoProbe({ ...probe, streams: [{ ...probe.streams[0], side_data_list: [{ rotation: -90 }] }] })).toEqual({ width: 1080, height: 1920, durationSeconds: 12.5, aspectRatio: '9:16' });
        expect(parseVideoProbe({ streams: [{ width: 720, height: 576, display_aspect_ratio: '16:9' }] }).aspectRatio).toBe('16:9');
    });

    it('does not invent dimensions or duration for malformed metadata', () => {
        expect(parseVideoProbe(null)).toEqual({ width: null, height: null, durationSeconds: null, aspectRatio: null });
        expect(parseVideoProbe({ streams: [{ width: -1, height: 'Infinity', duration: 'N/A' }], format: { duration: 'NaN' } })).toEqual({ width: null, height: null, durationSeconds: null, aspectRatio: null });
    });
});

describe('server-side video previews', () => {
    it('deduplicates probes, persists only a tiny sidecar, and returns the exact original byte size', async () => {
        const file = await fixture();
        mocks.exec.mockImplementation((command, _args, options, callback) => {
            expect(options.timeout).toBeLessThanOrEqual(12000);
            expect(options.maxBuffer).toBe(256 * 1024);
            setTimeout(() => callback(null, command === 'ffprobe' ? Buffer.from(JSON.stringify(probe)) : jpeg), 5);
        });
        const [first, same] = await Promise.all([getVideoPreview(file), getVideoPreview(file)]);
        expect(first).toEqual(same);
        expect(first).toMatchObject({ status: 'ready', width: 1920, height: 1080, aspectRatio: '16:9', sizeBytes: 1234, durationSeconds: 12.5, posterDataUrl: `data:image/jpeg;base64,${jpeg.toString('base64')}` });
        expect(mocks.exec).toHaveBeenCalledTimes(2);
        for (const [, args] of mocks.exec.mock.calls) {
            expect(args.slice(args.indexOf('-protocol_whitelist'), args.indexOf('-protocol_whitelist') + 2)).toEqual(['-protocol_whitelist', 'file,pipe']);
            expect(args.slice(args.indexOf('-f'), args.indexOf('-f') + 2)).toEqual(['-f', 'mov']);
        }
        const posterArgs = mocks.exec.mock.calls.find(call => call[0] === 'ffmpeg')![1];
        expect(posterArgs).toContain('scale=320:180,setsar=1');
        expect(await getVideoPreview(file)).toEqual(first);
        expect(mocks.exec).toHaveBeenCalledTimes(2);
        expect((await readFile(`${file}.hapla-video-preview-v1.json`)).byteLength).toBeLessThan(2048);
        expect((await readFile(file)).byteLength).toBe(1234);
    });

    it('invalidates sidecars when the source changes and gracefully reports unsupported media', async () => {
        const file = await fixture();
        mocks.exec.mockImplementation((_command, _args, _options, callback) => callback(new Error('Invalid container')));
        expect(await getVideoPreview(file)).toMatchObject({ status: 'unavailable', sizeBytes: 1234, posterDataUrl: null, durationSeconds: null });
        expect(await getVideoPreview(file)).toMatchObject({ status: 'unavailable' });
        expect(mocks.exec).toHaveBeenCalledTimes(1);
        await writeFile(file, Buffer.alloc(4000));
        expect(await getVideoPreview(file)).toMatchObject({ status: 'unavailable', sizeBytes: 4000 });
        expect(mocks.exec).toHaveBeenCalledTimes(2);
        expect(await getVideoPreview(`${file}.missing`)).toBeNull();
    });

    it('bounds concurrent process creation and rejects excess queued work', async () => {
        const files = await Promise.all(Array.from({ length: 20 }, (_, index) => fixture(`${index}.mp4`)));
        const callbacks: Array<() => void> = [];
        let running = 0;
        let maximumRunning = 0;
        mocks.exec.mockImplementation((_command, _args, _options, callback) => {
            running += 1;
            maximumRunning = Math.max(maximumRunning, running);
            callbacks.push(() => { running -= 1; callback(new Error('Test stop')); });
        });
        const requests = files.map(file => getVideoPreview(file).catch(error => error));
        await vi.waitFor(() => expect(callbacks.length).toBe(2));
        for (let index = 0; index < 9; index += 1) {
            await vi.waitFor(() => expect(callbacks.length).toBe(2));
            callbacks.splice(0).forEach(callback => callback());
        }
        const outcomes = await Promise.all(requests);
        expect(maximumRunning).toBe(2);
        expect(outcomes.filter(value => value instanceof VideoPreviewBusyError)).toHaveLength(2);
        expect(outcomes.filter(value => value?.status === 'unavailable')).toHaveLength(18);
    });
});
