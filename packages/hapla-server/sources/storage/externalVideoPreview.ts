import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { resolve4 } from 'node:dns/promises';
import { createServer, type Server } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { parseVideoProbe, type VideoPreview } from './videoPreview';

export type VideoPreviewFailureReason = 'source_expired' | 'source_denied' | 'source_not_found' | 'source_busy' | 'network' | 'timeout' | 'range_unsupported' | 'source_changed' | 'invalid_response' | 'budget_exceeded' | 'decoder_unavailable' | 'frame_too_large' | 'cancelled';
export type ExternalVideoPreview = Omit<VideoPreview, 'sizeBytes'> & {
    sizeBytes: number | null;
    posterStatus?: 'ready' | 'unavailable';
    reason?: VideoPreviewFailureReason;
    retryable?: boolean;
    retryAfterMs?: number;
};
export class ExternalVideoPreviewError extends Error {
    constructor(public readonly statusCode: number, message: string, public readonly reason = 'request_rejected', public readonly retryable = false, public readonly retryAfterMs?: number) { super(message); }
}
class VideoSourceError extends Error {
    constructor(public readonly reason: VideoPreviewFailureReason, public readonly retryable: boolean) { super('Video source request failed'); }
}
const MAX_CHUNK = 256 * 1024;
const MAX_BYTES = 4 * 1024 * 1024;
const MAX_ERROR_BYTES = 4 * 1024;
const DEADLINE_MS = 10_000;
const empty = (): ExternalVideoPreview => ({ status: 'unavailable', durationSeconds: null, width: null, height: null, aspectRatio: null, sizeBytes: null, posterDataUrl: null, posterStatus: 'unavailable' });

function sourceStatusError(status: number | undefined): VideoSourceError {
    if (status === 401 || status === 403) return new VideoSourceError('source_denied', false);
    if (status === 404 || status === 410) return new VideoSourceError('source_not_found', false);
    if (status === 429 || (status !== undefined && status >= 500)) return new VideoSourceError('source_busy', true);
    if (status === 200) return new VideoSourceError('range_unsupported', false);
    return new VideoSourceError('invalid_response', false);
}

async function retryPause(signal: AbortSignal): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { await withCancellation(new Promise<void>(resolve => { timer = setTimeout(resolve, 200); }), signal); }
    finally { clearTimeout(timer); }
}

export function validateExternalVideoUrl(value: unknown): URL {
    if (typeof value !== 'string' || value.length > 16_384 || /[\s\u0000-\u001f]/.test(value)) throw new ExternalVideoPreviewError(400, 'Invalid video URL');
    let url: URL;
    try { url = new URL(value); } catch { throw new ExternalVideoPreviewError(400, 'Invalid video URL'); }
    if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')
        || !['.r2.cloudflarestorage.com', '.r2.dev', '.amazonaws.com'].some(suffix => url.hostname.endsWith(suffix))) {
        throw new ExternalVideoPreviewError(400, 'Unsupported video source');
    }
    if (!/\.(mp4|mov|m4v)$/i.test(url.pathname)) throw new ExternalVideoPreviewError(415, 'Unsupported video container');
    return url;
}

export function isPublicVideoAddress(address: string): boolean {
    const bytes = address.split('.').map(Number);
    if (bytes.length !== 4 || bytes.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return false;
    const [a, b, c] = bytes;
    return a !== 0 && a !== 10 && a !== 127 && a < 224
        && !(a === 100 && b >= 64 && b <= 127) && !(a === 169 && b === 254)
        && !(a === 172 && b >= 16 && b <= 31) && !(a === 192 && (b === 168 || b === 0 || (b === 88 && c === 99)))
        && !(a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) && !(a === 203 && b === 0 && c === 113);
}

function interrupted(signal: AbortSignal): void {
    if (signal.aborted) throw new ExternalVideoPreviewError(499, 'Video preview cancelled');
}

async function withCancellation<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
    interrupted(signal);
    let cleanup = () => {};
    const cancelled = new Promise<never>((_, reject) => {
        const cancel = () => reject(new ExternalVideoPreviewError(499, 'Video preview cancelled'));
        signal.addEventListener('abort', cancel, { once: true });
        cleanup = () => signal.removeEventListener('abort', cancel);
    });
    try { return await Promise.race([operation, cancelled]); } finally { cleanup(); }
}

/** Pins DNS for every HTTPS connection. Never follows redirects, forwards
 * account credentials, or hands the signed address to a media decoder. */
export class BoundedVideoSource {
    size: number | null = null;
    reservedBytes = 0;
    private readonly chunks = new Map<string, Buffer>();
    private etag: string | undefined;
    lastFailure: VideoSourceError | undefined;
    constructor(private readonly uri: string, private readonly address: string, private readonly signal: AbortSignal) {}

    async read(start: number, end: number, consumerSignal = this.signal): Promise<Buffer> {
        for (let attempt = 0; ; attempt++) {
            try { return await this.readOnce(start, end, consumerSignal); }
            catch (error) {
                const failure = error instanceof VideoSourceError ? error : undefined;
                if (attempt === 0 && failure && ['network', 'source_busy', 'timeout'].includes(failure.reason) && !this.signal.aborted && !consumerSignal.aborted) {
                    await retryPause(consumerSignal);
                    continue;
                }
                if (failure && failure.reason !== 'cancelled') this.lastFailure = failure;
                throw error;
            }
        }
    }

    private async readOnce(start: number, end: number, consumerSignal: AbortSignal): Promise<Buffer> {
        interrupted(this.signal); interrupted(consumerSignal);
        const length = end - start + 1;
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || length < 1 || length > MAX_CHUNK) throw new Error('Invalid video range');
        const key = `${start}:${end}`;
        const cached = this.chunks.get(key);
        if (cached) return cached;
        if (this.reservedBytes + length > MAX_BYTES) {
            const error = new VideoSourceError('budget_exceeded', false);
            error.message = 'Video preview byte budget exceeded';
            throw error;
        }
        this.reservedBytes += length;
        const result = await new Promise<Buffer>((resolve, reject) => {
            let settled = false;
            const finish = (error?: Error, value?: Buffer) => {
                if (settled) return;
                settled = true;
                this.signal.removeEventListener('abort', abort);
                consumerSignal.removeEventListener('abort', abort);
                if (error) reject(error instanceof VideoSourceError ? error : new VideoSourceError('network', true));
                else resolve(value!);
            };
            const req = httpsRequest(this.uri, {
                method: 'GET', agent: false, family: 4,
                headers: { Range: `bytes=${start}-${end}`, 'Accept-Encoding': 'identity' },
                lookup: (_hostname, _options, callback) => callback(null, this.address, 4),
                timeout: 4_000,
            }, response => {
                const range = /^bytes (\d+)-(\d+)\/(\d+)$/i.exec(String(response.headers['content-range'] ?? ''));
                const total = range ? Number(range[3]) : NaN;
                const etag = typeof response.headers.etag === 'string' ? response.headers.etag : undefined;
                if (response.statusCode === 401 || response.statusCode === 403) {
                    // A denied request is not necessarily an expired signature.
                    // Inspect only a tiny XML error, within the same byte budget,
                    // and never retain or expose the provider's error text/IDs.
                    const limit = Math.min(MAX_ERROR_BYTES, length + MAX_BYTES - this.reservedBytes);
                    this.reservedBytes += Math.max(0, limit - length);
                    const parts: Buffer[] = [];
                    let received = 0;
                    const denied = () => { finish(new VideoSourceError('source_denied', false)); response.destroy(); req.destroy(); };
                    response.on('data', (chunk: Buffer) => {
                        received += chunk.length;
                        if (received > limit) denied();
                        else parts.push(chunk);
                    });
                    response.on('end', () => {
                        const xml = Buffer.concat(parts).toString('utf8');
                        const isXml = /^(?:application|text)\/xml(?:\s*;|$)/i.test(String(response.headers['content-type'] ?? ''));
                        const expired = isXml && /<Code>\s*(?:ExpiredRequest|RequestExpired)\s*<\/Code>/.test(xml);
                        finish(new VideoSourceError(expired ? 'source_expired' : 'source_denied', false));
                        response.destroy(); req.destroy();
                    });
                    response.on('error', denied);
                    response.on('aborted', denied);
                    return;
                }
                if (response.statusCode !== 206) {
                    finish(sourceStatusError(response.statusCode)); response.destroy(); req.destroy(); return;
                }
                if ((this.size !== null && this.size !== total) || (this.etag !== undefined && this.etag !== etag)) {
                    finish(new VideoSourceError('source_changed', true)); response.destroy(); req.destroy(); return;
                }
                if (!range || Number(range[1]) !== start || Number(range[2]) !== end
                    || !Number.isSafeInteger(total) || total <= end
                    || (response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity')) {
                    finish(new VideoSourceError('invalid_response', false)); response.destroy(); req.destroy(); return;
                }
                this.size = total;
                this.etag = etag;
                const buffers: Buffer[] = [];
                let received = 0;
                response.on('data', (chunk: Buffer) => {
                    received += chunk.length;
                    if (received > length) { finish(new VideoSourceError('invalid_response', false)); response.destroy(); req.destroy(); }
                    else buffers.push(chunk);
                });
                response.on('end', () => received === length ? finish(undefined, Buffer.concat(buffers)) : finish(new VideoSourceError('network', true)));
                response.on('error', () => finish(new Error('Video stream failed')));
                response.on('aborted', () => finish(new Error('Video stream aborted')));
            });
            const abort = () => { finish(new VideoSourceError('cancelled', false)); req.destroy(); };
            this.signal.addEventListener('abort', abort, { once: true });
            consumerSignal.addEventListener('abort', abort, { once: true });
            req.on('timeout', () => { finish(new VideoSourceError('timeout', true)); req.destroy(); });
            req.on('error', () => finish(new Error('Video request failed')));
            req.end();
        });
        this.chunks.set(key, result);
        return result;
    }
}

async function startRangeRelay(source: BoundedVideoSource, signal: AbortSignal): Promise<{ url: string; close: () => Promise<void> }> {
    const nonce = randomBytes(24).toString('hex');
    const server: Server = createServer((request, response) => {
        if (request.url !== `/${nonce}` || !['GET', 'HEAD'].includes(request.method ?? '') || !source.size) { response.writeHead(404).end(); return; }
        const match = /^bytes=(\d+)-(\d*)$/.exec(String(request.headers.range ?? 'bytes=0-'));
        const start = match ? Number(match[1]) : NaN;
        const end = match?.[2] ? Math.min(Number(match[2]), source.size - 1) : source.size - 1;
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start < 0) { response.writeHead(416).end(); return; }
        response.writeHead(206, { 'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes', 'Content-Range': `bytes ${start}-${end}/${source.size}`, 'Content-Length': end - start + 1, 'Cache-Control': 'no-store', Connection: 'close' });
        if (request.method === 'HEAD') { response.end(); return; }
        const consumer = new AbortController();
        response.once('close', () => consumer.abort());
        void (async () => {
            try {
                for (let offset = start; offset <= end && !response.destroyed; offset += MAX_CHUNK) {
                    const chunk = await source.read(offset, Math.min(end, offset + MAX_CHUNK - 1), consumer.signal);
                    if (response.destroyed) return;
                    if (!response.write(chunk)) await withCancellation(new Promise<void>(resolve => response.once('drain', resolve)), consumer.signal);
                }
                response.end();
            } catch { response.destroy(); }
        })();
    });
    server.on('clientError', (_error, socket) => socket.destroy());
    const stop = () => { server.closeAllConnections(); server.close(); };
    signal.addEventListener('abort', stop, { once: true });
    await withCancellation(new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); }), signal);
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Video relay unavailable');
    return { url: `http://127.0.0.1:${address.port}/${nonce}`, close: async () => {
        signal.removeEventListener('abort', stop);
        server.closeAllConnections();
        await new Promise<void>(resolve => server.close(() => resolve()));
    } };
}

function runDecoder(command: string, args: string[], signal: AbortSignal): Promise<Buffer> {
    interrupted(signal);
    return new Promise((resolve, reject) => {
        const child = execFile(command, args, { encoding: 'buffer', timeout: DEADLINE_MS, maxBuffer: 256 * 1024, killSignal: 'SIGKILL', windowsHide: true }, (error, stdout) => {
            signal.removeEventListener('abort', cancel);
            if (error) reject(new Error('Video decoder unavailable'));
            else resolve(stdout);
        });
        const cancel = () => child.kill('SIGKILL');
        signal.addEventListener('abort', cancel, { once: true });
        if (signal.aborted) cancel();
    });
}

const cache = new Map<string, { expires: number; value: ExternalVideoPreview }>();
let running = 0;
const waiting: Array<{ grant: () => void }> = [];

function busy(): ExternalVideoPreviewError {
    return new ExternalVideoPreviewError(503, 'Video preview is busy', 'preview_busy', true, 1000);
}

/** Waiting does not create decoders or upstream traffic. Both the queue length
 * and residence time are bounded, and disconnected cards leave immediately. */
function acquireSlot(signal: AbortSignal): Promise<() => void> {
    interrupted(signal);
    const release = () => {
        const next = waiting.shift();
        if (next) next.grant(); else running--;
    };
    if (running < 2) { running++; return Promise.resolve(release); }
    if (waiting.length >= 16) return Promise.reject(busy());
    return new Promise((resolve, reject) => {
        let settled = false;
        const cleanup = () => { clearTimeout(timer); signal.removeEventListener('abort', cancel); };
        const fail = (error: Error) => {
            if (settled) return;
            settled = true; cleanup();
            const index = waiting.indexOf(waiter);
            if (index >= 0) waiting.splice(index, 1);
            reject(error);
        };
        const cancel = () => fail(new ExternalVideoPreviewError(499, 'Video preview cancelled', 'cancelled'));
        const waiter = { grant: () => { if (settled) return; settled = true; cleanup(); resolve(release); } };
        const timer = setTimeout(() => fail(busy()), 8_000);
        waiting.push(waiter);
        signal.addEventListener('abort', cancel, { once: true });
    });
}

export async function getExternalVideoPreview(accountId: string, uri: string, requestSignal: AbortSignal): Promise<ExternalVideoPreview> {
    const url = validateExternalVideoUrl(uri);
    const key = createHash('sha256').update(accountId).update('\0').update(uri).digest('hex');
    const cached = cache.get(key);
    if (cached && cached.expires > Date.now()) return cached.value;
    const releaseSlot = await acquireSlot(requestSignal);
    // A duplicate card may have completed while this request was queued.
    const refreshed = cache.get(key);
    if (refreshed && refreshed.expires > Date.now()) { releaseSlot(); return refreshed.value; }
    const abort = new AbortController();
    const cancel = () => abort.abort();
    requestSignal.addEventListener('abort', cancel, { once: true });
    if (requestSignal.aborted) cancel();
    let timedOut = false;
    const deadline = setTimeout(() => { timedOut = true; cancel(); }, DEADLINE_MS);
    let relay: Awaited<ReturnType<typeof startRangeRelay>> | undefined;
    let source: BoundedVideoSource | undefined;
    let preview = empty();
    try {
        const addresses = await withCancellation(resolve4(url.hostname), abort.signal);
        if (!addresses.length || addresses.some(address => !isPublicVideoAddress(address))) throw new ExternalVideoPreviewError(403, 'Video source address is not public');
        source = new BoundedVideoSource(uri, addresses[0], abort.signal);
        await source.read(0, 0);
        preview.sizeBytes = source.size;
        relay = await startRangeRelay(source, abort.signal);
        // A forced MOV demuxer with external data references disabled cannot
        // fetch playlists/subresources; only this unguessable loopback URL is
        // given to either subprocess. Remote HTTPS is not in its allowlist.
        const input = ['-max_alloc', '67108864', '-protocol_whitelist', 'http,tcp', '-rw_timeout', '3000000', '-f', 'mov', '-enable_drefs', '0', '-use_absolute_path', '0', '-i', relay.url];
        const probe = await runDecoder('ffprobe', ['-v', 'error', '-threads', '1', '-probesize', '1048576', '-analyzeduration', '1000000', ...input, '-select_streams', 'v:0', '-show_entries', 'stream=width,height,duration,display_aspect_ratio:stream_tags=rotate:stream_side_data=rotation:format=duration', '-of', 'json'], abort.signal);
        preview = { ...preview, ...parseVideoProbe(JSON.parse(probe.toString('utf8'))) };
        if (preview.width && preview.height) preview.status = 'ready';
        if (preview.width && preview.height && preview.width * preview.height <= 33_177_600) {
            const [a, b] = preview.aspectRatio!.split(':').map(Number);
            const displayWidth = preview.height * a / b;
            const scale = Math.min(1, 320 / displayWidth, 180 / preview.height);
            const width = Math.max(1, Math.round(displayWidth * scale));
            const height = Math.max(1, Math.round(preview.height * scale));
            const poster = await runDecoder('ffmpeg', ['-nostdin', '-v', 'error', '-threads', '1', ...input, '-map', '0:v:0', '-frames:v', '1', '-an', '-sn', '-dn', '-vf', `scale=${width}:${height},setsar=1`, '-threads', '1', '-q:v', '7', '-f', 'image2pipe', '-vcodec', 'mjpeg', 'pipe:1'], abort.signal);
            if (poster.length > 0 && poster.length <= 128 * 1024 && poster[0] === 0xff && poster[1] === 0xd8) preview = { ...preview, status: 'ready', posterStatus: 'ready', posterDataUrl: `data:image/jpeg;base64,${poster.toString('base64')}` };
        }
        if (!preview.posterDataUrl) preview = { ...preview, reason: preview.width && preview.height && preview.width * preview.height > 33_177_600 ? 'frame_too_large' : 'decoder_unavailable', retryable: false };
    } catch (error) {
        if (error instanceof ExternalVideoPreviewError && error.statusCode === 403) throw error;
        const failure = error instanceof VideoSourceError ? error : source?.lastFailure;
        const reason: VideoPreviewFailureReason = requestSignal.aborted ? 'cancelled' : timedOut ? 'timeout' : failure?.reason ?? (source ? 'decoder_unavailable' : 'network');
        const retryable = reason !== 'cancelled' && (timedOut || failure?.retryable === true || reason === 'network');
        preview = { ...preview, reason, retryable, ...(retryable ? { retryAfterMs: reason === 'source_busy' ? 2000 : 1000 } : {}) };
        // Deliberately no remote URL, decoder stderr, or signed query in logs.
    } finally {
        clearTimeout(deadline); abort.abort(); await relay?.close();
        requestSignal.removeEventListener('abort', cancel);
        releaseSlot();
    }
    // Neither transient failures nor partial metadata should defeat a manual
    // retry by replaying a failed/unfinished cached result.
    if (!requestSignal.aborted && preview.posterDataUrl) {
        cache.delete(key); cache.set(key, { expires: Date.now() + 120_000, value: preview });
        while (cache.size > 64) cache.delete(cache.keys().next().value!);
    }
    return preview;
}
