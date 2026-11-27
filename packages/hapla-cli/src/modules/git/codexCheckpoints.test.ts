import { it, expect } from 'vitest';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { git } from './gitProcess';
import { worktreeOperation } from './worktrees';
import { WorkspaceCheckpoints } from './checkpoints';
import { installCodexCheckpoints } from './codexCheckpoints';

it.each([true, false])('captures automatic and manual native checkpoints in an unborn repository (fresh=%s)', async fresh => {
    const root = await mkdtemp(join(tmpdir(), 'hapla-native-unborn-'));
    try {
        await git(root, ['init', '-b', 'main']); await writeFile(join(root, 'f'), 'before');
        const handlers = new Map<string, (value?: any) => Promise<any>>(); let forks = 0;
        const client = { isFreshThread: fresh, threadId: 'original', requestRaw: async (method: string) => {
            expect(method).toBe('thread/fork'); forks++; return { thread: { id: 'saved-native-' + forks } };
        } };
        const controller = installCodexCheckpoints({ root, client: client as any, session: { sessionId: 'sid', getMetadata: () => ({ conversationRootSessionId: 'sid' }),
            rpcHandlerManager: { registerHandler: (key: string, handler: any) => handlers.set(key, handler) },
        } as any, isBusy: () => false, branch: () => 'original', setBranch: () => {} });
        const point = await controller.begin('first turn');
        expect(point.emptyThread).toBe(fresh); expect(point.nativeRestoreThreadId).toBe(fresh ? undefined : 'saved-native-1');
        await writeFile(join(root, 'f'), 'after'); await controller.finish(point.id, 'turn', 'complete');
        const manual = await handlers.get('git-checkpoint-create')!();
        expect(manual.status).toBe('manual'); expect(forks).toBe(fresh ? 0 : 2);
        const diff = await handlers.get('git-workbench')!({ operation: 'diff', source: 'turn', checkpointId: point.id });
        expect(diff.text).toContain('-before'); expect(diff.text).toContain('+after');
        await expect(git(root, ['rev-parse', '--verify', 'HEAD'])).rejects.toThrow();
    } finally { await rm(root, { recursive: true, force: true }); }
});

it('keeps files intact on native failure, rejects intervening edits, and restores with the exact conversation boundary', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hapla-restore-')); let directory = '';
    try {
        await git(root, ['init', '-b', 'main']); await git(root, ['config', 'user.name', 'Test']); await git(root, ['config', 'user.email', 'test@example.test']);
        await writeFile(join(root, 'f'), 'base'); await git(root, ['add', '.']); await git(root, ['commit', '-m', 'initial']);
        directory = (await worktreeOperation({ operation: 'create', directory: root })).path!;
        const cp = new WorkspaceCheckpoints(directory, 'sid');
        const point = await cp.begin('question', { threadId: 'original', previousTurnId: 'kept-turn', forkMessageId: 'persisted-question', forkMessageCreatedAt: 1000 });
        await writeFile(join(directory, 'f'), 'agent edit'); await cp.finish(point.id, 'removed-turn', 'complete');
        const handlers = new Map<string, (value: any) => Promise<any>>(); let metadata: any = {}; let failure = true; let race = false; let busy = false;
        const client = { threadId: 'original',
            forkThread: async (options: any) => { expect(options.lastTurnId).toBe('kept-turn'); expect(options.deferGoalContinuation).toBe(true); if (failure) throw new Error('native unavailable'); if (race) await writeFile(join(directory, 'f'), 'human edit'); client.threadId = 'fork'; return { threadId: 'fork' }; },
            resumeThread: async ({ threadId }: any) => { client.threadId = threadId; },
        };
        const controller = installCodexCheckpoints({ root: directory, client: client as any, session: { sessionId: 'sid', getMetadata: () => ({}),
            rpcHandlerManager: { registerHandler: (key: string, handler: any) => handlers.set(key, handler), unregisterHandler: (key: string) => handlers.delete(key) }, updateMetadata: async (fn: any) => { metadata = fn(metadata); },
        } as any, isBusy: () => busy, branch: () => 'original', setBranch: () => {} });
        const restore = handlers.get('git-checkpoint-restore')!;
        await expect(restore({ id: point.id, revision: await cp.revision() })).rejects.toThrow('native unavailable');
        expect(await readFile(join(directory, 'f'), 'utf8')).toBe('agent edit');
        failure = false; race = true;
        await expect(restore({ id: point.id, revision: await cp.revision() })).rejects.toThrow('Workspace changed');
        expect(client.threadId).toBe('original'); expect(await readFile(join(directory, 'f'), 'utf8')).toBe('human edit');
        race = false; busy = true;
        await expect(restore({ id: point.id, revision: await cp.revision() })).rejects.toThrow('idle');
        busy = false; await restore({ id: point.id, revision: await cp.revision() });
        expect(await readFile(join(directory, 'f'), 'utf8')).toBe('base'); expect(client.threadId).toBe('fork');
        expect(metadata.codexBranches.at(-1).forkMessageId).toBe('persisted-question');
        const nextHandlers = new Map<string, (value: any) => Promise<any>>();
        controller.attach({ sessionId: 'continued-sid', getMetadata: () => metadata, updateMetadata: async () => {}, rpcHandlerManager: {
            registerHandler: (key: string, handler: any) => nextHandlers.set(key, handler), unregisterHandler: (key: string) => handlers.delete(key),
        } } as any);
        expect(nextHandlers.has('git-checkpoint-restore')).toBe(true);
        expect((await nextHandlers.get('git-workbench')!({ operation: 'checkpoints' })).checkpoints).toHaveLength(1);
    } finally { if (directory) await git(root, ['worktree', 'remove', '--force', '--', directory]); await rm(root, { recursive: true, force: true }); }
});
