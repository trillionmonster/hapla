import { registerGitHandlers } from './registerGitHandlers';
import { logger } from '@/ui/logger';
import type { ApiSessionClient } from '@/api/apiSession';
import type { CodexAppServerClient } from '@/codex/codexAppServerClient';
import type { GitCheckpoint } from '@hapla/wire';
import { WorkspaceCheckpoints } from './checkpoints';
import { git, serialized } from './gitProcess';
import { z } from 'zod';

export function installCodexCheckpoints(options: {
    session: ApiSessionClient; client: CodexAppServerClient; root: string;
    isBusy: () => boolean; branch: () => string; setBranch: (id: string) => void;
}) {
    const { client, root } = options;
    let session = options.session;
    const namespace = session.getMetadata()?.conversationRootSessionId ?? session.sessionId;
    let checkpoints = new WorkspaceCheckpoints(root, namespace, session.sessionId);
    let restoring = false;
    let restoration = Promise.resolve();
    let restored = () => {};
    const capture = async (label: string, boundary: { forkMessageId?: string; forkMessageCreatedAt?: number } = {}, manual = false) => {
        if (restoring) throw new Error('Workspace restore is in progress.');
        await git(root, ['rev-parse', '--verify', 'HEAD']);
        const emptyThread = client.isFreshThread;
        // thread/read(includeTurns) is unavailable on some supported native versions.
        // Preserve a native pre-turn fork instead of guessing a history boundary.
        const saved = emptyThread ? null : await client.requestRaw<{ thread: { id: string } }>('thread/fork', {
            threadId: client.threadId, cwd: root, deferGoalContinuation: true,
        });
        return checkpoints.begin(label, { threadId: client.threadId ?? undefined, branchId: options.branch(),
            nativeRestoreThreadId: saved?.thread.id, emptyThread, ...boundary }, manual);
    };
    const createHandler = async () => {
        if (restoring || options.isBusy()) throw new Error('Wait until this session is idle before saving a checkpoint.');
        return capture('Manual checkpoint', {}, true);
    };
    const restoreHandler = async (input: unknown) => {
        const { id, revision } = z.object({ id: z.string().uuid(), revision: z.string().regex(/^[a-f0-9]{64}$/) }).strict().parse(input);
        if (restoring || options.isBusy()) throw new Error('Wait until the task, queue, and side chats are idle before restoring.');
        restoring = true;
        restoration = new Promise<void>(resolve => { restored = resolve; });
        try {
            return await serialized(root, async () => {
                const cp = await checkpoints.prepareRestore(id, revision);
                if (!cp.threadId || cp.threadId !== client.threadId || !client.threadId) throw new Error('This checkpoint belongs to another conversation branch. Switch to that branch before restoring.');
                const original = client.threadId; const parentId = options.branch();
                if (!cp.nativeRestoreThreadId && !cp.previousTurnId && !cp.emptyThread) throw new Error('This checkpoint has no recoverable native conversation snapshot.');
                const fork = cp.nativeRestoreThreadId
                    ? await client.forkThread({ sourceThreadId: cp.nativeRestoreThreadId, cwd: root, deferGoalContinuation: true })
                    : cp.previousTurnId
                        ? await client.forkThread({ lastTurnId: cp.previousTurnId, cwd: root, deferGoalContinuation: true })
                        : await client.startSiblingThread({ cwd: root });
                try {
                    // Native preparation may take time; recheck ownership and file revision before the first write.
                    await checkpoints.prepareRestore(id, revision);
                    const rescue = await checkpoints.restoreFiles(cp, async () => {
                        const now = Date.now();
                        await session.updateMetadata(metadata => ({ ...metadata,
                            codexThreadId: fork.threadId, activeCodexBranchId: fork.threadId, currentModelCode: fork.model, contextUsage: undefined,
                            codexBranches: [...(metadata.codexBranches ?? [{ id: parentId, threadId: original, label: 'Original', createdAt: now }]),
                                { id: fork.threadId, threadId: fork.threadId, parentId, label: `Restore: ${cp.label}`.slice(0, 80), forkMessageId: cp.forkMessageId, forkMessageCreatedAt: cp.forkMessageCreatedAt ?? cp.createdAt, createdAt: now }],
                        }));
                        options.setBranch(fork.threadId);
                    });
                    return { threadId: fork.threadId, rescue, message: 'Workspace and conversation restored on a new branch.' };
                } catch (error) {
                    await client.resumeThread({ threadId: original, cwd: root });
                    throw error;
                }
            });
        } finally { restoring = false; restored(); }
    };
    const attach = (next: ApiSessionClient) => {
        if (next !== session) {
            for (const method of ['git-workbench', 'git-checkpoint-create', 'git-checkpoint-restore']) session.rpcHandlerManager.unregisterHandler(method);
        }
        session = next;
        checkpoints = new WorkspaceCheckpoints(root, namespace, next.sessionId);
        registerGitHandlers(next.rpcHandlerManager, root, namespace);
        next.rpcHandlerManager.registerHandler('git-checkpoint-create', createHandler);
        next.rpcHandlerManager.registerHandler('git-checkpoint-restore', restoreHandler);
        if (!next.getMetadata()?.conversationRootSessionId) void next.updateMetadata(metadata => ({ ...metadata, conversationRootSessionId: namespace }))
            .catch(error => logger.warn('[Codex] Could not persist the checkpoint conversation identity', error));
    };
    attach(session);
    return {
        attach,
        isRestoring: () => restoring,
        waitForRestore: () => restoration,
        begin: (label: string, boundary: { forkMessageId?: string; forkMessageCreatedAt?: number } = {}) => capture(label, boundary),
        finish: (id: string, turnId: string | undefined, status: GitCheckpoint['status']) => checkpoints.finish(id, turnId, status),
    };
}
