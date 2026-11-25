import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { gitWorkbenchRequestSchema, type GitWorkbenchResponse } from '@hapla/wire/gitWorkbench';
import { command, git, repository, serialized, within, gitDirectory } from './gitProcess';
import { WorkspaceCheckpoints } from './checkpoints';

export class GitWorkbench {
    constructor(readonly root: string, readonly sessionId = 'workspace') {}
    private checkpoints() { return new WorkspaceCheckpoints(this.root, this.sessionId); }
    private async ref(value: string) {
        if (value.startsWith('-') || /[\0\r\n]/.test(value)) throw new Error('Invalid Git revision.');
        return (await git(this.root, ['rev-parse', '--verify', '--end-of-options', value + '^{commit}'])).trim();
    }
    private path(value: string) {
        if (value.startsWith('/') || value.split(/[\\/]/).some(p => p === '..') || value.includes('\0')) throw new Error('Invalid repository path.');
        return ':(literal)' + value;
    }
    async execute(input: unknown): Promise<GitWorkbenchResponse> {
        const request = gitWorkbenchRequestSchema.parse(input);
        const root = await realpath(await repository(this.root));
        if (!within(await realpath(this.root), root)) throw new Error('Open the repository root to use source control.');
        if (request.operation === 'checkpoint') return { checkpoints: [await this.checkpoints().begin(request.message ?? 'Manual checkpoint', {}, true)] };
        if (['stage', 'unstage', 'commit', 'push', 'pr-create'].includes(request.operation)) {
            return serialized(root, async () => {
                if (request.expectedRevision && await this.checkpoints().revision() !== request.expectedRevision) throw new Error('Workspace changed. Refresh before applying this action.');
                return this.run(request);
            });
        }
        return this.run(request);
    }
    private async base(preferred?: string) {
        if (preferred) return this.ref(preferred);
        for (const candidate of ['refs/remotes/origin/HEAD', 'refs/heads/main', 'refs/heads/master']) {
            try { return await this.ref(candidate); } catch { /* Try the next locally available base. */ }
        }
        return this.ref('HEAD').catch(() => this.checkpoints().emptyTree());
    }
    private async run(request: ReturnType<typeof gitWorkbenchRequestSchema.parse>): Promise<GitWorkbenchResponse> {
        const checkpoints = this.checkpoints();
        switch (request.operation) {
            case 'status': {
                const raw = (await git(this.root, ['status', '--porcelain=v1', '-z', '--untracked-files=all'])).split('\0');
                const files = [];
                for (let i = 0; i < raw.length; i++) {
                    const row = raw[i]; if (!row) continue;
                    const item = { path: row.slice(3), index: row[0], working: row[1], originalPath: undefined as string | undefined };
                    if ('RC'.includes(item.index) || 'RC'.includes(item.working)) item.originalPath = raw[++i];
                    if (!item.path.startsWith('.dev/worktree/')) files.push(item);
                }
                return { isWorktree: await gitDirectory(this.root) !== (await git(this.root, ['rev-parse', '--absolute-git-dir'])).trim(), root: this.root, branch: (await git(this.root, ['branch', '--show-current'])).trim(), head: await this.ref('HEAD').catch(() => undefined), files,
                    revision: await checkpoints.revision(), base: await this.base() };
            }
            case 'log': {
                if (!await this.ref('HEAD').catch(() => null)) return { commits: [] };
                const raw = await git(this.root, ['log', '-100', '--format=%H%x00%s%x00']);
                const fields = raw.split('\0'); const commits = [];
                for (let i = 0; i + 1 < fields.length; i += 2) commits.push({ id: fields[i].trim(), subject: fields[i + 1] });
                return { commits };
            }
            case 'diff': {
                const source = request.source ?? 'working';
                const tail = request.path ? ['--', this.path(request.path)] : ['--', '.', ':!/.dev/worktree'];
                let args: string[]; let names: string[];
                if (source === 'commit') {
                    const commit = await this.ref(request.ref ?? 'HEAD');
                    args = ['show', '--format=', '--no-ext-diff', '--no-textconv', '--binary', commit, ...tail];
                    names = ['diff-tree', '--root', '--no-commit-id', '--name-status', '-r', '-z', commit];
                }
                else {
                    let from: string; let to: string;
                    if (source === 'turn') {
                        const cp = (await checkpoints.list()).find(c => c.id === request.checkpointId);
                        if (!cp) throw new Error('Select a checkpoint.');
                        from = cp.before; to = cp.after ?? await checkpoints.workingTree();
                    } else if (source === 'staged') { from = await this.ref('HEAD').catch(() => checkpoints.emptyTree()); to = (await git(this.root, ['write-tree'])).trim(); }
                    else { from = source === 'branch' ? (await this.ref('HEAD').catch(() => null) ? await git(this.root, ['merge-base', await this.base(request.base), 'HEAD']).then(x => x.trim()) : await checkpoints.emptyTree()) : (await git(this.root, ['write-tree'])).trim(); to = await checkpoints.workingTree(); }
                    args = ['diff', '--no-ext-diff', '--no-textconv', '--binary', from, to, ...tail];
                    names = ['diff', '--name-status', '-z', from, to, '--', '.', ':!/.dev/worktree'];
                }
                const [body, changed] = await Promise.all([git(this.root, args), git(this.root, names)]);
                const entries = changed.split('\0'); const files = [];
                for (let i = 0; i < entries.length; i++) {
                    const kind = entries[i]; if (!kind) continue;
                    const original = entries[++i];
                    const renamed = kind.startsWith('R') || kind.startsWith('C');
                    files.push({ path: renamed ? entries[++i] : original, originalPath: renamed ? original : undefined, index: ' ', working: kind[0] });
                }
                const buffer = Buffer.from(body);
                const revision = createHash('sha256').update(buffer).digest('hex');
                if (request.expectedRevision && request.expectedRevision !== revision) throw new Error('Diff changed. Refresh before loading more.');
                const offset = request.offset ?? 0;
                if (offset < buffer.length && (buffer[offset] & 0xc0) === 0x80) throw new Error('Diff offset is not at a UTF-8 boundary. Refresh the diff.'); const end = Math.min(buffer.length, offset + 128 * 1024);
                // Offsets refer to UTF-8 byte boundaries; do not split a code point across pages.
                let boundary = end; while (boundary < buffer.length && (buffer[boundary] & 0xc0) === 0x80) boundary--;
                return { files, revision, text: buffer.subarray(offset, boundary).toString('utf8'), totalBytes: buffer.length, nextOffset: boundary < buffer.length ? boundary : null };
            }
            case 'stage':
                if (!request.path) throw new Error('Choose a file to stage.');
                await git(this.root, ['add', '--', this.path(request.path)]); return { message: 'Staged.' };
            case 'unstage':
                if (!request.path) throw new Error('Choose a file to unstage.');
                if (await this.ref('HEAD').catch(() => null)) await git(this.root, ['restore', '--staged', '--', this.path(request.path)]);
                else await git(this.root, ['reset', '--quiet', await this.checkpoints().emptyTree(), '--', this.path(request.path)]);
                return { message: 'Unstaged.' };
            case 'commit':
                if (!request.message) throw new Error('A commit message is required.');
                await git(this.root, ['commit', '-m', request.message]); return { message: 'Committed staged changes.', head: await this.ref('HEAD') };
            case 'push': {
                const branch = (await git(this.root, ['branch', '--show-current'])).trim();
                if (!branch) throw new Error('Cannot push a detached HEAD.');
                return { message: await git(this.root, ['push', '--set-upstream', 'origin', `HEAD:refs/heads/${branch}`]) || 'Pushed.' };
            }
            case 'pr-create': {
                if (!request.title?.trim()) throw new Error('A pull request title is required.');
                const args = ['pr', 'create', '--draft', '--title', request.title, '--body', request.body ?? ''];
                if (request.base) args.push('--base', request.base);
                return { pr: { url: (await command(this.root, 'gh', args)).trim() }, message: 'Draft pull request created.' };
            }
            case 'pr-status': {
                try {
                    const result = JSON.parse(await command(this.root, 'gh', ['pr', 'view', '--json', 'url,state,statusCheckRollup']));
                    return { pr: { url: result.url, state: result.state, checks: (result.statusCheckRollup ?? []).map((check: any) => ({ name: check.name ?? check.context, status: check.status ?? check.state, conclusion: check.conclusion })) } };
                } catch (error) {
                    if (/no pull requests? found|no pull requests? associated/i.test(String(error))) return { pr: null };
                    throw error;
                }
            }
            case 'checkpoints': return { checkpoints: await checkpoints.list() };
            case 'checkpoint':
                // begin takes the same repository lock itself.
                throw new Error('Manual checkpoints are created through checkpoint-create.');
        }
    }
}
