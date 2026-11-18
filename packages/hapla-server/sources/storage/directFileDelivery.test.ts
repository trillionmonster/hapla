import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { DirectFileDeliveryService } from './directFileDelivery';
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(p => rm(p, { recursive: true, force: true }))); });
async function setup() {
    const root = await mkdtemp(join(tmpdir(), 'hapla-direct-')); roots.push(root);
    const data = Buffer.alloc(1024 * 1024 + 7, 42);
    return { root, data, service: new DirectFileDeliveryService(root), input: { sha256: createHash('sha256').update(data).digest('hex'), size: data.length, name: '原片.mp4' } };
}
describe('account-owned LAN original delivery', () => {
    it('streams and checks original bytes, reuses completed uploads, and isolates accounts', async () => {
        const { service, input, data } = await setup();
        const job = await service.prepare('account-b', input); expect(job.state).toBe('upload-required');
        await service.upload('account-b', job.id, Readable.from([data]), data.length, new AbortController().signal);
        const ready = await service.status('account-b', job.id); expect(ready.state).toBe('ready');
        expect(ready.url).toBe('/files/direct/' + job.id); expect(ready.downloadUrl).toBe(ready.url + '?download=1');
        const file = await service.file('account-b', job.id); expect(await readFile(file.path)).toEqual(data);
        await expect(service.file('account-a', job.id)).rejects.toMatchObject({ statusCode: 404 });
        await expect(service.status('account-b', '../secret')).rejects.toMatchObject({ statusCode: 404 });
        expect((await service.prepare('account-b', input)).state).toBe('ready');
    });
    it('never publishes truncated, changed or cancelled uploads and removes their partial files', async () => {
        const { service, input, data, root } = await setup(); const job = await service.prepare('account-b', input);
        await expect(service.upload('account-b', job.id, Readable.from([Buffer.alloc(data.length)]), data.length, new AbortController().signal)).rejects.toMatchObject({ statusCode: 409 });
        const controller = new AbortController(); controller.abort();
        await expect(service.upload('account-b', job.id, Readable.from([data]), data.length, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
        expect((await service.status('account-b', job.id)).state).toBe('upload-required');
        const folder = (await readdir(root))[0]; expect((await readdir(join(root, folder))).filter(p => p.endsWith('.part') || p.endsWith('.bin'))).toEqual([]);
    });
    it('grants NAS originals without copying or disclosing the source path', async () => {
        const { service, data, input, root } = await setup(); const path = join(root, 'original'); await writeFile(path, data);
        const grant = await service.grantSource('account-b', { ...input, path, contentType: 'video/mp4' });
        expect(grant.state).toBe('ready'); expect(JSON.stringify(grant)).not.toContain(path);
        expect((await service.file('account-b', grant.id)).path).toBe(path);
        await expect(service.file('account-a', grant.id)).rejects.toMatchObject({ statusCode: 404 });
    });
});
