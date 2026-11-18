import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, writeFile, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { NasFileSource } from './nasFileSource';
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(p => rm(p, { recursive: true, force: true }))); });
async function setup() {
    const root = await mkdtemp(join(tmpdir(), 'hapla-nas-')); roots.push(root); await writeFile(join(root, 'original'), 'video');
    const row = { source_path: 'original', size_bytes: '5', sha256: 'a'.repeat(64), content_type: 'video/mp4', display_name: '原片.mp4' };
    const query = vi.fn(async (_key: string) => row);
    return { root, row, query, source: new NasFileSource({ root, query, origin: 'https://test.r2.cloudflarestorage.com/video' }) };
}
describe('read-only NAS mapping for old R2 links', () => {
    it('resolves expired signatures locally using an exact bucket and key without requesting R2', async () => {
        const { source, root, query } = await setup();
        const result = await source.resolve('https://test.r2.cloudflarestorage.com/video/old%20key?X-Amz-Date=20000101T000000Z&X-Amz-Expires=1');
        expect(query).toHaveBeenCalledWith('old key'); expect(result.path).toBe(join(root, 'original')); expect(result.name).toBe('原片.mp4');
    });
    it('rejects other endpoints and bucket prefixes before consulting the index', async () => {
        const { source, query } = await setup();
        for (const url of ['http://test.r2.cloudflarestorage.com/video/key', 'https://test.r2.cloudflarestorage.com/video-other/key', 'https://evil.test/video/key', 'https://test.r2.cloudflarestorage.com/video/', 'https://user@test.r2.cloudflarestorage.com/video/key']) await expect(source.resolve(url)).rejects.toMatchObject({ statusCode: 400 });
        expect(query).not.toHaveBeenCalled();
    });
    it('refuses absent, changed or escaping originals, including symlinks', async () => {
        const { source, root, query, row } = await setup();
        const url = 'https://test.r2.cloudflarestorage.com/video/key';
        query.mockResolvedValueOnce(undefined as any); await expect(source.resolve(url)).rejects.toMatchObject({ statusCode: 404 });
        row.size_bytes = '6'; await expect(source.resolve(url)).rejects.toMatchObject({ statusCode: 409 });
        row.source_path = '/etc/passwd'; await expect(source.resolve(url)).rejects.toMatchObject({ statusCode: 404 });
        await symlink('/etc/passwd', join(root, 'link')); row.source_path = 'link'; await expect(source.resolve(url)).rejects.toMatchObject({ statusCode: 404 });
    });
});
