import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BoundedVideoSource, getExternalVideoPreview, isPublicVideoAddress, validateExternalVideoUrl } from './externalVideoPreview';

const mocks = vi.hoisted(() => ({ dns: vi.fn(), request: vi.fn(), exec: vi.fn() }));
vi.mock('node:dns/promises', () => ({ resolve4: mocks.dns }));
vi.mock('node:https', () => ({ request: mocks.request }));
vi.mock('node:child_process', () => ({ execFile: mocks.exec }));
const signed = 'https://account.r2.cloudflarestorage.com/bucket/final.mp4?X-Amz-Credential=FAKE%2Fscope&X-Amz-Signature=not-a-secret&x=1+2&x=%2b';
let responseStatus: number;
let bodyExtra: number;
let total: number;
let receivedRequests: Array<any>;
let stalled: boolean;
let etag: string;
let statuses: number[];
let networkFailures: number;
let errorBody: Buffer[] | undefined;
let errorContentType: string;
let errorBodyStalled: boolean;

beforeEach(() => {
    vi.clearAllMocks();
    responseStatus = 206; bodyExtra = 0; total = 8 * 1024 * 1024; stalled = false; receivedRequests = []; etag = '"v1"'; statuses = []; networkFailures = 0;
    errorBody = undefined; errorContentType = 'application/xml'; errorBodyStalled = false;
    mocks.dns.mockResolvedValue(['104.16.1.1']);
    mocks.request.mockImplementation((uri, options, callback) => {
        const req = new EventEmitter() as any;
        req.destroy = vi.fn(() => queueMicrotask(() => req.emit('error', new Error('redacted'))));
        req.end = () => queueMicrotask(() => {
            if (stalled) return;
            if (networkFailures > 0) { networkFailures--; req.emit('error', new Error('network canary must not escape')); return; }
            const response = new PassThrough() as any;
            const [, left, right] = /bytes=(\d+)-(\d+)/.exec(options.headers.Range)!;
            const start = Number(left), end = Number(right);
            response.statusCode = statuses.shift() ?? responseStatus;
            response.headers = { 'content-range': `bytes ${start}-${end}/${total}`, etag, 'content-type': errorContentType };
            callback(response);
            if (!response.destroyed) {
                if (errorBodyStalled) return;
                if (errorBody) {
                    for (const chunk of errorBody) { if (!response.destroyed) response.write(chunk); }
                    if (!response.destroyed) response.end();
                } else response.end(Buffer.alloc(end - start + 1 + bodyExtra));
            }
        });
        receivedRequests.push({ uri, options, req });
        return req;
    });
    mocks.exec.mockImplementation((command, _args, _options, callback) => {
        const child = { kill: vi.fn(() => queueMicrotask(() => callback(new Error('cancelled')))) };
        queueMicrotask(() => callback(null, command === 'ffprobe'
            ? Buffer.from(JSON.stringify({ streams: [{ width: 1920, height: 1080 }], format: { duration: '12.5' } }))
            : Buffer.from([0xff, 0xd8, 1, 2, 0xff, 0xd9])));
        return child;
    });
});
afterEach(() => vi.useRealTimers());

describe('external video URL and DNS policy', () => {
    it('allows only HTTPS object storage sources with an explicit supported container', () => {
        expect(validateExternalVideoUrl(signed).href).toBe(signed);
        expect(validateExternalVideoUrl('https://public.r2.dev/a.mov').hostname).toBe('public.r2.dev');
        expect(validateExternalVideoUrl('https://bucket.s3.amazonaws.com/a.m4v').hostname).toBe('bucket.s3.amazonaws.com');
        for (const url of ['http://a.r2.dev/a.mp4', 'https://a.r2.dev:444/a.mp4', 'https://user:pass@a.r2.dev/a.mp4', 'https://a.r2.dev.evil.test/a.mp4', 'https://127.0.0.1/a.mp4', 'https://example.test/a.mp4', 'file:///tmp/a.mp4', 'https://a.r2.dev/a.m3u8', 'https://a.r2.dev/a.mp4\n']) {
            expect(() => validateExternalVideoUrl(url)).toThrow();
        }
    });
    it('rejects loopback, private, link-local, metadata, reserved and IPv6 addresses', () => {
        for (const address of ['127.0.0.1', '0.0.0.0', '10.0.0.1', '100.64.0.1', '169.254.169.254', '172.16.0.1', '192.168.0.1', '192.0.2.1', '198.18.0.1', '224.0.0.1', '255.255.255.255', '::1', '::ffff:127.0.0.1']) expect(isPublicVideoAddress(address)).toBe(false);
        expect(isPublicVideoAddress('104.16.1.1')).toBe(true);
    });
    it('refuses a mixed public/private DNS answer before HTTP or decoding', async () => {
        mocks.dns.mockResolvedValue(['104.16.1.1', '127.0.0.1']);
        await expect(getExternalVideoPreview('private-dns', signed, new AbortController().signal)).rejects.toMatchObject({ statusCode: 403 });
        expect(mocks.request).not.toHaveBeenCalled(); expect(mocks.exec).not.toHaveBeenCalled();
    });
});

describe('bounded authenticated object reads', () => {
    it('retains signed query bytes, pins DNS, requests one bounded range, and never sends account credentials', async () => {
        const source = new BoundedVideoSource(signed, '104.16.1.1', new AbortController().signal);
        await expect(source.read(0, 0)).resolves.toHaveLength(1);
        expect(receivedRequests[0].uri).toBe(signed);
        expect(receivedRequests[0].options.headers).toEqual({ Range: 'bytes=0-0', 'Accept-Encoding': 'identity' });
        const callback = vi.fn(); receivedRequests[0].options.lookup('a.r2.dev', {}, callback);
        expect(callback).toHaveBeenCalledWith(null, '104.16.1.1', 4);
        expect(receivedRequests[0].options.agent).toBe(false);
        expect(source.size).toBe(total);
    });
    it.each([200, 301, 302, 307, 308])('rejects source status %s without following or buffering its body', async status => {
        responseStatus = status;
        const source = new BoundedVideoSource(signed, '104.16.1.1', new AbortController().signal);
        await expect(source.read(0, 0)).rejects.toThrow('Video source request failed');
        expect(mocks.request).toHaveBeenCalledTimes(1);
        expect(receivedRequests[0].req.destroy).toHaveBeenCalled();
    });
    it.each([
        [401, 'ExpiredRequest'], [403, 'ExpiredRequest'], [401, 'RequestExpired'], [403, 'RequestExpired'],
    ])('identifies an explicit expiration code on status %s without returning provider text', async (status, code) => {
        responseStatus = status as number;
        errorBody = [Buffer.from(`<?xml version="1.0"?><Error><Code>${code}</Code><Message>private source canary</Message><RequestId>private ID</RequestId></Error>`)];
        const source = new BoundedVideoSource(signed, '104.16.1.1', new AbortController().signal);
        await expect(source.read(0, 0)).rejects.toMatchObject({ reason: 'source_expired', retryable: false, message: 'Video source request failed' });
        expect(mocks.request).toHaveBeenCalledTimes(1);
        expect(source.reservedBytes).toBe(4096);
    });
    it.each([
        ['application/xml', '<Error><Code>AccessDenied</Code><Message>Request has expired</Message></Error>'],
        ['application/xml', '<Error><Code>ExpiredRequestUnexpected</Code></Error>'],
        ['text/html', '<Error><Code>ExpiredRequest</Code></Error>'],
    ])('keeps other denied responses distinct from proven expiration (%s)', async (type, body) => {
        responseStatus = 403; errorContentType = type; errorBody = [Buffer.from(body)];
        const source = new BoundedVideoSource(signed, '104.16.1.1', new AbortController().signal);
        await expect(source.read(0, 0)).rejects.toMatchObject({ reason: 'source_denied', retryable: false });
        expect(mocks.request).toHaveBeenCalledTimes(1);
    });
    it('stops a chunked denied response at 4 KiB even if its prefix claims expiration', async () => {
        responseStatus = 403;
        errorBody = [Buffer.from('<Error><Code>ExpiredRequest</Code>'), Buffer.alloc(4096), Buffer.alloc(4096)];
        const source = new BoundedVideoSource(signed, '104.16.1.1', new AbortController().signal);
        await expect(source.read(0, 0)).rejects.toMatchObject({ reason: 'source_denied', retryable: false });
        expect(source.reservedBytes).toBe(4096);
        expect(receivedRequests[0].req.destroy).toHaveBeenCalled();
    });
    it('counts denied response inspection against the remaining total byte budget', async () => {
        const source = new BoundedVideoSource(signed, '104.16.1.1', new AbortController().signal);
        for (let offset = 0; offset < 15 * 256 * 1024; offset += 256 * 1024) await source.read(offset, offset + 256 * 1024 - 1);
        await source.read(15 * 256 * 1024, 4 * 1024 * 1024 - 3);
        responseStatus = 403; errorBody = [Buffer.from('<Error><Code>ExpiredRequest</Code></Error>')];
        await expect(source.read(2, 2)).rejects.toMatchObject({ reason: 'source_denied', retryable: false });
        expect(source.reservedBytes).toBe(4 * 1024 * 1024);
    });
    it('immediately cancels a stalled denied response body', async () => {
        responseStatus = 403; errorBodyStalled = true;
        const abort = new AbortController();
        const source = new BoundedVideoSource(signed, '104.16.1.1', abort.signal);
        const operation = source.read(0, 0);
        await Promise.resolve();
        abort.abort();
        await expect(operation).rejects.toMatchObject({ reason: 'cancelled' });
        expect(receivedRequests[0].req.destroy).toHaveBeenCalled();
    });
    it('bounds each request and all source bytes, while reusing only temporary in-memory ranges', async () => {
        const source = new BoundedVideoSource(signed, '104.16.1.1', new AbortController().signal);
        await expect(source.read(0, 256 * 1024)).rejects.toThrow('Invalid video range');
        for (let offset = 0; offset < 4 * 1024 * 1024; offset += 256 * 1024) await source.read(offset, offset + 256 * 1024 - 1);
        await source.read(0, 256 * 1024 - 1);
        expect(mocks.request).toHaveBeenCalledTimes(16);
        expect(source.reservedBytes).toBe(4 * 1024 * 1024);
        await expect(source.read(4 * 1024 * 1024, 4 * 1024 * 1024)).rejects.toThrow('byte budget');
    });
    it('rejects a body exceeding its advertised bounded range', async () => {
        bodyExtra = 1;
        const source = new BoundedVideoSource(signed, '104.16.1.1', new AbortController().signal);
        await expect(source.read(0, 0)).rejects.toThrow('Video source request failed');
    });
    it('rejects a changed object even if its byte size is unchanged', async () => {
        const source = new BoundedVideoSource(signed, '104.16.1.1', new AbortController().signal);
        await source.read(0, 0);
        etag = '"v2"';
        await expect(source.read(1, 1)).rejects.toThrow('Video source request failed');
    });
    it('cancels an in-flight HTTPS read immediately', async () => {
        stalled = true;
        const abort = new AbortController();
        const source = new BoundedVideoSource(signed, '104.16.1.1', abort.signal);
        const operation = source.read(0, 0);
        abort.abort();
        await expect(operation).rejects.toThrow('Video source request failed');
        expect(receivedRequests[0].req.destroy).toHaveBeenCalled();
    });
});

describe('external preview process lifetime', () => {
    it('gives decoders only a random local relay and returns a tiny preview cached per account', async () => {
        const result = await getExternalVideoPreview('cache-account-a', signed, new AbortController().signal);
        expect(result).toMatchObject({ status: 'ready', width: 1920, height: 1080, durationSeconds: 12.5, sizeBytes: total, posterDataUrl: expect.stringMatching(/^data:image\/jpeg;base64,/) });
        for (const [, args, options] of mocks.exec.mock.calls) {
            expect(args[args.indexOf('-i') + 1]).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/[a-f0-9]{48}$/);
            expect(args.join(' ')).not.toContain('X-Amz');
            expect(args.slice(args.indexOf('-protocol_whitelist'), args.indexOf('-protocol_whitelist') + 2)).toEqual(['-protocol_whitelist', 'http,tcp']);
            expect(args.slice(args.indexOf('-enable_drefs'), args.indexOf('-enable_drefs') + 2)).toEqual(['-enable_drefs', '0']);
            expect(args.slice(args.indexOf('-max_alloc'), args.indexOf('-max_alloc') + 2)).toEqual(['-max_alloc', '67108864']);
            expect(options.maxBuffer).toBe(256 * 1024);
        }
        expect(await getExternalVideoPreview('cache-account-a', signed, new AbortController().signal)).toEqual(result);
        expect(mocks.exec).toHaveBeenCalledTimes(2);
        await getExternalVideoPreview('cache-account-b', signed, new AbortController().signal);
        expect(mocks.exec).toHaveBeenCalledTimes(4);
    });
    it('queues six same-account cards and runs no more than two decoders instead of failing normal bursts', async () => {
        let active = 0, maximum = 0;
        mocks.exec.mockImplementation((command, _args, _options, callback) => {
            active++; maximum = Math.max(maximum, active);
            const timer = setTimeout(() => {
                active--;
                callback(null, command === 'ffprobe' ? Buffer.from(JSON.stringify({ streams: [{ width: 640, height: 360 }] })) : Buffer.from([0xff, 0xd8, 1]));
            }, 10);
            return { kill: () => { clearTimeout(timer); active--; callback(new Error('cancelled')); } };
        });
        const results = await Promise.all(Array.from({ length: 6 }, (_, index) => getExternalVideoPreview('six-cards', signed + `&card=${index}`, new AbortController().signal)));
        expect(results.every(result => result.status === 'ready' && result.posterStatus === 'ready')).toBe(true);
        expect(maximum).toBe(2);
        expect(mocks.exec).toHaveBeenCalledTimes(12);
    });
    it('removes a cancelled queued request immediately without fetching or decoding it', async () => {
        stalled = true;
        const a = new AbortController(), b = new AbortController(), c = new AbortController();
        const first = getExternalVideoPreview('busy-a', signed, a.signal);
        const second = getExternalVideoPreview('busy-a', signed + '&second=1', b.signal);
        const queued = getExternalVideoPreview('busy-c', signed, c.signal);
        c.abort();
        await expect(queued).rejects.toMatchObject({ statusCode: 499 });
        a.abort(); b.abort();
        await expect(Promise.all([first, second])).resolves.toHaveLength(2);
        expect(mocks.dns.mock.calls.every(([hostname]) => hostname === 'account.r2.cloudflarestorage.com')).toBe(true);
        expect(mocks.dns.mock.calls.length).toBeLessThanOrEqual(2);
    });
    it('bounds waiting to 16 requests and returns explicit short retry guidance only for overflow', async () => {
        stalled = true;
        const controllers = Array.from({ length: 18 }, () => new AbortController());
        const operations = controllers.map((controller, index) => getExternalVideoPreview(`overflow-${index}`, signed, controller.signal).catch(error => error));
        await expect(getExternalVideoPreview('overflow-excess', signed, new AbortController().signal)).rejects.toMatchObject({ statusCode: 503, reason: 'preview_busy', retryable: true, retryAfterMs: 1000 });
        controllers.forEach(controller => controller.abort());
        await Promise.all(operations);
    });
    it('bounds queue residence to eight seconds independently of the ten-second active budget', async () => {
        vi.useFakeTimers(); stalled = true;
        const a = new AbortController(), b = new AbortController();
        const first = getExternalVideoPreview('wait-limit-a', signed, a.signal);
        const second = getExternalVideoPreview('wait-limit-b', signed, b.signal);
        const queued = getExternalVideoPreview('wait-limit-c', signed, new AbortController().signal).catch(error => error);
        await vi.advanceTimersByTimeAsync(8_000);
        expect(await queued).toMatchObject({ statusCode: 503, reason: 'preview_busy', retryAfterMs: 1000 });
        a.abort(); b.abort(); await Promise.all([first, second]);
    });
    it('kills a decoder when its request is cancelled', async () => {
        let kill!: ReturnType<typeof vi.fn>;
        mocks.exec.mockImplementation((_command, _args, _options, callback) => ({ kill: (kill = vi.fn(() => queueMicrotask(() => callback(new Error('cancelled'))))) }));
        const abort = new AbortController();
        const operation = getExternalVideoPreview('cancel-decoder', signed, abort.signal);
        await vi.waitFor(() => expect(mocks.exec).toHaveBeenCalledTimes(1));
        abort.abort();
        await expect(operation).resolves.toMatchObject({ status: 'unavailable', sizeBytes: total });
        expect(kill).toHaveBeenCalledWith('SIGKILL');
    });
    it('retains only metadata for oversized video frames', async () => {
        mocks.exec.mockImplementation((_command, _args, _options, callback) => {
            queueMicrotask(() => callback(null, Buffer.from(JSON.stringify({ streams: [{ width: 16384, height: 16384 }], format: { duration: '2' } }))));
            return { kill: vi.fn() };
        });
        await expect(getExternalVideoPreview('oversized', signed, new AbortController().signal)).resolves.toMatchObject({ width: 16384, height: 16384, posterDataUrl: null, status: 'ready', posterStatus: 'unavailable', reason: 'frame_too_large', retryable: false });
        expect(mocks.exec).toHaveBeenCalledTimes(1);
    });
    it.each([401, 403, 404, 410])('identifies source authorization/not-found status %s without blaming the codec or caching the failure', async status => {
        responseStatus = status;
        const account = `source-failure-${status}`;
        await expect(getExternalVideoPreview(account, signed, new AbortController().signal)).resolves.toMatchObject({ status: 'unavailable', reason: status === 401 || status === 403 ? 'source_denied' : 'source_not_found', retryable: false });
        expect(mocks.exec).not.toHaveBeenCalled(); expect(mocks.request).toHaveBeenCalledTimes(1);
        responseStatus = 206;
        await expect(getExternalVideoPreview(account, signed, new AbortController().signal)).resolves.toMatchObject({ status: 'ready', posterStatus: 'ready' });
        expect(mocks.exec).toHaveBeenCalledTimes(2);
    });
    it('reports an explicitly expired source without retries, decoder startup, or provider error disclosure', async () => {
        responseStatus = 403;
        errorBody = [Buffer.from('<Error><Code>ExpiredRequest</Code><Message>private source canary</Message><RequestId>private ID</RequestId></Error>')];
        const result = await getExternalVideoPreview('explicitly-expired', signed, new AbortController().signal);
        expect(result).toMatchObject({ status: 'unavailable', reason: 'source_expired', retryable: false, posterDataUrl: null });
        expect(JSON.stringify(result)).not.toMatch(/private|RequestId|ExpiredRequest/);
        expect(mocks.exec).not.toHaveBeenCalled(); expect(mocks.request).toHaveBeenCalledTimes(1);
        responseStatus = 206; errorBody = undefined;
        await expect(getExternalVideoPreview('explicitly-expired', signed, new AbortController().signal)).resolves.toMatchObject({ status: 'ready', posterStatus: 'ready' });
    });
    it('retries one transient source response inside the existing byte budget', async () => {
        statuses = [503, 206];
        const source = new BoundedVideoSource(signed, '104.16.1.1', new AbortController().signal);
        await expect(source.read(0, 0)).resolves.toHaveLength(1);
        expect(mocks.request).toHaveBeenCalledTimes(2); expect(source.reservedBytes).toBe(2);
    });
    it('classifies repeated network failures as retryable and permits the next request to recover immediately', async () => {
        networkFailures = 2;
        await expect(getExternalVideoPreview('network-recovery', signed, new AbortController().signal)).resolves.toMatchObject({ status: 'unavailable', reason: 'network', retryable: true, retryAfterMs: 1000 });
        expect(mocks.request).toHaveBeenCalledTimes(2); expect(mocks.exec).not.toHaveBeenCalled();
        await expect(getExternalVideoPreview('network-recovery', signed, new AbortController().signal)).resolves.toMatchObject({ status: 'ready', posterStatus: 'ready' });
        expect(mocks.request).toHaveBeenCalledTimes(3);
    });
    it('returns ready metadata with a separate failed poster status and allows manual poster retry', async () => {
        const initial = mocks.exec.getMockImplementation()!;
        let failPoster = true;
        mocks.exec.mockImplementation((command, ...args) => {
            if (command === 'ffmpeg' && failPoster) {
                queueMicrotask(() => args[2](new Error('decoder canary must not escape')));
                return { kill: vi.fn() };
            }
            return initial(command, ...args);
        });
        await expect(getExternalVideoPreview('poster-recovery', signed, new AbortController().signal)).resolves.toMatchObject({ status: 'ready', width: 1920, height: 1080, posterStatus: 'unavailable', posterDataUrl: null, reason: 'decoder_unavailable' });
        failPoster = false;
        await expect(getExternalVideoPreview('poster-recovery', signed, new AbortController().signal)).resolves.toMatchObject({ status: 'ready', posterStatus: 'ready', posterDataUrl: expect.any(String) });
        expect(mocks.exec).toHaveBeenCalledTimes(4);
    });
    it('keeps the complete active deadline at ten seconds and reports timeout separately', async () => {
        vi.useFakeTimers(); stalled = true;
        const operation = getExternalVideoPreview('active-timeout', signed, new AbortController().signal);
        await vi.advanceTimersByTimeAsync(10_000);
        await expect(operation).resolves.toMatchObject({ status: 'unavailable', reason: 'timeout', retryable: true, retryAfterMs: 1000 });
        expect(mocks.exec).not.toHaveBeenCalled();
    });
});
