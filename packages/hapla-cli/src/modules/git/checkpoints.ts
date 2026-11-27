import { devNull } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { GitCheckpoint } from '@hapla/wire';
import { git, gitDirectory, serialized } from './gitProcess';
import { assertWorkspaceExclusive } from './workspaceLease';

type SavedCheckpoint = GitCheckpoint & { head: string | null; headRef?: string; indexTree: string };
const identity = { GIT_AUTHOR_NAME: 'Hapla checkpoint', GIT_AUTHOR_EMAIL: 'checkpoint@hapla.local', GIT_COMMITTER_NAME: 'Hapla checkpoint', GIT_COMMITTER_EMAIL: 'checkpoint@hapla.local' };
export class WorkspaceCheckpoints {
    constructor(readonly root: string, readonly sessionId: string, readonly leaseSessionId = sessionId) {}
    private get key() { return createHash('sha256').update(this.sessionId).digest('hex'); }
    private async file() { return join(await gitDirectory(this.root), 'hapla', 'checkpoints', this.key + '.json'); }
    async list(): Promise<SavedCheckpoint[]> {
        try { return JSON.parse(await readFile(await this.file(), 'utf8')); }
        catch (error: any) { if (error.code === 'ENOENT') return []; throw new Error('Checkpoint ledger is unreadable.'); }
    }
    private async save(items: SavedCheckpoint[]) {
        const file = await this.file(); await mkdir(join(await gitDirectory(this.root), 'hapla', 'checkpoints'), { recursive: true });
        const temporary = file + '.' + randomUUID(); await writeFile(temporary, JSON.stringify(items), { mode: 0o600 }); await rename(temporary, file);
    }
    async head(): Promise<string | null> {
        try { return (await git(this.root, ['rev-parse', '--verify', 'HEAD^{commit}'])).trim(); }
        catch (error) {
            // Only a missing symbolic branch is unborn. Invalid repositories or
            // existing refs that cannot resolve to a commit must still fail.
            const branch = await git(this.root, ['symbolic-ref', '--quiet', 'HEAD']).then(value => value.trim()).catch(() => { throw error; });
            const refs = await git(this.root, ['for-each-ref', '--format=%(refname)', '--', branch]);
            if (refs.split('\n').includes(branch)) throw error;
            return null;
        }
    }
    async workingTree(): Promise<string> {
        const index = join(await gitDirectory(this.root), 'hapla', 'index-' + randomUUID());
        await mkdir(join(await gitDirectory(this.root), 'hapla'), { recursive: true });
        const env = { GIT_INDEX_FILE: index };
        try {
            const head = await this.head();
            await git(this.root, head ? ['read-tree', head] : ['read-tree', '--empty'], env);
            await git(this.root, ['add', '-A', '--', '.'], env);
            return (await git(this.root, ['write-tree'], env)).trim();
        } finally { await rm(index, { force: true }); await rm(index + '.lock', { force: true }); }
    }
    async emptyTree() { return (await git(this.root, ['hash-object', '-t', 'tree', '-w', devNull])).trim(); }
    async revision() {
        const [head, index, tree] = await Promise.all([this.head(), git(this.root, ['write-tree']), this.workingTree()]);
        const boundary = head ?? 'unborn:' + (await git(this.root, ['symbolic-ref', '--quiet', 'HEAD'])).trim();
        return createHash('sha256').update(boundary + '\0' + index + '\0' + tree).digest('hex');
    }
    async snapshotTree(tree: string, label: string) {
        const commit = (await git(this.root, ['commit-tree', tree, '-m', label], identity)).trim();
        await git(this.root, ['update-ref', `refs/hapla/checkpoints/${this.key}/${randomUUID()}`, commit]);
        return commit;
    }
    async begin(label: string, details: Pick<GitCheckpoint, 'threadId' | 'previousTurnId' | 'branchId' | 'forkMessageId' | 'forkMessageCreatedAt' | 'nativeRestoreThreadId' | 'emptyThread'> = {}, manual = false) {
        return serialized(this.root, async () => {
            const head = await this.head();
            const headRef = head === null ? (await git(this.root, ['symbolic-ref', '--quiet', 'HEAD'])).trim() : undefined;
            const tree = await this.workingTree();
            const entry: SavedCheckpoint = { id: randomUUID(), label: label.slice(0, 160), createdAt: Date.now(),
                before: await this.snapshotTree(tree, label), head, headRef,
                indexTree: await this.snapshotTree((await git(this.root, ['write-tree'])).trim(), label + ' (index)'), status: manual ? 'manual' : 'pending', ...details };
            await this.save([...(await this.list()), entry]); return entry;
        });
    }
    async finish(id: string, turnId: string | undefined, status: GitCheckpoint['status']) {
        return serialized(this.root, async () => {
            const items = await this.list(); const item = items.find(c => c.id === id);
            if (!item) throw new Error('Checkpoint does not exist.');
            item.after = await this.snapshotTree(await this.workingTree(), item.label);
            item.status = status; item.turnId = turnId; await this.save(items); return item;
        });
    }
    async prepareRestore(id: string, expectedRevision: string) {
        const checkpoint = (await this.list()).find(c => c.id === id);
        if (!checkpoint) throw new Error('Checkpoint does not exist.');
        if (!(await git(this.root, ['rev-parse', '--is-inside-work-tree'])).trim().includes('true')
            || (await gitDirectory(this.root)) === (await git(this.root, ['rev-parse', '--absolute-git-dir'])).trim()) {
            throw new Error('Restore is available only inside a separate Git worktree.');
        }
        await assertWorkspaceExclusive(this.root, this.leaseSessionId);
        if (await this.head() !== checkpoint.head) throw new Error('HEAD changed since this checkpoint. Review the newer commits before restoring.');
        if (checkpoint.head === null && (await git(this.root, ['symbolic-ref', '--quiet', 'HEAD'])).trim() !== checkpoint.headRef) throw new Error('HEAD changed since this checkpoint. Switch to the original branch before restoring.');
        if (await this.revision() !== expectedRevision) throw new Error('Workspace changed. Refresh and review it before restoring.');
        const ignored = (await git(this.root, ['ls-files', '-z', '--others', '--ignored', '--exclude-standard'])).split('\0').filter(Boolean);
        const targets = (await git(this.root, ['ls-tree', '-r', '--name-only', '-z', checkpoint.before])).split('\0');
        if (ignored.some(path => targets.some(target => target === path || target.startsWith(path + '/') || path.startsWith(target + '/')))) throw new Error('An ignored file overlaps the checkpoint. Move it before restoring.');
        return checkpoint;
    }
    // Caller holds the repository lock and has already prepared native conversation restoration.
    async restoreFiles(checkpoint: SavedCheckpoint, finalize?: () => Promise<void>) {
        const rescueTree = await this.workingTree(); const rescueIndex = await this.snapshotTree((await git(this.root, ['write-tree'])).trim(), 'Index before checkpoint restore');
        const rescue = await this.snapshotTree(rescueTree, 'Before checkpoint restore');
        const apply = async (tree: string, index: string) => {
            await git(this.root, ['read-tree', await this.workingTree()]);
            await git(this.root, ['read-tree', '--reset', '-u', tree]);
            await git(this.root, ['read-tree', index]);
        };
        try { await apply(checkpoint.before, checkpoint.indexTree); await finalize?.(); }
        catch (error) {
            try { await apply(rescue, rescueIndex); }
            catch { throw new Error(`Restore failed. Recovery snapshot retained at ${rescue}; inspect the workspace before continuing.`); }
            throw error;
        }
        return rescue;
    }
}
