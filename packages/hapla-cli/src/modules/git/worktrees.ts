import { randomUUID } from 'node:crypto';
import { mkdir, readFile, realpath, rename, writeFile, lstat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { worktreeRequestSchema, type WorktreeResponse } from '@hapla/wire/gitWorkbench';
import { git, gitDirectory, repository, serialized, within } from './gitProcess';
import { assertWorkspaceExclusive } from './workspaceLease';

type OwnedWorktree = { path: string; branch: string; head: string };
export async function worktreeOperation(input: unknown, allowedRoot?: string): Promise<WorktreeResponse> {
    const request = worktreeRequestSchema.parse(input);
    const root = await realpath(await repository(request.directory));
    if (allowedRoot && !within(await realpath(allowedRoot), root)) throw new Error('Repository is outside the configured workspace root.');
    return serialized(root, async () => {
        const dir = await gitDirectory(root); const ledger = join(dir, 'hapla', 'worktrees.json');
        let owned: OwnedWorktree[];
        try { owned = JSON.parse(await readFile(ledger, 'utf8')); }
        catch (error: any) { if (error.code !== 'ENOENT') throw new Error('Worktree ownership ledger is unreadable.'); owned = []; }
        const save = async () => { await mkdir(join(dir, 'hapla'), { recursive: true }); const temp = ledger + '.' + randomUUID(); await writeFile(temp, JSON.stringify(owned), { mode: 0o600 }); await rename(temp, ledger); };
        if (request.operation === 'list') {
            const blocks = (await git(root, ['worktree', 'list', '--porcelain', '-z'])).split('\0\0');
            return { worktrees: blocks.map(block => {
                const lines = block.split('\0'); return { path: lines.find(line => line.startsWith('worktree '))?.slice(9) ?? '', branch: lines.find(line => line.startsWith('branch '))?.slice(18) ?? '(detached)' };
            }).filter(w => w.path && w.path !== root) };
        }
        if (request.operation === 'create') {
            const name = 'hapla-' + randomUUID().slice(0, 12); const path = join(root, '.dev', 'worktree', name);
            for (const reserved of [join(root, '.dev'), join(root, '.dev', 'worktree')]) {
                const info = await lstat(reserved).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return null; throw error; });
                if (info?.isSymbolicLink()) throw new Error('The managed worktree directory must not be a symbolic link.');
            }
            await mkdir(join(dir, 'info'), { recursive: true });
            const exclude = join(dir, 'info', 'exclude'); const previous = await readFile(exclude, 'utf8').catch(() => '');
            const additions = ['/.dev/worktree/', '/.hapla/'].filter(pattern => !previous.split('\n').includes(pattern));
            if (additions.length) await writeFile(exclude, previous + '\n' + additions.join('\n') + '\n');
            await git(root, ['worktree', 'add', '-b', name, '--', path]);
            const item = { path, branch: name, head: (await git(path, ['rev-parse', 'HEAD'])).trim() };
            try { owned.push(item); await save(); }
            catch (error) { await git(root, ['worktree', 'remove', '--', path]).catch(() => undefined); throw error; }
            return item;
        }
        if (!request.path) throw new Error('Worktree path is required.');
        const path = await realpath(resolve(request.path));
        const record = owned.find(item => item.path === path);
        if (!record || !within(join(root, '.dev', 'worktree'), path)) throw new Error('This worktree is not managed by Hapla. Keep it or remove it with Git.');
        const head = (await git(path, ['rev-parse', 'HEAD'])).trim();
        if (request.expectedHead && head !== request.expectedHead) throw new Error('Worktree HEAD changed. Refresh before removing it.');
        await assertWorkspaceExclusive(path);
        if ((await git(path, ['status', '--porcelain', '--untracked-files=all'])).trim()
            || (await git(path, ['ls-files', '--others', '--ignored', '--exclude-standard'])).trim()) throw new Error('Worktree contains changed, untracked, or ignored files. Keep or move them before removal.');
        await git(root, ['worktree', 'remove', '--', path]);
        owned = owned.filter(item => item.path !== path); await save();
        return { path };
    });
}
