import { execFile } from 'node:child_process';
import { realpath, stat } from 'node:fs/promises';
import { extname } from 'node:path';
import { validatePath } from './pathSecurity';

export type WorkspaceVideoPreviewResult = {
    success: true;
    status: 'ready' | 'unavailable';
    durationSeconds?: number;
    width?: number;
    height?: number;
    aspectRatio?: string;
    sizeBytes: number;
    posterDataUrl?: string;
    error?: string;
} | { success: false; error: string };

type ProcessRunner = (program: 'ffprobe' | 'ffmpeg', args: string[], timeout: number) => Promise<Buffer>;
const VIDEO_EXTENSIONS = new Set(['.mp4', '.m4v', '.mov', '.webm', '.mkv', '.avi', '.ogv', '.mpeg', '.mpg', '.ts', '.mts', '.m2ts', '.wmv', '.flv']);
// Do not let an uploaded playlist or a container URL open network resources.
// The demuxer allowlist also excludes manifests that reference other local files.
const INPUT_OPTIONS = [
    '-protocol_whitelist', 'file,pipe',
    '-format_whitelist', 'mov,matroska,webm,avi,ogg,flv,mpeg,mpegvideo,mpegts,asf',
    '-probesize', '8388608', '-analyzeduration', '5000000',
];
const CACHE_LIMIT = 64;
const MAX_POSTER_BYTES = 96 * 1024;

export const runVideoPreviewProcess: ProcessRunner = (program, args, timeout) => new Promise((resolve, reject) => {
    execFile(program, args, {
        encoding: 'buffer', timeout, killSignal: 'SIGKILL', maxBuffer: 128 * 1024,
        windowsHide: true,
    }, (error, stdout) => {
        if (error) {
            const code = (error as NodeJS.ErrnoException).code;
            reject(new Error(code === 'ENOENT' ? `${program} is not installed on the file's machine` : 'Video preview could not be generated'));
        } else {
            resolve(stdout);
        }
    });
});

/** All sessions in a CLI process share this bounded decoder budget. */
export class VideoPreviewLimiter {
    private active = 0;
    private readonly waiting: Array<() => void> = [];

    constructor(private readonly limit = 2, private readonly maxWaiting = 8, private readonly waitMs = 10_000) {}

    async run<T>(task: () => Promise<T>): Promise<T> {
        if (this.active >= this.limit) {
            if (this.waiting.length >= this.maxWaiting) throw new Error('Video preview is busy; retry shortly');
            await new Promise<void>((resolve, reject) => {
                const start = () => { clearTimeout(timer); resolve(); };
                const timer = setTimeout(() => {
                    const index = this.waiting.indexOf(start);
                    if (index !== -1) this.waiting.splice(index, 1);
                    reject(new Error('Video preview is busy; retry shortly'));
                }, this.waitMs);
                timer.unref?.();
                this.waiting.push(start);
            });
        } else {
            this.active++;
        }
        try {
            return await task();
        } finally {
            const next = this.waiting.shift();
            if (next) next();
            else this.active--;
        }
    }
}

const decoderBudget = new VideoPreviewLimiter();

function positiveNumber(value: unknown): number | undefined {
    const result = typeof value === 'number' || typeof value === 'string' ? Number(value) : NaN;
    return Number.isFinite(result) && result > 0 ? result : undefined;
}

function aspectRatio(width: number, height: number): string {
    let a = width;
    let b = height;
    while (b) [a, b] = [b, a % b];
    return `${width / a}:${height / a}`;
}

export function parseVideoProbe(output: Buffer): Pick<Extract<WorkspaceVideoPreviewResult, { success: true }>, 'durationSeconds' | 'width' | 'height' | 'aspectRatio'> {
    const data = JSON.parse(output.toString('utf8'));
    const stream = data.streams?.[0];
    let width = positiveNumber(stream?.width);
    let height = positiveNumber(stream?.height);
    if (!width || !height || !Number.isInteger(width) || !Number.isInteger(height)) throw new Error('The file has no readable video stream');
    const rotation = Number(stream.side_data_list?.find((value: { rotation?: unknown }) => value.rotation !== undefined)?.rotation ?? stream.tags?.rotate ?? 0);
    if (Number.isFinite(rotation) && Math.abs(rotation % 180) === 90) [width, height] = [height, width];
    return {
        width, height, aspectRatio: aspectRatio(width, height),
        durationSeconds: positiveNumber(stream.duration) ?? positiveNumber(data.format?.duration),
    };
}

/** Keeps small thumbnails only; video bytes are never read into JavaScript. */
export class WorkspaceVideoPreviewManager {
    private readonly cache = new Map<string, { version: string; expires: number; result: WorkspaceVideoPreviewResult }>();
    private readonly pending = new Map<string, Promise<WorkspaceVideoPreviewResult>>();

    constructor(
        private readonly workingDirectory: string,
        private readonly runProcess: ProcessRunner = runVideoPreviewProcess,
        private readonly limiter = decoderBudget,
    ) {}

    async getPreview(requestedPath: unknown): Promise<WorkspaceVideoPreviewResult> {
        if (typeof requestedPath !== 'string' || !requestedPath || requestedPath.length > 4096 || requestedPath.includes('\0')) {
            return { success: false, error: 'A valid workspace video path is required' };
        }
        const validation = validatePath(requestedPath, this.workingDirectory);
        if (!validation.valid) return { success: false, error: validation.error! };
        if (!VIDEO_EXTENSIONS.has(extname(requestedPath).toLowerCase())) return { success: false, error: 'The selected path is not a supported video file' };
        try {
            const [root, resolvedPath] = await Promise.all([realpath(this.workingDirectory), realpath(validation.resolvedPath!)]);
            const resolvedValidation = validatePath(resolvedPath, root);
            if (!resolvedValidation.valid) return { success: false, error: 'Access denied: resolved path is outside the working directory' };
            const info = await stat(resolvedPath);
            if (!info.isFile()) return { success: false, error: 'The selected path is not a regular file' };
            const version = `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
            const cached = this.cache.get(resolvedPath);
            if (cached && cached.version === version && cached.expires > Date.now()) {
                this.cache.delete(resolvedPath);
                this.cache.set(resolvedPath, cached);
                return cached.result;
            }
            const key = `${resolvedPath}\0${version}`;
            const pending = this.pending.get(key);
            if (pending) return pending;
            const job = this.generate(resolvedPath, info.size, version).then((result) => {
                this.cache.delete(resolvedPath);
                this.cache.set(resolvedPath, { version, result, expires: Date.now() + (result.success && result.status === 'ready' ? 10 * 60_000 : 30_000) });
                while (this.cache.size > CACHE_LIMIT) this.cache.delete(this.cache.keys().next().value!);
                return result;
            }).finally(() => { this.pending.delete(key); });
            this.pending.set(key, job);
            return job;
        } catch (error) {
            return { success: false, error: error instanceof Error ? error.message : 'Unable to inspect video file' };
        }
    }

    private async generate(path: string, sizeBytes: number, version: string): Promise<WorkspaceVideoPreviewResult> {
        const result: Extract<WorkspaceVideoPreviewResult, { success: true }> = { success: true, status: 'unavailable', sizeBytes };
        try {
            return await this.limiter.run(async () => {
                try {
                    const probe = await this.runProcess('ffprobe', [
                        '-v', 'error', '-max_alloc', '134217728', ...INPUT_OPTIONS,
                        '-select_streams', 'v:0', '-show_entries',
                        'stream=width,height,duration:stream_tags=rotate:stream_side_data=rotation:format=duration',
                        '-of', 'json', '-i', path,
                    ], 6_000);
                    Object.assign(result, parseVideoProbe(probe));
                    // One decoded frame at most, one decoder/filter/encoder thread.
                    const poster = await this.runProcess('ffmpeg', [
                        '-nostdin', '-hide_banner', '-loglevel', 'error', '-max_alloc', '134217728',
                        '-threads', '1', '-filter_threads', '1', ...INPUT_OPTIONS,
                        '-ss', String(Math.min(1, (result.durationSeconds ?? 0) / 4)), '-i', path,
                        '-map', '0:v:0', '-frames:v', '1', '-an', '-sn',
                        '-vf', "scale=w='min(320,iw)':h='min(320,ih)':force_original_aspect_ratio=decrease",
                        '-threads', '1', '-c:v', 'mjpeg', '-q:v', '6', '-f', 'image2pipe', 'pipe:1',
                    ], 10_000);
                    if (poster.length === 0 || poster.length > MAX_POSTER_BYTES || poster[0] !== 0xff || poster[1] !== 0xd8) throw new Error('Video cover could not be generated');
                    const current = await stat(path);
                    if (`${current.dev}:${current.ino}:${current.size}:${current.mtimeMs}:${current.ctimeMs}` !== version) {
                        return { success: true, status: 'unavailable', sizeBytes: current.size, error: 'The video changed while its preview was loading; retry shortly' };
                    }
                    return { ...result, status: 'ready', posterDataUrl: `data:image/jpeg;base64,${poster.toString('base64')}` };
                } catch (error) {
                    return { ...result, error: error instanceof Error ? error.message : 'Video preview is unavailable' };
                }
            });
        } catch (error) {
            return { ...result, error: error instanceof Error ? error.message : 'Video preview is unavailable' };
        }
    }
}
