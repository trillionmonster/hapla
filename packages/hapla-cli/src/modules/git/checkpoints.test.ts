import { it, expect } from 'vitest';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { git } from './gitProcess';
import { WorkspaceCheckpoints } from './checkpoints';

it('captures turns before the first commit without changing HEAD or the staged baseline', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hapla-unborn-checkpoint-'));
    try {
        await git(root, ['init', '-b', 'main']);
        await writeFile(join(root, 'file.txt'), 'staged\n'); await git(root, ['add', '.']);
        await writeFile(join(root, 'file.txt'), 'working\n');
        const cp = new WorkspaceCheckpoints(root, 'session');
        const revision = await cp.revision();
        const point = await cp.begin('first turn');
        expect(point.head).toBeNull();
        expect(await git(root, ['show', point.before + ':file.txt'])).toBe('working\n');
        expect(await git(root, ['show', point.indexTree + ':file.txt'])).toBe('staged\n');
        expect(await cp.revision()).toBe(revision);
        await expect(git(root, ['rev-parse', '--verify', 'HEAD'])).rejects.toThrow();
        expect((await git(root, ['symbolic-ref', 'HEAD'])).trim()).toBe('refs/heads/main');
        await writeFile(join(root, 'file.txt'), 'after turn\n');
        const completed = await cp.finish(point.id, 'turn', 'complete');
        expect(await git(root, ['show', completed.after + ':file.txt'])).toBe('after turn\n');
        expect(await git(root, ['show', ':file.txt'])).toBe('staged\n');
        expect(await readFile(join(root, 'file.txt'), 'utf8')).toBe('after turn\n');
        expect((await cp.list())[0].status).toBe('complete');
    } finally { await rm(root, { recursive: true, force: true }); }
});

it('restores an unborn worktree, then refuses restoration after its first commit', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hapla-orphan-checkpoint-')); const worktree = root + '-worktree';
    try {
        await git(root, ['init', '-b', 'main']); await git(root, ['config', 'user.name', 'Test']); await git(root, ['config', 'user.email', 'test@example.test']);
        await writeFile(join(root, 'base.txt'), 'base'); await git(root, ['add', '.']); await git(root, ['commit', '-m', 'base']);
        await git(root, ['worktree', 'add', '-b', 'temporary', worktree]);
        await git(worktree, ['checkout', '--orphan', 'first']);
        await writeFile(join(worktree, 'base.txt'), 'before');
        const cp = new WorkspaceCheckpoints(worktree, 'session'); const point = await cp.begin('before first commit');
        await writeFile(join(worktree, 'base.txt'), 'after');
        await cp.restoreFiles(await cp.prepareRestore(point.id, await cp.revision()));
        expect(await readFile(join(worktree, 'base.txt'), 'utf8')).toBe('before');
        expect(await git(worktree, ['show', ':base.txt'])).toBe('base');
        await expect(git(worktree, ['rev-parse', '--verify', 'HEAD'])).rejects.toThrow();
        const revision = await cp.revision();
        await git(worktree, ['symbolic-ref', 'HEAD', 'refs/heads/different']);
        expect(await cp.revision()).not.toBe(revision);
        await expect(cp.prepareRestore(point.id, await cp.revision())).rejects.toThrow('HEAD changed');
        await git(worktree, ['symbolic-ref', 'HEAD', 'refs/heads/first']);
        await git(worktree, ['commit', '-m', 'first']);
        await expect(cp.prepareRestore(point.id, await cp.revision())).rejects.toThrow('HEAD changed');
    } finally { await git(root, ['worktree', 'remove', '--force', worktree]).catch(() => {}); await rm(root, { recursive: true, force: true }); }
});

it('does not treat an existing non-commit HEAD or a non-repository as unborn', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hapla-invalid-checkpoint-'));
    try {
        const cp = new WorkspaceCheckpoints(root, 'session');
        await expect(cp.head()).rejects.toThrow('not a git repository');
        await git(root, ['init', '-b', 'main']);
        await writeFile(join(root, 'blob.txt'), 'not a commit');
        const blob = (await git(root, ['hash-object', '-w', 'blob.txt'])).trim();
        await writeFile(join(root, '.git', 'refs', 'heads', 'main'), blob + '\n');
        await expect(cp.begin('invalid HEAD')).rejects.toThrow('git failed');
        expect(await cp.list()).toEqual([]);
    } finally { await rm(root, { recursive: true, force: true }); }
});
