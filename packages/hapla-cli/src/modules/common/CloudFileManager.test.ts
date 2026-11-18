import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, writeFile, stat, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { CloudFileManager } from './CloudFileManager';

const roots: string[] = []; const managers: CloudFileManager[] = [];
afterEach(async () => { managers.forEach(m => m.dispose()); managers.length = 0; await Promise.all(roots.splice(0).map(p => rm(p, { recursive: true, force: true }))); });
async function setup(fetcher: typeof fetch, size = 1024 * 1024 + 1) {
    const root = await mkdtemp(join(tmpdir(), 'hapla-cloud-test-')); roots.push(root);
    const path = join(root, '测试文件.mp4'); const data = Buffer.alloc(size, 73); await writeFile(path, data);
    const modified = (await stat(path)).mtimeMs;
    const manager = new CloudFileManager(root, { token: 'test-token', serverUrl: 'https://hapla.test', fetch: fetcher }); managers.push(manager);
    return { root, path, data, manager, request: { path, modified, size, consumerId: 'consumer-one' } };
}
const delivery = { id: 'a'.repeat(64), name: '测试文件.mp4', size: 1024 * 1024 + 1, state: 'ready', stage: 'ready', progress: 1, url: 'https://test.r2.cloudflarestorage.com/file', downloadUrl: 'https://test.r2.cloudflarestorage.com/file?download', headUrl: 'https://test.r2.cloudflarestorage.com/file?head', expiresAt: Date.now() + 3_600_000 };
describe('cloud file preparation', () => {
    it('keeps LAN transfers on the direct API and separates them from cached R2 jobs', async () => {
        const fetcher = vi.fn(async (url: string) => Response.json(url.includes('/direct/') ? { ...delivery, url: '/files/direct/' + delivery.id, downloadUrl: '/files/direct/' + delivery.id + '?download=1' } : delivery)) as unknown as typeof fetch;
        const { manager, request } = await setup(fetcher);
        const cloud = await manager.prepare(request);
        await vi.waitFor(() => expect(manager.status(cloud.jobId!, request.consumerId).state).toBe('ready'));
        const local = await manager.prepare({ ...request, delivery: 'direct' });
        await vi.waitFor(() => expect(manager.status(local.jobId!, request.consumerId).state).toBe('ready'));
        expect(local.jobId).not.toBe(cloud.jobId);
        expect((fetcher as any).mock.calls.map((c: any[]) => c[0])).toEqual(['https://hapla.test/v1/files/cloud/prepare', 'https://hapla.test/v1/files/direct/prepare']);
        expect(manager.status(local.jobId!, request.consumerId).delivery?.url).toMatch(/^\/files\/direct\//);
    });
    it('hashes and streams the exact original without base64; reuses the ready job', async () => {
        let uploaded = Buffer.alloc(0); let metadata: any;
        const fetcher = vi.fn(async (url: string, options: RequestInit) => {
            expect((options.headers as any).Authorization).toBe('Bearer test-token');
            if (url.endsWith('/prepare')) { metadata = JSON.parse(String(options.body)); return Response.json({ ...delivery, state: 'upload-required' }); }
            if (options.method === 'PUT') { expect(options.body).toBeInstanceOf(Readable); const parts = []; for await (const b of options.body as any) parts.push(b); uploaded = Buffer.concat(parts); return new Response(null, { status: 204 }); }
            return Response.json(delivery);
        }) as unknown as typeof fetch;
        const { manager, request, data } = await setup(fetcher);
        const first = await manager.prepare(request);
        await vi.waitFor(() => { const value = manager.status(first.jobId!, request.consumerId); expect(value, value.error).toMatchObject({ state: 'ready' }); });
        expect(uploaded.equals(data)).toBe(true); expect(metadata.sha256).toBe(createHash('sha256').update(data).digest('hex'));
        const repeated = await manager.prepare({ ...request, consumerId: 'consumer-two' }); expect(repeated.jobId).toBe(first.jobId);
        expect(fetcher).toHaveBeenCalledTimes(3);
    });
    it('never uploads an original that is already in the remote cache', async () => {
        const fetcher = vi.fn(async () => Response.json(delivery)) as unknown as typeof fetch;
        const { manager, request } = await setup(fetcher); const job = await manager.prepare(request);
        await vi.waitFor(() => expect(manager.status(job.jobId!, request.consumerId).state).toBe('ready'));
        expect(fetcher).toHaveBeenCalledTimes(1);
    });
    it('shares consumers; closes only when the last preparing consumer leaves', async () => {
        let signal: AbortSignal | undefined;
        const fetcher = vi.fn((_url, options) => { signal = options!.signal!; return new Promise<Response>((_yes, no) => signal!.addEventListener('abort', () => no(new Error('Cancelled')))); }) as typeof fetch;
        const { manager, request } = await setup(fetcher); const job = await manager.prepare(request);
        await vi.waitFor(() => expect(signal).toBeDefined());
        const other = await manager.prepare({ ...request, consumerId: 'consumer-two' }); expect(other.jobId).toBe(job.jobId);
        manager.release(job.jobId!, request.consumerId); expect(signal!.aborted).toBe(false);
        expect(manager.status(job.jobId!, 'wrong-consumer').success).toBe(false);
        manager.release(job.jobId!, 'consumer-two'); expect(signal!.aborted).toBe(true);
    });
    it('rejects changed revisions and paths outside the workspace before transfer', async () => {
        const fetcher = vi.fn() as unknown as typeof fetch;
        const { manager, request, root } = await setup(fetcher);
        await expect(manager.prepare({ ...request, modified: request.modified - 1 })).rejects.toThrow();
        await expect(manager.prepare({ ...request, path: '/etc/passwd' })).rejects.toThrow(/outside/);
        await symlink('/etc/passwd', join(root, 'link'));
        await expect(manager.prepare({ ...request, path: join(root, 'link') })).rejects.toThrow(/Symbolic/);
        expect(fetcher).not.toHaveBeenCalled();
    });
    it('rejects exactly one MiB and detects writes during preparation', async () => {
        const fetcher = vi.fn(async () => { await writeFile(file.path, Buffer.alloc(file.request.size, 42)); return Response.json(delivery); }) as unknown as typeof fetch;
        const file = await setup(fetcher);
        expect((await file.manager.prepare({ ...file.request, size: 1024 * 1024 })).success).toBe(false);
        const job = await file.manager.prepare(file.request);
        await vi.waitFor(() => expect(file.manager.status(job.jobId!, file.request.consumerId).state).toBe('failed'));
        expect(file.manager.status(job.jobId!, file.request.consumerId).error).toMatch(/变化/);
    });
});
