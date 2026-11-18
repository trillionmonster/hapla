import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseVideoProbe, VideoPreviewLimiter, WorkspaceVideoPreviewManager } from './workspaceVideoPreview';

const PROBE = Buffer.from(JSON.stringify({ streams: [{ width: 1920, height: 1080, duration: '8.25' }], format: { duration: '8.5' } }));
const POSTER = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);

describe('workspace video preview', () => {
    let directory: string;
    let workspace: string;
    beforeEach(async () => {
        directory = await mkdtemp(join(tmpdir(), 'hapla-video-preview-'));
        workspace = join(directory, 'workspace');
        await mkdir(workspace);
        await writeFile(join(workspace, 'sample.mp4'), Buffer.alloc(1024));
    });
    afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

    it('returns source metadata and a small JPEG, never video bytes', async () => {
        const run = vi.fn(async (program: string) => program === 'ffprobe' ? PROBE : POSTER);
        const manager = new WorkspaceVideoPreviewManager(workspace, run);
        expect(await manager.getPreview('sample.mp4')).toEqual({
            success: true, status: 'ready', width: 1920, height: 1080,
            aspectRatio: '16:9', durationSeconds: 8.25, sizeBytes: 1024,
            posterDataUrl: 'data:image/jpeg;base64,/9j/2Q==',
        });
        const calls = run.mock.calls as unknown as Array<[string, string[], number]>;
        expect(calls[0][1]).toContain('file,pipe');
        expect(calls[0][1]).toContain('mov,matroska,webm,avi,ogg,flv,mpeg,mpegvideo,mpegts,asf');
        expect(calls[1][1]).toContain("scale=w='min(320,iw)':h='min(320,ih)':force_original_aspect_ratio=decrease");
        expect(calls.map((call) => call[2])).toEqual([6000, 10000]);
        expect(calls[0][1].at(-1)).toBe(join(workspace, 'sample.mp4'));
        expect(calls[1][1].slice(-2)).toEqual(['image2pipe', 'pipe:1']);
    });

    it('uses rotation for display dimensions and falls back to container duration', () => {
        expect(parseVideoProbe(Buffer.from(JSON.stringify({ streams: [{ width: 1920, height: 1080, duration: 'N/A', side_data_list: [{ rotation: -90 }] }], format: { duration: '12.04' } })))).toEqual({
            width: 1080, height: 1920, aspectRatio: '9:16', durationSeconds: 12.04,
        });
    });

    it('rejects missing streams and nonfinite dimensions', () => {
        expect(() => parseVideoProbe(Buffer.from('{"streams":[]}'))).toThrow('no readable video');
        expect(() => parseVideoProbe(Buffer.from('{"streams":[{"width":"Infinity","height":1080}]}'))).toThrow('no readable video');
    });

    it('does not invoke media tools for traversal, escaping symlinks, URLs, directories or invalid input', async () => {
        await writeFile(join(directory, 'private.mp4'), 'private');
        await symlink(join(directory, 'private.mp4'), join(workspace, 'escape.mp4'));
        await mkdir(join(workspace, 'directory.mp4'));
        const run = vi.fn(async () => PROBE);
        const manager = new WorkspaceVideoPreviewManager(workspace, run);
        for (const path of ['../private.mp4', 'escape.mp4', 'https://example.com/movie.mp4', 'directory.mp4', 'playlist.m3u8', null, '', 'sample.mp4\0junk']) {
            expect(await manager.getPreview(path)).toMatchObject({ success: false });
        }
        expect(run).not.toHaveBeenCalled();
    });

    it('retains original size when ffprobe is unavailable', async () => {
        const run = vi.fn(async () => { throw new Error('ffprobe is not installed'); });
        const manager = new WorkspaceVideoPreviewManager(workspace, run);
        expect(await manager.getPreview('sample.mp4')).toEqual({ success: true, status: 'unavailable', sizeBytes: 1024, error: 'ffprobe is not installed' });
        expect(run).toHaveBeenCalledTimes(1);
    });

    it('retains probed dimensions and duration if only the cover cannot be generated', async () => {
        const run = vi.fn(async (program: string) => {
            if (program === 'ffprobe') return PROBE;
            throw new Error('ffmpeg is not installed');
        });
        expect(await new WorkspaceVideoPreviewManager(workspace, run).getPreview('sample.mp4')).toMatchObject({
            success: true, status: 'unavailable', sizeBytes: 1024,
            width: 1920, height: 1080, durationSeconds: 8.25, error: 'ffmpeg is not installed',
        });
    });

    it('rejects oversized or invalid poster output', async () => {
        for (const poster of [Buffer.alloc(0), Buffer.alloc(97 * 1024, 0xff), Buffer.from('not a JPEG')]) {
            const run = vi.fn(async (program: string) => program === 'ffprobe' ? PROBE : poster);
            const result = await new WorkspaceVideoPreviewManager(workspace, run).getPreview('sample.mp4');
            expect(result).toMatchObject({ success: true, status: 'unavailable' });
            expect(result).not.toHaveProperty('posterDataUrl');
        }
    });

    it('coalesces concurrent requests and reuses thumbnails until the source changes', async () => {
        const run = vi.fn(async (program: string) => program === 'ffprobe' ? PROBE : POSTER);
        const manager = new WorkspaceVideoPreviewManager(workspace, run);
        const [first, second] = await Promise.all([manager.getPreview('sample.mp4'), manager.getPreview('sample.mp4')]);
        expect(first).toEqual(second);
        await manager.getPreview('sample.mp4');
        expect(run).toHaveBeenCalledTimes(2);
        await writeFile(join(workspace, 'sample.mp4'), Buffer.alloc(2048));
        expect(await manager.getPreview('sample.mp4')).toMatchObject({ sizeBytes: 2048 });
        expect(run).toHaveBeenCalledTimes(4);
    });

    it('does not return a stale cover if the source changes during probing', async () => {
        const run = vi.fn(async (program: string) => {
            if (program === 'ffprobe') return PROBE;
            await writeFile(join(workspace, 'sample.mp4'), 'new version');
            return POSTER;
        });
        expect(await new WorkspaceVideoPreviewManager(workspace, run).getPreview('sample.mp4')).toMatchObject({
            success: true, status: 'unavailable', sizeBytes: 11, error: expect.stringContaining('changed'),
        });
    });
});

describe('video decoder budget', () => {
    it('limits concurrent jobs and bounds pending work', async () => {
        const limiter = new VideoPreviewLimiter(2, 1, 1000);
        const releases: Array<() => void> = [];
        let active = 0;
        let maximum = 0;
        const task = () => limiter.run(async () => {
            maximum = Math.max(maximum, ++active);
            await new Promise<void>((resolve) => { releases.push(resolve); });
            active--;
            return 'complete';
        });
        const first = task();
        const second = task();
        const third = task();
        await expect(task()).rejects.toThrow('busy');
        expect(active).toBe(2);
        releases.shift()!();
        await first;
        await Promise.resolve();
        expect(active).toBe(2);
        releases.shift()!();
        releases.shift()!();
        expect(await Promise.all([second, third])).toEqual(['complete', 'complete']);
        expect(maximum).toBe(2);
    });

    it('expires queued requests and releases the slot after a failing job', async () => {
        const limiter = new VideoPreviewLimiter(1, 1, 5);
        let release!: () => void;
        const first = limiter.run(async () => { await new Promise<void>((resolve) => { release = resolve; }); });
        await expect(limiter.run(async () => 'queued')).rejects.toThrow('busy');
        release();
        await first;
        await expect(limiter.run(async () => { throw new Error('decoder failed'); })).rejects.toThrow('decoder failed');
        await expect(limiter.run(async () => 'next')).resolves.toBe('next');
    });
});
