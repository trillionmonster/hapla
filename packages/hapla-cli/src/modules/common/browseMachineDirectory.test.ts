import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, symlink, rm, readdir } from 'node:fs/promises';
import { join, parse } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { browseMachineDirectory } from './browseMachineDirectory';
import { prepareSessionDirectory } from '../../daemon/prepareSessionDirectory';

describe('machine directory navigation and launch validation', () => {
    let root: string;
    beforeEach(async () => {
        root = await mkdtemp(join(tmpdir(), 'hapla-directory-'));
        await mkdir(join(root, '项目 with spaces'));
        await writeFile(join(root, 'file.txt'), 'not a directory');
        await mkdir(join(root, '.hidden'));
        await symlink(join(root, '项目 with spaces'), join(root, 'folder-link'));
        await symlink(join(root, 'file.txt'), join(root, 'file-link'));
        await symlink(join(root, 'absent'), join(root, 'broken-link'));
    });
    afterEach(async () => { await rm(root, { recursive: true, force: true }); });

    it('browses outside the home and sorts real directories and directory links before files', async () => {
        const result = await browseMachineDirectory({ path: root });
        expect(result.success).toBe(true);
        if (!result.success) return;
        expect(result.kind).toBe('directory');
        expect(result.entries.slice(0, 2).every(entry => entry.type === 'directory')).toBe(true);
        expect(result.entries.find(entry => entry.name === 'file-link')?.type).toBe('file');
        expect(result.entries.find(entry => entry.name === 'broken-link')?.type).toBe('other');
        expect(result.entries.some(entry => entry.name === '.hidden')).toBe(false);
        const shown = await browseMachineDirectory({ path: root, showHidden: true });
        expect(shown.success && shown.entries.some(entry => entry.name === '.hidden')).toBe(true);
    });
    it.each(['file.txt', 'file-link', 'file.txt/child', 'broken-link', 'broken-link/child'])('refuses existing non-directories: %s', async name => {
        const result = await browseMachineDirectory({ path: join(root, name), mode: 'check' });
        expect(result).toMatchObject({ success: false, code: 'not_directory' });
        expect((await prepareSessionDirectory(join(root, name), true)).type).toBe('error');
    });
    it('does not create typed paths until session creation is approved', async () => {
        const path = join(root, 'new', 'nested');
        expect(await browseMachineDirectory({ path })).toMatchObject({ success: true, kind: 'missing', path });
        expect(await prepareSessionDirectory(path, false)).toEqual({ type: 'requestToApproveDirectoryCreation', directory: path });
        expect(await readdir(root)).not.toContain('new');
        expect(await prepareSessionDirectory(path, true)).toEqual({ type: 'ready', directory: path, created: true });
        expect(await prepareSessionDirectory(path, false)).toEqual({ type: 'ready', directory: path, created: false });
    });
    it('normalizes home paths and handles filesystem roots', async () => {
        expect(await browseMachineDirectory({ path: '~', mode: 'check' })).toMatchObject({ success: true, path: homedir() });
        expect(await browseMachineDirectory({ path: parse(root).root, mode: 'check' })).toMatchObject({ success: true, parentPath: null });
        expect(await browseMachineDirectory({ path: join(root, '项目 with spaces'), mode: 'check' })).toMatchObject({ success: true, kind: 'directory' });
    });
    it('pages large directories without dropping or repeating entries', async () => {
        await Promise.all(Array.from({ length: 205 }, (_, i) => mkdir(join(root, `dir-${String(i).padStart(3, '0')}`))));
        const first = await browseMachineDirectory({ path: root });
        expect(first.success && first.entries.length).toBe(200);
        if (!first.success) return;
        const second = await browseMachineDirectory({ path: root, offset: first.nextOffset! });
        if (!second.success) throw new Error(second.error);
        expect(second.nextOffset).toBe(null);
        expect(new Set([...first.entries, ...second.entries].map(entry => entry.path)).size).toBe(first.total);
    });
    it('rejects malformed input without filesystem access', async () => {
        for (const path of ['', '\0', '~another-user', 'x'.repeat(32769)]) {
            expect(await browseMachineDirectory({ path })).toMatchObject({ success: false, code: 'invalid_path' });
        }
    });
});
