import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { LocalCloudFiles } from './localCloudFiles';
import type { CloudFileDeliveryService } from './cloudFileDelivery';
import type { CloudFileDelivery } from '@hapla/wire';
import type { Readable } from 'node:stream';

function deferred() {
    let resolve!: () => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}

function uploadAdapter() {
    const values = new Map<string, CloudFileDelivery>();
    const waits = new Map<string, ReturnType<typeof deferred>>();
    const adapter = {
        prepare: vi.fn(async (_account: string, input: { name: string; size: number }) => {
            const value: CloudFileDelivery = { id: input.name, name: input.name, size: input.size,
                state: 'upload-required', stage: 'uploading-source', progress: 0 };
            values.set(value.id, value); return value;
        }),
        upload: vi.fn(async (_account: string, id: string, stream: Readable) => {
            const wait = deferred(); waits.set(id, wait);
            const value = values.get(id)!;
            values.set(id, { ...value, state: 'preparing', stage: 'uploading-source', progress: 0 });
            try {
                for await (const _chunk of stream) { /* NAS consumes the complete original. */ }
                values.set(id, { ...value, state: 'preparing', stage: 'uploading-r2', progress: .5 });
                await wait.promise;
                values.set(id, { ...value, state: 'ready', stage: 'ready', progress: 1,
                    url: 'https://test.r2.cloudflarestorage.com/' + id, expiresAt: Date.now() + 3_600_000 });
            } catch (error) {
                values.set(id, { ...value, state: 'failed', stage: 'uploading-r2', error: String(error) });
                throw error;
            }
        }),
        status: vi.fn(async (_account: string, id: string) => values.get(id)!),
    };
    return { adapter, waits, values, files: new LocalCloudFiles(adapter as unknown as CloudFileDeliveryService) };
}

it('shows upload and queue stages while NAS is waiting, then releases a slot only after completion', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hapla-stored-queue-'));
    const paths = ['one.png', 'two.png', 'three.png'].map(name => join(root, name));
    const { files, adapter, waits, values } = uploadAdapter();
    try {
        await Promise.all(paths.map(file => writeFile(file, Buffer.alloc(1024 * 1024 + 1))));
        await Promise.all(paths.slice(0, 2).map(file => files.prepare('owner', file)));
        await vi.waitFor(() => {
            expect(values.get('one.png')?.stage).toBe('uploading-r2');
            expect(values.get('two.png')?.stage).toBe('uploading-r2');
        });
        expect(await files.prepare('owner', paths[0])).toMatchObject({ state: 'preparing', stage: 'uploading-r2' });
        expect(await files.prepare('owner', paths[1])).toMatchObject({ state: 'preparing', stage: 'uploading-r2' });
        expect(await files.prepare('owner', paths[2])).toMatchObject({ state: 'preparing', stage: 'waiting-capacity' });
        expect(adapter.upload).toHaveBeenCalledTimes(2);
        expect(adapter.prepare).toHaveBeenCalledTimes(2);

        waits.get('one.png')!.resolve();
        await vi.waitFor(async () => expect((await files.prepare('owner', paths[0])).state).toBe('ready'));
        await files.prepare('owner', paths[2]);
        await vi.waitFor(() => expect(values.get('three.png')?.stage).toBe('uploading-r2'));
        expect(adapter.upload).toHaveBeenCalledTimes(3);
        waits.get('two.png')!.resolve(); waits.get('three.png')!.resolve();
        await vi.waitFor(async () => {
            expect((await files.prepare('owner', paths[1])).state).toBe('ready');
            expect((await files.prepare('owner', paths[2])).state).toBe('ready');
        });
    } finally {
        for (const wait of waits.values()) wait.resolve();
        await rm(root, { recursive: true, force: true });
    }
});

it('coalesces simultaneous failed retries into one replacement upload', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hapla-stored-retry-'));
    const path = join(root, 'retry.png');
    const { files, adapter, waits, values } = uploadAdapter();
    try {
        await writeFile(path, Buffer.alloc(1024 * 1024 + 1));
        await files.prepare('owner', path);
        await vi.waitFor(() => expect(values.get('retry.png')?.stage).toBe('uploading-r2'));
        waits.get('retry.png')!.reject(new Error('NAS temporarily unavailable'));
        await vi.waitFor(async () => expect((await files.prepare('owner', path)).state).toBe('failed'));
        await Promise.all(Array.from({ length: 8 }, () => files.prepare('owner', path, true)));
        await vi.waitFor(() => expect(adapter.upload).toHaveBeenCalledTimes(2));
        expect(adapter.prepare).toHaveBeenCalledTimes(2);
        await vi.waitFor(() => expect(values.get('retry.png')?.stage).toBe('uploading-r2'));
        expect(await files.prepare('owner', path)).toMatchObject({ state: 'preparing', stage: 'uploading-r2' });
        waits.get('retry.png')!.resolve();
        await vi.waitFor(async () => expect((await files.prepare('owner', path)).state).toBe('ready'));
    } finally {
        for (const wait of waits.values()) wait.resolve();
        await rm(root, { recursive: true, force: true });
    }
});

it('refreshes an expired stored attachment instead of repeatedly returning its old URL', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hapla-stored-renew-'));
    const file = join(root, 'video.mp4'); await writeFile(file, Buffer.alloc(1024 * 1024 + 1));
    const initial = { id: 'a'.repeat(64), state: 'ready', stage: 'ready', progress: 1, name: 'video.mp4', size: 1024 * 1024 + 1, url: 'https://test.r2.cloudflarestorage.com/old', expiresAt: Date.now() + 3_600_000 };
    const adapter = { prepare: vi.fn(async () => initial), status: vi.fn(async () => initial) };
    const files = new LocalCloudFiles(adapter as unknown as CloudFileDeliveryService);
    try {
        await files.prepare('owner', file);
        await vi.waitFor(async () => expect((await files.prepare('owner', file)).state).toBe('ready'));
        initial.expiresAt = Date.now() - 1;
        const next = { ...initial, url: 'https://test.r2.cloudflarestorage.com/fresh', expiresAt: Date.now() + 3_600_000 };
        adapter.status.mockResolvedValue(next);
        expect((await files.prepare('owner', file)).url).toBe(next.url);
        expect((await files.prepare('owner', file)).url).toBe(next.url);
        expect(adapter.prepare).toHaveBeenCalledTimes(1); // No original rehash/upload.
    } finally { await rm(root, { recursive: true, force: true }); }
});
