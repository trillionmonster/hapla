import { z } from 'zod';

/** Omitted fields inherit; null explicitly restores the native CLI default. */
export const sessionConfigurationValuesSchema = z.object({
    permissionMode: z.enum(['default', 'dontAsk', 'acceptEdits', 'bypassPermissions', 'plan', 'read-only', 'safe-yolo', 'yolo']).optional(),
    model: z.string().min(1).nullable().optional(),
    effort: z.string().min(1).nullable().optional(),
    verbosity: z.enum(['low', 'medium', 'high']).nullable().optional(),
    serviceTier: z.string().max(64).nullable().optional(),
    collaborationMode: z.enum(['default', 'plan']).optional(),
}).strict();
export const sessionConfigurationSchema = z.object({
    revision: z.number().int().nonnegative(),
    values: sessionConfigurationValuesSchema,
});
export type SessionConfigurationValues = z.infer<typeof sessionConfigurationValuesSchema>;
export type SessionConfiguration = z.infer<typeof sessionConfigurationSchema>;
export type EffectiveSessionConfiguration = SessionConfigurationValues & { threadId?: string; turnId?: string };
