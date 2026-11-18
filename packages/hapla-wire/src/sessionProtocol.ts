/** Shared session envelopes used by Codex and normalized by the frontend adapter. */

import { createId, isCuid } from '@paralleldrive/cuid2';
import * as z from 'zod';

export const sessionRoleSchema = z.enum(['user', 'agent']);
export type SessionRole = z.infer<typeof sessionRoleSchema>;

export const asyncUserInputQuestionSchema = z.object({
  title: z.string(),
  options: z.array(z.string()).nullish(),
});
export type AsyncUserInputQuestion = z.infer<typeof asyncUserInputQuestionSchema>;

export const sessionTextEventSchema = z.object({
  t: z.literal('text'),
  text: z.string(),
  thinking: z.boolean().optional(),
  // Only protocol-provided, user-visible reasoning summaries may set this flag.
  summary: z.boolean().optional(),
  delivery: z.literal('async').optional(),
  questions: z.array(asyncUserInputQuestionSchema).optional(),
});

export const sessionServiceMessageEventSchema = z.object({
  t: z.literal('service'),
  text: z.string(),
});

export const sessionToolCallStartEventSchema = z.object({
  t: z.literal('tool-call-start'),
  call: z.string(),
  name: z.string(),
  title: z.string(),
  description: z.string(),
  args: z.record(z.string(), z.unknown()),
});

export const sessionToolCallEndEventSchema = z.object({
  t: z.literal('tool-call-end'),
  call: z.string(),
  // Optional captured command output. The upstream protocol omitted this, so
  // tool cards showed "[Command completed with no output]" for every command.
  // Producers MUST length-cap these strings (see sessionProtocolMapper) to keep
  // the encrypted realtime payload small. `outputTruncated` flags when the
  // captured output exceeded the cap and was clipped.
  stdout: z.string().optional(),
  stderr: z.string().optional(),
  isError: z.boolean().optional(),
  outputTruncated: z.boolean().optional(),
  // Structured result for protocol-native tools such as MCP Apps. This stays
  // opaque at the transport layer and is interpreted by the matching UI host.
  result: z.unknown().optional(),
});

export const sessionFileEventSchema = z.object({
  t: z.literal('file'),
  ref: z.string(),
  name: z.string(),
  size: z.number(),
  mimeType: z.string().optional(),
  // File collections keep their producing step even when transfer finishes later.
  // Optional for compatibility with existing CLI versions and saved history.
  artifact: z.object({
    origin: z.enum(['automatic', 'reference']),
    batchId: z.string().min(1),
    sourceId: z.string().optional(),
    path: z.string().optional(),
  }).optional(),
  image: z
    .object({
      width: z.number(),
      height: z.number(),
      thumbhash: z.string(),
    })
    .optional(),
});

export const sessionTurnStartEventSchema = z.object({
  t: z.literal('turn-start'),
});

export const sessionStartEventSchema = z.object({
  t: z.literal('start'),
  title: z.string().optional(),
});

export const sessionTurnEndStatusSchema = z.enum(['completed', 'failed', 'cancelled']);
export type SessionTurnEndStatus = z.infer<typeof sessionTurnEndStatusSchema>;

export const sessionTurnEndEventSchema = z.object({
  t: z.literal('turn-end'),
  status: sessionTurnEndStatusSchema,
});

export const sessionStopEventSchema = z.object({
  t: z.literal('stop'),
});

export const sessionEventSchema = z.discriminatedUnion('t', [
  sessionTextEventSchema,
  sessionServiceMessageEventSchema,
  sessionToolCallStartEventSchema,
  sessionToolCallEndEventSchema,
  sessionFileEventSchema,
  sessionTurnStartEventSchema,
  sessionStartEventSchema,
  sessionTurnEndEventSchema,
  sessionStopEventSchema,
]);

export type SessionEvent = z.infer<typeof sessionEventSchema>;

export const sessionEnvelopeSchema = z
  .object({
    id: z.string(),
    time: z.number(),
    role: sessionRoleSchema,
    turn: z.string().optional(),
    subagent: z
      .string()
      .refine((value) => isCuid(value), {
        message: 'subagent must be a cuid2 value',
      })
      .optional(),
    ev: sessionEventSchema,
  })
  .superRefine((envelope, ctx) => {
    if (envelope.ev.t === 'service' && envelope.role !== 'agent') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'service events must use role "agent"',
        path: ['role'],
      });
    }
    if ((envelope.ev.t === 'start' || envelope.ev.t === 'stop') && envelope.role !== 'agent') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${envelope.ev.t} events must use role "agent"`,
        path: ['role'],
      });
    }
  });

export type SessionEnvelope = z.infer<typeof sessionEnvelopeSchema>;

export type CreateEnvelopeOptions = {
  id?: string;
  time?: number;
  turn?: string;
  subagent?: string;
};

export function createEnvelope(role: SessionRole, ev: SessionEvent, opts: CreateEnvelopeOptions = {}): SessionEnvelope {
  return sessionEnvelopeSchema.parse({
    id: opts.id ?? createId(),
    time: opts.time ?? Date.now(),
    role,
    ...(opts.turn ? { turn: opts.turn } : {}),
    ...(opts.subagent ? { subagent: opts.subagent } : {}),
    ev,
  });
}
