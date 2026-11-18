import { stat } from 'node:fs/promises';
import type { Stats } from 'node:fs';
import sharp from 'sharp';

const MAX_PIXELS = 40_000_000;
const MAX_BYTES = 256 * 1024;
const MAX_DIMENSION = 1280;
const MAX_ENTRIES = 64;
const MAX_CACHE_BYTES = 20 * 1024 * 1024;
const FORMATS = new Set(['jpeg', 'png', 'webp', 'gif', 'heif', 'avif', 'tiff']);

export type ImagePreview = { data: Buffer; contentType: 'image/jpeg'; width: number; height: number };
export class ImagePreviewBusyError extends Error {}
export class ImagePreviewError extends Error {
    constructor(message: string, public readonly statusCode: 409 | 415 | 422) { super(message); }
}

const cache = new Map<string, ImagePreview>();
const inFlight = new Map<string, Promise<ImagePreview>>();
const waiting: Array<() => void> = [];
let cacheBytes = 0;
let active = 0;

function version(file: Stats): string {
    return [file.dev, file.ino, file.size, file.mtimeMs, file.ctimeMs].join(':');
}
async function fileInfo(fullPath: string): Promise<Stats | null> {
    try { const file = await stat(fullPath); return file.isFile() ? file : null; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}
async function unchanged(fullPath: string, expected: string): Promise<void> {
    const file = await fileInfo(fullPath);
    if (!file || version(file) !== expected) throw new ImagePreviewError('图片已发生变化，请重新打开预览', 409);
}
async function withSlot<T>(work: () => Promise<T>): Promise<T> {
    if (active >= 2) await new Promise<void>(resolve => waiting.push(resolve));
    else active += 1;
    try { return await work(); }
    finally {
        const next = waiting.shift();
        if (next) next();
        else active -= 1;
    }
}

async function render(fullPath: string): Promise<ImagePreview> {
    // A file-backed decoder avoids reading the entire original into a JS
    // Buffer. Only one raster frame is decoded and the output is always JPEG.
    const image = sharp(fullPath, { limitInputPixels: MAX_PIXELS, sequentialRead: true, animated: false, failOn: 'warning' });
    const metadata = await image.metadata();
    if (!metadata.format || !FORMATS.has(metadata.format)) throw new ImagePreviewError('此文件不支持图片缩略预览', 415);
    if (!metadata.width || !metadata.height || metadata.width * metadata.height > MAX_PIXELS) throw new ImagePreviewError('图片尺寸超出预览范围，可下载原图', 422);
    let output = await image.rotate().resize({ width: MAX_DIMENSION, height: MAX_DIMENSION, fit: 'inside', withoutEnlargement: true })
        .flatten({ background: '#ffffff' }).jpeg({ quality: 72 }).timeout({ seconds: 15 }).toBuffer({ resolveWithObject: true });
    // Dense/noisy images can exceed the byte cap even after resizing. Further
    // encoding works on the already bounded preview, never on another copy of
    // the original, and cannot expose a partially encoded or truncated image.
    for (const [width, quality] of [[1280, 62], [1024, 58], [768, 52], [512, 45]]) {
        if (output.data.length <= MAX_BYTES) break;
        output = await sharp(output.data).resize({ width, height: width, fit: 'inside', withoutEnlargement: true })
            .jpeg({ quality }).timeout({ seconds: 5 }).toBuffer({ resolveWithObject: true });
    }
    if (!output.data.length || output.data.length > MAX_BYTES) throw new ImagePreviewError('无法生成受限大小的预览，可下载原图', 422);
    return { data: output.data, contentType: 'image/jpeg', width: output.info.width, height: output.info.height };
}

/** Call only after account ownership and the files-directory boundary checks. */
export async function getImagePreview(fullPath: string): Promise<ImagePreview | null> {
    const file = await fileInfo(fullPath);
    if (!file) return null;
    const expected = version(file);
    const key = `${fullPath}\0${expected}`;
    const cached = cache.get(key);
    if (cached) { cache.delete(key); cache.set(key, cached); return cached; }
    const existing = inFlight.get(key);
    if (existing) return existing;
    if (inFlight.size >= 18) throw new ImagePreviewBusyError('Image preview queue is full');
    const pending = withSlot(async () => {
        await unchanged(fullPath, expected);
        let result: ImagePreview;
        try { result = await render(fullPath); }
        catch (error) {
            if (error instanceof ImagePreviewError) throw error;
            throw new ImagePreviewError('图片无法解码，请重试或下载原图', 422);
        }
        await unchanged(fullPath, expected);
        cache.set(key, result); cacheBytes += result.data.length;
        while (cache.size > MAX_ENTRIES || cacheBytes > MAX_CACHE_BYTES) {
            const oldest = cache.keys().next().value!;
            cacheBytes -= cache.get(oldest)!.data.length; cache.delete(oldest);
        }
        return result;
    });
    inFlight.set(key, pending);
    try { return await pending; }
    finally { if (inFlight.get(key) === pending) inFlight.delete(key); }
}
