import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import sharp, { type Sharp } from 'sharp';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getImagePreview, ImagePreviewBusyError, ImagePreviewError } from './imagePreview';

const directories: string[] = [];
async function fixture(data?: Buffer, name = 'image.png') {
    const directory = await mkdtemp(path.join(tmpdir(), 'hapla-image-preview-'));
    directories.push(directory);
    const file = path.join(directory, name);
    await writeFile(file, data ?? await sharp({ create: { width: 32, height: 16, channels: 3, background: 'red' } }).png().toBuffer());
    return file;
}
afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

describe('bounded stored image previews', () => {
    it('returns a decodable JPEG under 256 KiB and 1280px from a large noisy PNG', async () => {
        const original = await sharp(randomBytes(2048 * 1536 * 3), { raw: { width: 2048, height: 1536, channels: 3 } }).png().toBuffer();
        expect(original.length).toBeGreaterThan(1024 * 1024);
        const file = await fixture(original);
        const preview = await getImagePreview(file);
        expect(preview?.contentType).toBe('image/jpeg');
        expect(preview!.data.length).toBeLessThanOrEqual(256 * 1024);
        const decoded = await sharp(preview!.data).metadata();
        expect(decoded.format).toBe('jpeg');
        expect(decoded.width).toBeLessThanOrEqual(1280);
        expect(decoded.height).toBeLessThanOrEqual(1280);
        expect(decoded.width! / decoded.height!).toBeCloseTo(4 / 3, 2);
        expect(preview).toMatchObject({ width: decoded.width, height: decoded.height });
    });

    it('applies EXIF orientation and strips the old orientation from the preview', async () => {
        const original = await sharp({ create: { width: 1600, height: 800, channels: 3, background: 'blue' } })
            .jpeg().withMetadata({ orientation: 6 }).toBuffer();
        const preview = await getImagePreview(await fixture(original, 'rotated.jpg'));
        expect(preview).toMatchObject({ width: 640, height: 1280 });
        const metadata = await sharp(preview!.data).metadata();
        expect(metadata.orientation).toBeUndefined();
    });

    it('deduplicates concurrent requests and invalidates cached previews when the original changes', async () => {
        const file = await fixture();
        const toBuffer = vi.spyOn(sharp.prototype, 'toBuffer');
        const [first, second] = await Promise.all([getImagePreview(file), getImagePreview(file)]);
        expect(first).toBe(second);
        expect(toBuffer).toHaveBeenCalledTimes(1);
        expect(await getImagePreview(file)).toBe(first);
        expect(toBuffer).toHaveBeenCalledTimes(1);
        const replacement = await sharp({ create: { width: 80, height: 120, channels: 3, background: 'green' } }).png().toBuffer();
        toBuffer.mockClear();
        await writeFile(file, replacement);
        const changed = await getImagePreview(file);
        expect(changed).not.toBe(first);
        expect(changed).toMatchObject({ width: 80, height: 120 });
        expect(toBuffer).toHaveBeenCalledTimes(1);
    });

    it('rejects SVG disguised as raster data, corrupt data, and input pixel bombs without returning source bytes', async () => {
        const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect width="100" height="100" fill="red"/></svg>');
        const file = await fixture(svg);
        const toBuffer = vi.spyOn(sharp.prototype, 'toBuffer');
        await expect(getImagePreview(file)).rejects.toMatchObject({ statusCode: 415 });
        expect(toBuffer).not.toHaveBeenCalled();
        await writeFile(file, 'not an image');
        await expect(getImagePreview(file)).rejects.toMatchObject({ statusCode: 422 });
        // Metadata can claim huge dimensions without allocating those pixels.
        const metadata = vi.spyOn(sharp.prototype, 'metadata').mockResolvedValue({ format: 'png', width: 10_000, height: 10_000 } as any);
        await expect(getImagePreview(file)).rejects.toMatchObject({ statusCode: 422 });
        expect(toBuffer).not.toHaveBeenCalled();
        metadata.mockRestore();
    });

    it('discards results if the source changes while it is being decoded', async () => {
        const file = await fixture();
        const actual = sharp.prototype.toBuffer;
        const spy = vi.spyOn(sharp.prototype, 'toBuffer').mockImplementation(async function(this: Sharp, ...args: any[]) {
            const result = await (actual as any).apply(this, args);
            await writeFile(file, 'new source written while decoding');
            return result;
        } as any);
        await expect(getImagePreview(file)).rejects.toMatchObject({ statusCode: 409 });
        spy.mockRestore();
        await expect(getImagePreview(file)).rejects.toBeInstanceOf(ImagePreviewError);
    });

    it('bounds expensive image work to two decoders and rejects excess queued work', async () => {
        const data = await sharp({ create: { width: 10, height: 10, channels: 3, background: 'white' } }).png().toBuffer();
        const files = await Promise.all(Array.from({ length: 20 }, () => fixture(data)));
        const actual = sharp.prototype.toBuffer;
        const release: Array<() => void> = [];
        let running = 0, peak = 0;
        vi.spyOn(sharp.prototype, 'toBuffer').mockImplementation(async function(this: Sharp, ...args: any[]) {
            running++; peak = Math.max(peak, running);
            await new Promise<void>(resolve => release.push(resolve));
            try { return await (actual as any).apply(this, args); }
            finally { running--; }
        } as any);
        const pending = files.map(file => getImagePreview(file).catch(error => error));
        for (let batch = 0; batch < 9; batch++) {
            await vi.waitFor(() => expect(release.length).toBe(2));
            release.splice(0).forEach(done => done());
        }
        const results = await Promise.all(pending);
        expect(peak).toBe(2);
        expect(results.filter(result => result instanceof ImagePreviewBusyError)).toHaveLength(2);
        expect(results.filter(result => result?.contentType === 'image/jpeg')).toHaveLength(18);
    });

    it('evicts old thumbnails after 64 entries instead of growing with the entire conversation', async () => {
        const data = await sharp({ create: { width: 10, height: 10, channels: 3, background: 'white' } }).png().toBuffer();
        const files = await Promise.all(Array.from({ length: 65 }, () => fixture(data)));
        const first = await getImagePreview(files[0]);
        let latest;
        for (const file of files.slice(1)) latest = await getImagePreview(file);
        expect(await getImagePreview(files[64])).toBe(latest);
        expect(await getImagePreview(files[0])).not.toBe(first);
        expect(await getImagePreview(files[0] + '.missing')).toBeNull();
    });
});
