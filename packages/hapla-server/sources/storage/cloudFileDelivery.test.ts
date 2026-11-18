import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { CloudFileDeliveryService } from './cloudFileDelivery';

const roots: string[] = [];
afterEach(async () => { vi.useRealTimers(); await Promise.all(roots.splice(0).map(p => rm(p, { recursive: true, force: true }))); });
async function service(fetcher: typeof fetch) {
    const root = await mkdtemp(join(tmpdir(), 'hapla-cloud-v2-')); roots.push(root);
    return { root, adapter: new CloudFileDeliveryService({ endpoint: 'http://nas:9876', directory: join(root, 'records'), fetch: fetcher }) };
}
const bytes = Buffer.alloc(1024 * 1024 + 1, 19);
const input = { sha256: createHash('sha256').update(bytes).digest('hex'), name: '报告 视频.mp4', size: bytes.length };
function url(revision = 'current') { return 'https://test.r2.cloudflarestorage.com/video/original.mp4?X-Amz-Date=' + new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '') + '&X-Amz-Expires=3600&X-Amz-Signature=' + revision; }
async function consume(options?: RequestInit) { let text = ''; for await (const chunk of options?.body as any) text += chunk; return JSON.parse(text); }

describe('NAS API v2 delivery', () => {
    it('signs downloads separately from previews and refuses a plain playback URL', async () => {
        const fetcher = vi.fn(async (_endpoint, options) => {
            const body = JSON.parse(String(options?.body));
            const value = new URL(url());
            if (body.download) {
                expect(body.filename).toBe(input.name);
                value.searchParams.set('response-content-disposition', 'attachment; filename="video.mp4"');
                value.searchParams.set('response-content-type', 'application/octet-stream');
            }
            return Response.json({ url: value.href });
        });
        const { adapter } = await service(fetcher);
        const preview = await adapter.resolve('one', url());
        const saved = await adapter.resolve('one', url(), true, input.name);
        expect(saved.url).not.toBe(preview.url);
        expect((await adapter.resolve('one', url())).url).toBe(preview.url);
        expect(fetcher).toHaveBeenCalledTimes(2);
        await expect(adapter.resolve('one', url(), true, '../file.mp4')).rejects.toMatchObject({ statusCode: 400 });
        fetcher.mockResolvedValue(Response.json({ url: url() }));
        await expect(adapter.resolve('one', url(), true, input.name)).rejects.toMatchObject({ statusCode: 502 });
    });
    it('streams standard Base64 across arbitrary boundaries, preserves filename and calls only upload without tokens', async () => {
        const fetcher = vi.fn(async (endpoint, options) => {
            expect(String(endpoint)).toBe('http://nas:9876/v1/upload'); expect(options?.method).toBe('POST');
            expect(new Headers(options?.headers).has('Authorization')).toBe(false);
            const payload = await consume(options); expect(Object.keys(payload).sort()).toEqual(['base64', 'filename']);
            expect(payload.filename).toBe(input.name); expect(Buffer.from(payload.base64, 'base64')).toEqual(bytes);
            return Response.json({ url: url() });
        });
        const { adapter } = await service(fetcher);
        const record = await adapter.prepare('one', input);
        expect(record.state).toBe('upload-required'); expect(fetcher).not.toHaveBeenCalled();
        const source = Readable.from((function* () { for (let offset = 0; offset < bytes.length; offset += 8191) yield bytes.subarray(offset, offset + 8191); })());
        await adapter.upload('one', record.id, source, bytes.length, new AbortController().signal);
        const ready = await adapter.status('one', record.id);
        expect(ready.state).toBe('ready'); expect(ready.downloadUrl).toBe(ready.url); expect(ready.headUrl).toBeUndefined();
        await expect(adapter.status('two', record.id)).rejects.toMatchObject({ statusCode: 404 });
    });
    it('persists the NAS source URL, restores after restart and accepts previously expired links', async () => {
        let restores = 0;
        const fetcher = vi.fn(async (endpoint, options) => {
            if (String(endpoint).endsWith('/upload')) await consume(options);
            else { expect(String(endpoint)).toBe('http://nas:9876/v1/restore'); expect(JSON.parse(String(options?.body)).url).toContain('X-Amz-'); restores++; }
            return Response.json({ url: url(String(restores)) });
        });
        const { adapter, root } = await service(fetcher);
        const record = await adapter.prepare('one', input);
        await adapter.upload('one', record.id, Readable.from(bytes), bytes.length, new AbortController().signal);
        const restarted = new CloudFileDeliveryService({ endpoint: 'http://nas:9876', directory: join(root, 'records'), fetch: fetcher });
        expect((await restarted.status('one', record.id)).state).toBe('preparing');
        await vi.waitFor(async () => expect((await restarted.status('one', record.id)).state).toBe('ready'));
        expect(restores).toBe(1);
        const expired = url().replace(/X-Amz-Date=[^&]+/, 'X-Amz-Date=20200101T000000Z');
        const fresh = await restarted.resolve('one', expired, true); expect(fresh.expiresAt).toBeGreaterThan(Date.now());
        const account = (await readdir(join(root, 'records')))[0];
        const saved = JSON.parse(await readFile(join(root, 'records', account, record.id + '.json'), 'utf8'));
        expect(saved.url).toBeDefined(); expect(saved.requestId).toBeUndefined();
    });
    it('deduplicates simultaneous restores, retains only small fresh address metadata and supports forced retry', async () => {
        const fetcher = vi.fn(async () => Response.json({ url: url() }));
        const { adapter } = await service(fetcher);
        const results = await Promise.all([adapter.resolve('one', url()), adapter.resolve('one', url())]);
        expect(results[0]).toEqual(results[1]); expect(fetcher).toHaveBeenCalledTimes(1);
        await adapter.resolve('one', url()); expect(fetcher).toHaveBeenCalledTimes(1);
        await adapter.resolve('one', url(), true); expect(fetcher).toHaveBeenCalledTimes(2);
    });
    it('rejects invalid input, wrong content and cross-account upload before recording a usable URL', async () => {
        const { adapter } = await service(vi.fn(async (_url, options) => { await consume(options); return Response.json({ url: url() }); }));
        await expect(adapter.prepare('one', { ...input, size: 1024 })).rejects.toMatchObject({ statusCode: 400 });
        await expect(adapter.prepare('one', { ...input, name: '../secret' })).rejects.toMatchObject({ statusCode: 400 });
        const record = await adapter.prepare('one', input);
        await expect(adapter.upload('two', record.id, Readable.from(bytes), bytes.length, new AbortController().signal)).rejects.toMatchObject({ statusCode: 404 });
        await expect(adapter.upload('one', record.id, Readable.from(Buffer.alloc(bytes.length)), bytes.length, new AbortController().signal)).rejects.toThrow();
        expect((await adapter.prepare('one', input)).state).toBe('upload-required');
    });
    it('maps new API failures and never fetches caller-controlled URLs', async () => {
        const fetcher = vi.fn(async (_url: unknown, _options?: RequestInit) => Response.json({ error: 'source_not_found' }, { status: 404 }));
        const { adapter } = await service(fetcher);
        await expect(adapter.resolve('one', 'http://127.0.0.1/secret')).rejects.toMatchObject({ statusCode: 400 }); expect(fetcher).not.toHaveBeenCalled();
        await expect(adapter.resolve('one', url())).rejects.toMatchObject({ statusCode: 404 });
        expect(fetcher.mock.calls[0][0]).toBe('http://nas:9876/v1/restore');
        fetcher.mockResolvedValue(Response.json({ error: 'busy' }, { status: 429 }));
        await expect(adapter.resolve('one', url())).rejects.toMatchObject({ statusCode: 429 });
        fetcher.mockResolvedValue(Response.json({ url: 'https://attacker.invalid/x' }));
        await expect(adapter.resolve('one', url())).rejects.toMatchObject({ statusCode: 502 });
    });
});
