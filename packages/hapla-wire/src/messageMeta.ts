import * as z from 'zod';

export const MessageMetaSchema = z.object({
  sentFrom: z.string().optional(),
  permissionMode: z.enum(['default', 'acceptEdits', 'bypassPermissions', 'plan', 'read-only', 'safe-yolo', 'yolo']).optional(),
  model: z.string().nullable().optional(),
  effort: z.string().nullable().optional(),
  verbosity: z.enum(['low', 'medium', 'high']).nullable().optional(),
  serviceTier: z.string().max(64).nullable().optional(),
  collaborationMode: z.enum(['default', 'plan']).optional(),
  fallbackModel: z.string().nullable().optional(),
  customSystemPrompt: z.string().nullable().optional(),
  appendSystemPrompt: z.string().nullable().optional(),
  allowedTools: z.array(z.string()).nullable().optional(),
  disallowedTools: z.array(z.string()).nullable().optional(),
  displayText: z.string().optional(),
});
export type MessageMeta = z.infer<typeof MessageMetaSchema>;
