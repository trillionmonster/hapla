import { z } from 'zod';

export const gitSourceSchema = z.enum(['working', 'staged', 'branch', 'commit', 'turn']);
export type GitSource = z.infer<typeof gitSourceSchema>;
const text = z.string().min(1).max(4096).refine(value => !value.includes('\0'), 'NUL is not allowed');
export const gitWorkbenchRequestSchema = z.object({
    directory: text.optional(),
    sessionId: text.optional(),
    expectedRevision: z.string().regex(/^[a-f0-9]{64}$/).optional(),
    operation: z.enum(['status', 'diff', 'log', 'stage', 'unstage', 'commit', 'push', 'pr-create', 'pr-status', 'checkpoints', 'checkpoint']),
    source: gitSourceSchema.optional(),
    path: text.optional(),
    ref: text.optional(),
    checkpointId: z.string().uuid().optional(),
    offset: z.number().int().nonnegative().max(64 * 1024 * 1024).optional(),
    message: z.string().trim().min(1).max(20_000).optional(),
    title: z.string().trim().min(1).max(256).optional(),
    body: z.string().max(64_000).optional(),
    base: text.optional(),
}).strict();
export type GitWorkbenchRequest = z.infer<typeof gitWorkbenchRequestSchema>;
export type GitChangedFile = { path: string; originalPath?: string; index: string; working: string };
export type GitCheckpoint = {
    id: string; label: string; createdAt: number; before: string; after?: string;
    threadId?: string; previousTurnId?: string; turnId?: string; branchId?: string;
    forkMessageId?: string; forkMessageCreatedAt?: number;
    nativeRestoreThreadId?: string; emptyThread?: boolean;
    status: 'pending' | 'complete' | 'interrupted' | 'failed' | 'manual';
};
export type GitWorkbenchResponse = {
    isWorktree?: boolean; root?: string; branch?: string; head?: string; base?: string; revision?: string;
    files?: GitChangedFile[]; commits?: Array<{ id: string; subject: string }>;
    checkpoints?: GitCheckpoint[]; text?: string; nextOffset?: number | null; totalBytes?: number;
    pr?: { url?: string; state?: string; checks?: Array<{ name: string; status?: string; conclusion?: string }> } | null;
    message?: string;
};
export const worktreeRequestSchema = z.object({
    operation: z.enum(['create', 'list', 'remove']), directory: text,
    path: text.optional(), expectedHead: z.string().regex(/^[a-f0-9]{40,64}$/).optional(),
}).strict();
export type WorktreeRequest = z.infer<typeof worktreeRequestSchema>;
export type WorktreeResponse = { worktrees?: Array<{ path: string; branch: string }>; path?: string; branch?: string; head?: string };
