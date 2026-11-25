import { describe, it, expect } from 'vitest';
import { mkdtemp, readFile, writeFile, rm, mkdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GitWorkbench } from './workbench';
import { WorkspaceCheckpoints } from './checkpoints';
import { git, serialized } from './gitProcess';
import { worktreeOperation } from './worktrees';
import { claimWorkspace } from './workspaceLease';

async function fixture() {
    const root = await mkdtemp(join(tmpdir(), 'hapla git space-'));
    await git(root, ['init', '-b', 'main']); await git(root, ['config', 'user.name', 'Test']); await git(root, ['config', 'user.email', 'test@example.test']);
    await writeFile(join(root, 'file.txt'), 'original\n'); await git(root, ['add', '.']); await git(root, ['commit', '-m', 'initial']);
    return root;
}
describe('source control against real Git repositories', () => {
    it('can review and make the first commit of an unborn repository', async () => {
        const root = await mkdtemp(join(tmpdir(), 'hapla-first-'));
        try {
            await git(root, ['init', '-b', 'main']); await git(root, ['config', 'user.name', 'Test']); await git(root, ['config', 'user.email', 'test@example.test']);
            await writeFile(join(root, 'first.txt'), 'first content'); const wb = new GitWorkbench(root);
            expect((await wb.execute({ operation: 'status' })).files?.[0].path).toBe('first.txt');
            expect((await wb.execute({ operation: 'diff' })).text).toContain('+first content');
            await wb.execute({ operation: 'stage', path: 'first.txt' });
            expect((await wb.execute({ operation: 'diff', source: 'staged' })).text).toContain('+first content');
            await wb.execute({ operation: 'unstage', path: 'first.txt' });
            expect((await wb.execute({ operation: 'diff', source: 'staged' })).text).toBe('');
            expect(await readFile(join(root, 'first.txt'), 'utf8')).toBe('first content');
            await wb.execute({ operation: 'stage', path: 'first.txt' });
            await wb.execute({ operation: 'commit', message: 'first' });
            expect((await wb.execute({ operation: 'log' })).commits?.[0].subject).toBe('first');
        } finally { await rm(root, { recursive: true, force: true }); }
    });

    it('reviews new, staged, working, and committed files, preserves draft failures, and pushes to a local remote', async () => {
        const root = await fixture(); const remote = await mkdtemp(join(tmpdir(), 'hapla-bare-'));
        try {
            await git(remote, ['init', '--bare']); await git(root, ['remote', 'add', 'origin', remote]);
            const wb = new GitWorkbench(root);
            await writeFile(join(root, 'new file.txt'), 'new content\n');
            expect((await wb.execute({ operation: 'diff', source: 'working' })).text).toContain('+new content');
            await wb.execute({ operation: 'stage', path: 'new file.txt' });
            expect((await wb.execute({ operation: 'diff', source: 'staged' })).text).toContain('+new content');
            await writeFile(join(root, 'new file.txt'), 'second edit\n');
            expect((await wb.execute({ operation: 'diff', source: 'working' })).text).toContain('+second edit');
            await expect(wb.execute({ operation: 'commit', message: 'commit', expectedRevision: '0'.repeat(64) })).rejects.toThrow('Workspace changed');
            await wb.execute({ operation: 'commit', message: 'new file' });
            const committed = await wb.execute({ operation: 'diff', source: 'commit', ref: 'HEAD' });
            expect(committed.text).toContain('+new content');
            expect(committed.files?.map(file => file.path)).toEqual(['new file.txt']);
            await wb.execute({ operation: 'push' });
            expect((await git(remote, ['rev-parse', 'refs/heads/main'])).trim()).toBe((await git(root, ['rev-parse', 'HEAD'])).trim());
            await expect(wb.execute({ operation: 'stage', path: '../escape' })).rejects.toThrow('Invalid repository path');
            await expect(wb.execute({ operation: 'diff', source: 'commit', ref: '--help' })).rejects.toThrow('Invalid Git revision');
        } finally { await rm(root, { recursive: true, force: true }); await rm(remote, { recursive: true, force: true }); }
    });
    it('pages large UTF-8 diffs without silently truncating or mixing revisions', async () => {
        const root = await fixture();
        try {
            const content = Array.from({ length: 25_000 }, (_, i) => `${i}: 中文 mixed content\n`).join('');
            await writeFile(join(root, 'large.txt'), content); const wb = new GitWorkbench(root);
            let page = await wb.execute({ operation: 'diff' }); let text = page.text!;
            expect(page.nextOffset).not.toBeNull();
            while (page.nextOffset != null) { page = await wb.execute({ operation: 'diff', offset: page.nextOffset, expectedRevision: page.revision }); text += page.text; }
            expect(text).toContain('+24999: 中文 mixed content'); expect(text).not.toContain('�');
            const first = await wb.execute({ operation: 'diff' }); await writeFile(join(root, 'large.txt'), 'changed');
            await expect(wb.execute({ operation: 'diff', offset: first.nextOffset!, expectedRevision: first.revision })).rejects.toThrow('Diff changed');
        } finally { await rm(root, { recursive: true, force: true }); }
    });
    it('preserves the real index and branch while checkpointing and restores files only in an exclusive worktree', async () => {
        const root = await fixture(); let path = '';
        try {
            const wt = await worktreeOperation({ operation: 'create', directory: root }); path = wt.path!;
            const cp = new WorkspaceCheckpoints(path, 'session'); const beforeHead = await git(path, ['rev-parse', 'HEAD']);
            await writeFile(join(path, 'file.txt'), 'staged baseline\n'); await git(path, ['add', '.']);
            await writeFile(join(path, 'file.txt'), 'working baseline\n');
            const entry = await cp.begin('task', { threadId: 'native-thread' });
            expect(await git(path, ['rev-parse', 'HEAD'])).toBe(beforeHead);
            expect(await git(path, ['show', ':file.txt'])).toBe('staged baseline\n');
            await writeFile(join(path, 'file.txt'), 'agent change\n'); await writeFile(join(path, 'new.txt'), 'new\n');
            await cp.finish(entry.id, 'turn', 'complete');
            const revision = await cp.revision();
            await expect(serialized(path, async () => {
                const target = await cp.prepareRestore(entry.id, revision);
                await cp.restoreFiles(target, async () => { throw new Error('metadata unavailable'); });
            })).rejects.toThrow('metadata unavailable');
            expect(await readFile(join(path, 'file.txt'), 'utf8')).toBe('agent change\n');
            expect(await git(path, ['show', ':file.txt'])).toBe('staged baseline\n');
            const release = await claimWorkspace(path, 'another-session');
            await expect(cp.prepareRestore(entry.id, revision)).rejects.toThrow('Another session'); await release();
            await expect(cp.prepareRestore(entry.id, '0'.repeat(64))).rejects.toThrow('Workspace changed');
            await serialized(path, async () => { const target = await cp.prepareRestore(entry.id, revision); await cp.restoreFiles(target); });
            expect(await readFile(join(path, 'file.txt'), 'utf8')).toBe('working baseline\n');
            expect(await git(path, ['show', ':file.txt'])).toBe('staged baseline\n');
            await expect(readFile(join(path, 'new.txt'))).rejects.toThrow();
            expect(await git(path, ['rev-parse', 'HEAD'])).toBe(beforeHead);
            await expect(worktreeOperation({ operation: 'remove', directory: root, path })).rejects.toThrow('contains changed');
            const mainCp = new WorkspaceCheckpoints(root, 'main'); const manual = await mainCp.begin('main');
            await expect(mainCp.prepareRestore(manual.id, await mainCp.revision())).rejects.toThrow('separate Git worktree');
        } finally { if (path) await git(root, ['worktree', 'remove', '--force', '--', path]); await rm(root, { recursive: true, force: true }); }
    });
    it('rejects repository scope escapes and symlinked managed directories', async () => {
        const root = await fixture(); const outside = await mkdtemp(join(tmpdir(), 'hapla-outside-'));
        try {
            await expect(worktreeOperation({ operation: 'create', directory: root }, join(root, '.git'))).rejects.toThrow('outside');
            await symlink(outside, join(root, '.dev'));
            await expect(worktreeOperation({ operation: 'create', directory: root }, root)).rejects.toThrow('symbolic link');
            expect((await worktreeOperation({ operation: 'list', directory: root })).worktrees).toHaveLength(0);
        } finally { await rm(root, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); }
    });
    it('cleans only owned, unused, unchanged worktrees, including paths with spaces', async () => {
        const root = await fixture();
        try {
            const wt = await worktreeOperation({ operation: 'create', directory: root });
            expect((await worktreeOperation({ operation: 'list', directory: root })).worktrees?.some(w => w.path === wt.path)).toBe(true);
            const release = await claimWorkspace(wt.path!, 'alive');
            await expect(worktreeOperation({ operation: 'remove', directory: root, path: wt.path })).rejects.toThrow('Another session'); await release();
            await expect(worktreeOperation({ operation: 'remove', directory: root, path: wt.path, expectedHead: '0'.repeat(40) })).rejects.toThrow('HEAD changed');
            await worktreeOperation({ operation: 'remove', directory: root, path: wt.path, expectedHead: wt.head });
            expect((await worktreeOperation({ operation: 'list', directory: root })).worktrees).toHaveLength(0);
        } finally { await rm(root, { recursive: true, force: true }); }
    });
});
