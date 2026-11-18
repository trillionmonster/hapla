import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FILE_TRANSFER_CHUNK_BYTES, FileTransferManager } from './FileTransferManager';
import { createHash } from 'node:crypto';

const roots: string[] = [];

async function workspace(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'hapla-transfer-'));
    roots.push(root);
    return root;
}

afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('FileTransferManager', () => {
    it('resumes idempotent chunks, verifies the digest, and repeats a lost finish acknowledgement', async () => {
        const root = await workspace();
        const manager = new FileTransferManager(root);
        const bytes = Buffer.from('中文文件\nsecond chunk\n');
        const sha256 = createHash('sha256').update(bytes).digest('hex');
        const begin = await manager.beginUpload('中文 文件.csv', bytes.length, false, sha256);
        if (!begin.success) throw new Error(begin.error);
        const first = bytes.subarray(0, 6).toString('base64');
        expect(await manager.uploadChunk(begin.uploadId, 0, first)).toMatchObject({ success: true, received: 6 });
        expect(await manager.uploadChunk(begin.uploadId, 0, first)).toMatchObject({ success: true, received: 6 });
        expect(manager.uploadStatus(begin.uploadId)).toMatchObject({ received: 6, sha256, complete: false });
        expect(await manager.uploadChunk(begin.uploadId, 6, bytes.subarray(6).toString('base64'))).toMatchObject({ success: true });
        expect(await manager.finishUpload(begin.uploadId)).toMatchObject({ success: true, sha256 });
        expect(await manager.finishUpload(begin.uploadId)).toMatchObject({ success: true, sha256 });
        expect(await readFile(join(root, '中文 文件.csv'))).toEqual(bytes);
        await manager.dispose();
    });

    it('does not publish corrupted files and isolates upload handles between sessions', async () => {
        const root = await workspace();
        const a = new FileTransferManager(root);
        const b = new FileTransferManager(root);
        await writeFile(join(root, 'keep.txt'), 'old');
        const begin = await a.beginUpload('keep.txt', 3, true, '0'.repeat(64));
        if (!begin.success) throw new Error(begin.error);
        expect(b.uploadStatus(begin.uploadId).success).toBe(false);
        expect((await b.uploadChunk(begin.uploadId, 0, 'bmV3')).success).toBe(false);
        await a.uploadChunk(begin.uploadId, 0, 'bmV3');
        expect(await a.finishUpload(begin.uploadId)).toMatchObject({ success: false });
        expect(await readFile(join(root, 'keep.txt'), 'utf8')).toBe('old');
        await a.dispose(); await b.dispose();
    });

    it('refuses mixed file revisions during range transfer', async () => {
        const root = await workspace();
        const manager = new FileTransferManager(root);
        await writeFile(join(root, 'changing.txt'), 'first');
        const info = await manager.downloadInfo('changing.txt');
        if (!info.success) throw new Error(info.error);
        expect(await manager.downloadChunk('changing.txt', 0, 5, info.modified - 1)).toMatchObject({ success: false });
        expect(await manager.downloadChunk('changing.txt', 0, 5, info.modified)).toMatchObject({ success: true, bytesRead: 5 });
        await manager.dispose();
    });
    it('uploads and downloads arbitrary binary content in ordered chunks', async () => {
        const root = await workspace();
        await mkdir(join(root, 'assets'));
        const manager = new FileTransferManager(root);
        const source = Buffer.alloc(FILE_TRANSFER_CHUNK_BYTES + 31, 0xab);

        const begin = await manager.beginUpload('assets/archive.bin', source.length, false);
        expect(begin.success).toBe(true);
        if (!begin.success) return;

        const first = await manager.uploadChunk(begin.uploadId, 0, source.subarray(0, FILE_TRANSFER_CHUNK_BYTES).toString('base64'));
        expect(first).toMatchObject({ success: true, received: FILE_TRANSFER_CHUNK_BYTES });
        const second = await manager.uploadChunk(begin.uploadId, FILE_TRANSFER_CHUNK_BYTES, source.subarray(FILE_TRANSFER_CHUNK_BYTES).toString('base64'));
        expect(second).toMatchObject({ success: true, received: source.length });
        expect(await manager.finishUpload(begin.uploadId)).toMatchObject({ success: true, size: source.length });
        expect(await readFile(join(root, 'assets/archive.bin'))).toEqual(source);

        const info = await manager.downloadInfo('assets/archive.bin');
        expect(info).toMatchObject({ success: true, name: 'archive.bin', size: source.length });
        const chunk = await manager.downloadChunk('assets/archive.bin', FILE_TRANSFER_CHUNK_BYTES, 100);
        expect(chunk.success).toBe(true);
        if (chunk.success) {
            expect(Buffer.from(chunk.content, 'base64')).toEqual(source.subarray(FILE_TRANSFER_CHUNK_BYTES));
            expect(chunk.eof).toBe(true);
        }
    });

    it('publishes only one winner when two uploads race for the same new path', async () => {
        const root = await workspace();
        const manager = new FileTransferManager(root);
        const first = await manager.beginUpload('race.txt', 3, false);
        const second = await manager.beginUpload('race.txt', 3, false);
        if (!first.success || !second.success) throw new Error('Unable to stage uploads');
        await manager.uploadChunk(first.uploadId, 0, 'b25l');
        await manager.uploadChunk(second.uploadId, 0, 'dHdv');
        const results = await Promise.all([manager.finishUpload(first.uploadId), manager.finishUpload(second.uploadId)]);
        expect(results.filter(result => result.success)).toHaveLength(1);
        expect(['one', 'two']).toContain(await readFile(join(root, 'race.txt'), 'utf8'));
        await manager.dispose();
    });

    it('requires explicit overwrite confirmation', async () => {
        const root = await workspace();
        await writeFile(join(root, 'report.txt'), 'old');
        const manager = new FileTransferManager(root);

        const refused = await manager.beginUpload('report.txt', 3, false);
        expect(refused).toMatchObject({ success: false, conflict: true });

        const accepted = await manager.beginUpload('report.txt', 3, true);
        expect(accepted.success).toBe(true);
        if (!accepted.success) return;
        await manager.uploadChunk(accepted.uploadId, 0, Buffer.from('new').toString('base64'));
        expect(await manager.finishUpload(accepted.uploadId)).toMatchObject({ success: true });
        expect(await readFile(join(root, 'report.txt'), 'utf8')).toBe('new');
    });

    it('rejects traversal and symbolic-link escapes', async () => {
        const root = await workspace();
        const outside = await workspace();
        await writeFile(join(outside, 'secret.txt'), 'secret');
        await symlink(outside, join(root, 'escape'));
        const manager = new FileTransferManager(root);

        expect(await manager.downloadInfo('../secret.txt')).toMatchObject({ success: false });
        expect(await manager.downloadInfo('escape/secret.txt')).toMatchObject({ success: false });
        expect(await manager.beginUpload('escape/new.txt', 1, false)).toMatchObject({ success: false });
    });

    it('supports empty files and removes aborted staging files', async () => {
        const root = await workspace();
        const manager = new FileTransferManager(root);
        const begin = await manager.beginUpload('empty.txt', 0, false);
        expect(begin.success).toBe(true);
        if (!begin.success) return;
        expect(await manager.finishUpload(begin.uploadId)).toMatchObject({ success: true, size: 0 });
        expect((await readFile(join(root, 'empty.txt'))).length).toBe(0);

        const aborted = await manager.beginUpload('cancelled.txt', 4, false);
        expect(aborted.success).toBe(true);
        if (!aborted.success) return;
        await manager.abortUpload(aborted.uploadId);
        await expect(readFile(join(root, 'cancelled.txt'))).rejects.toThrow();
    });
});
