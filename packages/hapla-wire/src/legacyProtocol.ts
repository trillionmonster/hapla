import * as z from 'zod';
import { MessageMetaSchema } from './messageMeta';

const ImageContentBlockSchema = z.object({
  type: z.literal('image'),
  source: z.object({
    type: z.literal('base64'),
    media_type: z.string(),
    data: z.string(),
  }),
});

const TextContentBlockSchema = z.object({
  type: z.literal('text'),
  text: z.string(),
});

const ContentBlockSchema = z.discriminatedUnion('type', [TextContentBlockSchema, ImageContentBlockSchema]);

export const UserMessageSchema = z.object({
  role: z.literal('user'),
  content: z.union([
    z.object({
      type: z.literal('text'),
      text: z.string(),
    }),
    z.object({
      type: z.literal('multimodal'),
      parts: z.array(ContentBlockSchema),
    }),
  ]),
  localKey: z.string().optional(),
  meta: MessageMetaSchema.optional(),
});
export type UserMessage = z.infer<typeof UserMessageSchema>;

export const AgentMessageSchema = z.object({
  role: z.literal('agent'),
  content: z
    .object({
      type: z.string(),
    })
    .passthrough(),
  meta: MessageMetaSchema.optional(),
});
export type AgentMessage = z.infer<typeof AgentMessageSchema>;

export const LegacyMessageContentSchema = z.discriminatedUnion('role', [UserMessageSchema, AgentMessageSchema]);
export type LegacyMessageContent = z.infer<typeof LegacyMessageContentSchema>;
