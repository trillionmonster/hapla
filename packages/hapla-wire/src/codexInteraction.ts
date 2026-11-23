import { z } from 'zod';

export const codexFollowupModeSchema = z.enum(['steer', 'queue', 'replace']);
export type CodexFollowupMode = z.infer<typeof codexFollowupModeSchema>;
export const codexInterruptTargetSchema = z.object({ epoch: z.string(), threadId: z.string(), turnId: z.string().nullable(), startId: z.string().nullable() });
export type CodexInterruptTarget = z.infer<typeof codexInterruptTargetSchema>;

export const codexInputStateSchema = z.object({
    paused: z.boolean(),
    items: z.array(z.object({ id: z.string(), message: z.string(), revision: z.number(), createdAt: z.number(), error: z.string().optional() })),
    receipts: z.array(z.object({ id: z.string(), status: z.enum(['queued', 'submitting', 'running', 'steered', 'completed', 'interrupted', 'canceled', 'failed']) })).optional(),
});
export type CodexInputState = z.infer<typeof codexInputStateSchema>;

export const codexSideChatSchema = z.object({
    id: z.string(), threadId: z.string().optional(), title: z.string(),
    status: z.enum(['idle', 'running', 'stopping', 'interrupted', 'failed']),
    messages: z.array(z.object({ id: z.string(), role: z.enum(['user', 'assistant']), text: z.string() })),
    error: z.string().optional(),
});
export type CodexSideChat = z.infer<typeof codexSideChatSchema>;
