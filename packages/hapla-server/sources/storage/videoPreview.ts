import { execFile } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { readFile, rename, stat, unlink, writeFile, mkdir } from 'node:fs/promises';
import * as path from 'node:path';

export type VideoPreview = {
    status: 'ready' | 'unavailable';
    durationSeconds: number | null;
    /** Original display dimensions, including the container's rotation. */
    width: number | null;
    height: number | null;
    aspectRatio: string | null;
    sizeBytes: number;
    posterDataUrl: string | null;
};

const SIDECAR_VERSION = 1;
const MAX_SIDECAR_BYTES = 384 * 1024;
const FAILED_PREVIEW_RETRY_MS = 60_000;
const DEMUXERS: Record<string, string> = {
    '.mp4': 'mov', '.mov': 'mov', '.m4v': 'mov', '.webm': 'matroska', '.ogv': 'ogg',
};

export class VideoPreviewBusyError extends Error {}

function positiveNumber(value: unknown): number | null {
    if (typeof value !== 'number' && typeof value !== 'string') return null;
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? number : null;
}

function greatestCommonDivisor(a: number, b: number): number {
    while (b) [a, b] = [b, a % b];
    return a;
}

export function parseVideoProbe(data: unknown): Pick<VideoPreview, 'durationSeconds' | 'width' | 'height' | 'aspectRatio'> {
    const probe = data as { streams?: Array<{ width?: unknown; height?: unknown; duration?: unknown; display_aspect_ratio?: unknown; tags?: { rotate?: unknown }; side_data_list?: Array<{ rotation?: unknown }> }>; format?: { duration?: unknown } } | null;
    const stream = Array.isArray(probe?.streams) ? probe.streams[0] : undefined;
    let width = positiveNumber(stream?.width);
    let height = positiveNumber(stream?.height);
    if (!Number.isInteger(width) || !Number.isInteger(height) || width! > 65536 || height! > 65536) width = height = null;
    const durationSeconds = positiveNumber(stream?.duration) ?? positiveNumber(probe?.format?.duration);
    let aspectRatio: string | null = null;
    if (width && height) {
        const declaredRatio = typeof stream?.display_aspect_ratio === 'string' ? /^(\d{1,6}):(\d{1,6})$/.exec(stream.display_aspect_ratio) : null;
        let numerator = declaredRatio && positiveNumber(declaredRatio[1]) && positiveNumber(declaredRatio[2]) ? Number(declaredRatio[1]) : width;
        let denominator = declaredRatio && positiveNumber(declaredRatio[1]) && positiveNumber(declaredRatio[2]) ? Number(declaredRatio[2]) : height;
        const rotationValue = (Array.isArray(stream?.side_data_list) ? stream.side_data_list.find(item => item?.rotation !== undefined)?.rotation : undefined) ?? stream?.tags?.rotate;
        const rotation = typeof rotationValue === 'number' || typeof rotationValue === 'string' ? Number(rotationValue) : 0;
        if (Number.isFinite(rotation) && Math.abs(Math.round(rotation)) % 180 === 90) {
            [width, height] = [height, width];
            [numerator, denominator] = [denominator, numerator];
        }
        const divisor = greatestCommonDivisor(numerator, denominator);
        aspectRatio = `${numerator / divisor}:${denominator / divisor}`;
    }
    return { durationSeconds, width, height, aspectRatio };
}

function runTool(command: string, args: string[], timeout: number): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        execFile(command, args, { encoding: 'buffer', timeout, killSignal: 'SIGKILL', maxBuffer: 256 * 1024, windowsHide: true }, (error, stdout) => {
            if (error) reject(error);
            else resolve(stdout);
        });
    });
}

// One expensive probe per source, at most two processes at a time, and a
// bounded queue. Loading a long transcript must not start a process per card.
const inFlight = new Map<string, Promise<VideoPreview>>();
const waiting: Array<() => void> = [];
let active = 0;

async function withProbeSlot<T>(work: () => Promise<T>): Promise<T> {
    if (active >= 2) {
        if (waiting.length >= 16) throw new VideoPreviewBusyError('Video preview queue is full');
        await new Promise<void>(resolve => waiting.push(resolve));
    } else active += 1;
    try { return await work(); }
    finally {
        const next = waiting.shift();
        if (next) next();
        else active -= 1;
    }
}

type Sidecar = { version: number; size: number; mtimeMs: number; createdAt: number; preview: VideoPreview };

async function readSidecar(sidecarPath: string, size: number, mtimeMs: number): Promise<VideoPreview | null> {
    try {
        const sidecarStat = await stat(sidecarPath);
        if (!sidecarStat.isFile() || sidecarStat.size > MAX_SIDECAR_BYTES) return null;
        const cached = JSON.parse(await readFile(sidecarPath, 'utf8')) as Sidecar;
        if (cached.version !== SIDECAR_VERSION || cached.size !== size || cached.mtimeMs !== mtimeMs || cached.preview?.sizeBytes !== size) return null;
        if (cached.preview.status === 'unavailable' && Date.now() - cached.createdAt > FAILED_PREVIEW_RETRY_MS) return null;
        if (!['ready', 'unavailable'].includes(cached.preview.status)) return null;
        return cached.preview;
    } catch { return null; }
}

async function writeSidecar(sidecarPath: string, value: Sidecar): Promise<void> {
    const temporary = `${sidecarPath}.${randomUUID()}.tmp`;
    try {
        await writeFile(temporary, JSON.stringify(value), { mode: 0o600, flag: 'wx' });
        await rename(temporary, sidecarPath);
    } catch { /* A read-only files mount should still permit a one-off preview. */ }
    finally { await unlink(temporary).catch(() => {}); }
}

/** Call only after checking ownership and resolving the path inside files/. */
export async function getVideoPreview(fullPath: string, options?: { name: string; cacheDirectory: string }): Promise<VideoPreview | null> {
    const file = await stat(fullPath).catch(() => null);
    if (!file?.isFile()) return null;
    if (options) await mkdir(options.cacheDirectory, { recursive: true });
    const sidecarPath = options ? path.join(options.cacheDirectory, createHash('sha256').update(fullPath + '\0' + options.name).digest('hex') + '.json') : `${fullPath}.hapla-video-preview-v${SIDECAR_VERSION}.json`;
    const cached = await readSidecar(sidecarPath, file.size, file.mtimeMs);
    if (cached) return cached;
    const existing = inFlight.get(fullPath);
    if (existing) return existing;
    const pending = withProbeSlot(async () => {
        let preview: VideoPreview = { status: 'unavailable', durationSeconds: null, width: null, height: null, aspectRatio: null, sizeBytes: file.size, posterDataUrl: null };
        const demuxer = DEMUXERS[path.extname(options?.name ?? fullPath).toLowerCase()];
        if (demuxer) {
            // Force the expected container and allow only local file/pipe I/O.
            // A renamed HLS/concat playlist can never access network services
            // or redirect the decoder to another arbitrary input format.
            const input = ['-protocol_whitelist', 'file,pipe', '-f', demuxer, '-i', fullPath];
            try {
                const probe = await runTool('ffprobe', ['-v', 'error', '-threads', '1', ...input, '-select_streams', 'v:0', '-show_entries', 'stream=width,height,duration,display_aspect_ratio:stream_tags=rotate:stream_side_data=rotation:format=duration', '-of', 'json'], 8_000);
                preview = { ...preview, ...parseVideoProbe(JSON.parse(probe.toString('utf8'))) };
                if (preview.width && preview.height) {
                    const seek = Math.min(3, (preview.durationSeconds ?? 0) * 0.1);
                    const [ratioWidth, ratioHeight] = preview.aspectRatio!.split(':').map(Number);
                    const displayWidth = preview.height * ratioWidth / ratioHeight;
                    const scale = Math.min(1, 320 / displayWidth, 180 / preview.height);
                    const posterWidth = Math.max(1, Math.round(displayWidth * scale));
                    const posterHeight = Math.max(1, Math.round(preview.height * scale));
                    const poster = await runTool('ffmpeg', ['-nostdin', '-v', 'error', '-threads', '1', '-ss', String(seek), ...input, '-map', '0:v:0', '-frames:v', '1', '-an', '-sn', '-dn', '-vf', `scale=${posterWidth}:${posterHeight},setsar=1`, '-threads', '1', '-q:v', '7', '-f', 'image2pipe', '-vcodec', 'mjpeg', 'pipe:1'], 12_000);
                    if (poster.length > 0 && poster.length <= 128 * 1024 && poster[0] === 0xff && poster[1] === 0xd8) {
                        preview = { ...preview, status: 'ready', posterDataUrl: `data:image/jpeg;base64,${poster.toString('base64')}` };
                    }
                }
            } catch { /* Unsupported/corrupt media or missing tools: return size and any metadata already probed. */ }
        }
        await writeSidecar(sidecarPath, { version: SIDECAR_VERSION, size: file.size, mtimeMs: file.mtimeMs, createdAt: Date.now(), preview });
        return preview;
    });
    inFlight.set(fullPath, pending);
    try { return await pending; }
    finally { if (inFlight.get(fullPath) === pending) inFlight.delete(fullPath); }
}
