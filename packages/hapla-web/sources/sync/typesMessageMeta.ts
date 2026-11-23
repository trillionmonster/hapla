import { codexInterruptTargetSchema } from '@hapla/wire';
import { z } from 'zod';
import { asyncUserInputQuestionSchema } from '@hapla/wire';

// Shared message metadata schema
export const MessageMetaSchema = z.object({
    sentFrom: z.string().optional(), // Source identifier
    permissionMode: z.string().optional(), // Permission mode key for this message
    model: z.string().nullable().optional(), // Model name for this message (null = reset)
    effort: z.string().nullable().optional(), // CLI-advertised reasoning effort (null = reset)
    verbosity: z.enum(['low', 'medium', 'high']).nullable().optional(),
    serviceTier: z.string().max(64).nullable().optional(),
    collaborationMode: z.enum(['default', 'plan']).optional(),
    fallbackModel: z.string().nullable().optional(), // Fallback model for this message (null = reset)
    customSystemPrompt: z.string().nullable().optional(), // Custom system prompt for this message (null = reset)
    appendSystemPrompt: z.string().nullable().optional(), // Append to system prompt for this message (null = reset)
    allowedTools: z.array(z.string()).nullable().optional(), // Allowed tools for this message (null = reset)
    disallowedTools: z.array(z.string()).nullable().optional(), // Disallowed tools for this message (null = reset)
    codexInputId: z.string().optional(),
  codexInterruptTarget: codexInterruptTargetSchema.optional(),
  codexFollowupMode: z.enum(['steer', 'queue', 'replace']).optional(),
    displayText: z.string().optional(), // Optional text to display in UI instead of actual message text
    branchId: z.string().optional(),
    streamId: z.string().optional(),
    turnId: z.string().optional(),
    reasoningSummary: z.boolean().optional(),
    asyncQuestion: z.object({ id: z.string(), questions: z.array(asyncUserInputQuestionSchema) }).optional(),
    asyncQuestionResponse: z.object({ id: z.string(), answers: z.array(z.string()) }).optional(),
    cacheTruncated: z.boolean().optional(),
    artifact: z.object({
        origin: z.enum(['automatic', 'reference']),
        batchId: z.string().min(1),
        sourceId: z.string().optional(),
        path: z.string().optional(),
    }).optional(),
});

export type MessageMeta = z.infer<typeof MessageMetaSchema>;
