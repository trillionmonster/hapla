import { codexInterruptTargetSchema, type CodexInterruptTarget } from '@hapla/wire';
import { z } from 'zod'
import type { Update, UpdateMachineBody, CodexRuntimeState } from '@hapla/wire';
import { UsageSchema } from '@/claude/types'
import type { SandboxConfig } from '@/persistence'

export {
  SessionMessageContentSchema,
  SessionMessageSchema,
  UpdateBodySchema,
  UpdateMachineBodySchema,
  UpdateSchema,
  UpdateSessionBodySchema,
} from '@hapla/wire';
export type {
  SessionMessage,
  SessionMessageContent,
  Update,
  UpdateBody,
  UpdateMachineBody,
  UpdateSessionBody,
} from '@hapla/wire';

/**
 * Permission mode type - includes both Claude and Codex modes
 * Must match MessageMetaSchema.permissionMode enum values
 *
 * Claude modes: default, acceptEdits, bypassPermissions, plan
 * Codex modes: read-only, safe-yolo, yolo
 *
 * When calling Claude SDK, Codex modes are mapped at the SDK boundary:
 * - yolo → bypassPermissions
 * - safe-yolo → default
 * - read-only → default
 */
export type PermissionMode = 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan' | 'read-only' | 'safe-yolo' | 'yolo'

/**
 * Usage data type from Claude
 */
export type Usage = z.infer<typeof UsageSchema>

export type SessionActivity = {
  phase: string;
  detail?: string;
  itemType?: string;
}

/**
 * Socket events from server to client
 */
export interface ServerToClientEvents {
  update: (data: Update) => void
  'rpc-request': (data: { method: string, params: string }, callback: (response: string) => void) => void
  'rpc-registered': (data: { method: string }) => void
  'rpc-unregistered': (data: { method: string }) => void
  'rpc-error': (data: { type: string, error: string }) => void
  ephemeral: (data: { type: 'activity', id: string, active: boolean, activeAt: number, thinking: boolean, activity?: SessionActivity | null }) => void
  auth: (data: { success: boolean, user: string }) => void
  error: (data: { message: string }) => void
}


/**
 * Socket events from client to server
 */
export interface ClientToServerEvents {
  message: (data: { sid: string, message: any }) => void
  'session-alive': (data: {
    sid: string;
    time: number;
    thinking: boolean;
    mode?: 'local' | 'remote';
    activity?: SessionActivity | null;
  }) => void
  'session-stream': (data: { sid: string; payload: string }) => void
  'session-end': (data: { sid: string, time: number }) => void,
  'update-metadata': (data: { sid: string, expectedVersion: number, metadata: string }, cb: (answer: {
    result: 'error'
  } | {
    result: 'version-mismatch'
    version: number,
    metadata: string
  } | {
    result: 'success',
    version: number,
    metadata: string
  }) => void) => void,
  'update-state': (data: { sid: string, expectedVersion: number, agentState: string | null }, cb: (answer: {
    result: 'error'
  } | {
    result: 'version-mismatch'
    version: number,
    agentState: string | null
  } | {
    result: 'success',
    version: number,
    agentState: string | null
  }) => void) => void,
  'ping': (callback: () => void) => void
  'rpc-register': (data: { method: string }) => void
  'rpc-unregister': (data: { method: string }) => void
  'rpc-call': (data: { method: string, params: string }, callback: (response: {
    ok: boolean
    result?: string
    error?: string
  }) => void) => void
  'usage-report': (data: {
    key: string
    sessionId: string
    tokens: {
      total: number
      [key: string]: number
    }
    cost: {
      total: number
      [key: string]: number
    }
  }) => void
}

/**
 * Session information
 */
export type Session = {
  id: string,
  conversationId?: string,
  seq: number,
  encryptionKey: Uint8Array;
  encryptionVariant: 'legacy' | 'dataKey';
  metadata: Metadata,
  metadataVersion: number,
  agentState: AgentState | null,
  agentStateVersion: number,
}

/**
 * Machine metadata - static information (rarely changes)
 */
export const MachineMetadataSchema = z.object({
  host: z.string(),
  platform: z.string(),
  happyCliVersion: z.string(),
  homeDir: z.string(),
  happyHomeDir: z.string(),
  happyLibDir: z.string(),
  cliAvailability: z.object({
    claude: z.boolean(),
    codex: z.boolean(),
    detectedAt: z.number(),
  }).optional(),
  cliCapabilities: z.object({
    claude: z.object({
      version: z.string().nullable(),
      models: z.array(z.object({
        code: z.string(),
        value: z.string(),
        description: z.string().nullish(),
        supportedEffortLevels: z.array(z.string()),
        effortDescriptions: z.record(z.string(), z.string()).optional(),
        defaultEffortLevel: z.string().nullish(),
        supportedServiceTiers: z.array(z.string()).optional(),
      })),
      skills: z.array(z.object({
        name: z.string(),
        description: z.string(),
        path: z.string().nullish(),
        enabled: z.boolean(),
        scope: z.string().nullish(),
        argumentHint: z.string().nullish(),
        interactive: z.object({ id: z.string(), displayName: z.string() }).nullish(),
      })),
    }).optional(),
    codex: z.object({
      version: z.string().nullable(),
      models: z.array(z.object({
        code: z.string(),
        value: z.string(),
        description: z.string().nullish(),
        supportedEffortLevels: z.array(z.string()),
        effortDescriptions: z.record(z.string(), z.string()).optional(),
        defaultEffortLevel: z.string().nullish(),
        supportedServiceTiers: z.array(z.string()).optional(),
      })),
      skills: z.array(z.object({
        name: z.string(),
        description: z.string(),
        path: z.string().nullish(),
        enabled: z.boolean(),
        scope: z.string().nullish(),
        argumentHint: z.string().nullish(),
        interactive: z.object({ id: z.string(), displayName: z.string() }).nullish(),
      })),
    }).optional(),
    discoveredAt: z.number(),
  }).optional(),
  codexVersion: z.string().nullable().optional(),
  codexModels: z.array(z.object({
    code: z.string(),
    value: z.string(),
    description: z.string().nullish(),
    supportedEffortLevels: z.array(z.string()).optional().default([]),
    effortDescriptions: z.record(z.string(), z.string()).optional(),
    defaultEffortLevel: z.string().nullish(),
        supportedServiceTiers: z.array(z.string()).optional(),
  })).optional(),
  resumeSupport: z.object({
    rpcAvailable: z.boolean(),
    requiresSameMachine: z.boolean(),
    requiresHappyAgentAuth: z.boolean(),
    happyAgentAuthenticated: z.boolean(),
    detectedAt: z.number(),
  }).optional(),
})

export type MachineMetadata = z.infer<typeof MachineMetadataSchema>

/**
 * Daemon state - dynamic runtime information (frequently updated)
 */
export const DaemonStateSchema = z.object({
  status: z.union([
    z.enum(['running', 'shutting-down']),
    z.string() // Forward compatibility
  ]),
  pid: z.number().optional(),
  httpPort: z.number().optional(),
  startedAt: z.number().optional(),
  shutdownRequestedAt: z.number().optional(),
  shutdownSource:
    z.union([
      z.enum(['mobile-app', 'cli', 'os-signal', 'unknown']),
      z.string() // Forward compatibility
    ]).optional()
})

export type DaemonState = z.infer<typeof DaemonStateSchema>

export type Machine = {
  id: string,
  encryptionKey: Uint8Array;
  encryptionVariant: 'legacy' | 'dataKey';
  metadata: MachineMetadata,
  metadataVersion: number,
  daemonState: DaemonState | null,
  daemonStateVersion: number,
}

/**
 * Message metadata schema
 */
export const MessageMetaSchema = z.object({
  sentFrom: z.string().optional(), // Source identifier
  permissionMode: z.enum(['default', 'acceptEdits', 'bypassPermissions', 'plan', 'read-only', 'safe-yolo', 'yolo']).optional(), // Permission mode for this message
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
  // Wire uses Zod 3; the CLI uses Zod 4. Validate across the boundary
  // without nesting a foreign schema inside a Zod 4 object.
  codexInterruptTarget: z.custom<CodexInterruptTarget>(value => codexInterruptTargetSchema.safeParse(value).success).optional(),
  codexFollowupMode: z.enum(['steer', 'queue', 'replace']).optional(),
  displayText: z.string().optional(),
  branchId: z.string().optional(),
})

export type MessageMeta = z.infer<typeof MessageMetaSchema>

/**
 * API response types
 */
export const CreateSessionResponseSchema = z.object({
  session: z.object({
    id: z.string(),
    conversationId: z.string().optional(),
    tag: z.string(),
    seq: z.number(),
    createdAt: z.number(),
    updatedAt: z.number(),
    metadata: z.string(),
    metadataVersion: z.number(),
    agentState: z.string().nullable(),
    agentStateVersion: z.number()
  })
})

export type CreateSessionResponse = z.infer<typeof CreateSessionResponseSchema>

export const UserMessageSchema = z.object({
  role: z.literal('user'),
  content: z.union([
    z.object({
      type: z.literal('text'),
      text: z.string()
    }),
    z.object({
      type: z.literal('multimodal'),
      parts: z.array(z.object({}).passthrough())
    })
  ]),
  localKey: z.string().optional(), // Mobile messages include this
  meta: MessageMetaSchema.optional()
})

export type UserMessage = z.infer<typeof UserMessageSchema>

/** Extract text from a user message content (works for both text and multimodal) */
export function getUserMessageText(message: UserMessage): string {
  if (message.content.type === 'text') {
    return (message.content as { type: 'text'; text: string }).text;
  }
  // For multimodal, extract text parts
  const parts = (message.content as { type: 'multimodal'; parts: any[] }).parts;
  return parts.filter((p: any) => p.type === 'text').map((p: any) => p.text).join('\n');
}

export const AgentMessageSchema = z.object({
  role: z.literal('agent'),
  content: z.object({
    type: z.literal('output'),
    data: z.any()
  }),
  meta: MessageMetaSchema.optional()
})

export type AgentMessage = z.infer<typeof AgentMessageSchema>

export const MessageContentSchema = z.union([UserMessageSchema, AgentMessageSchema])

export type MessageContent = z.infer<typeof MessageContentSchema>

export type Metadata = {
  /**
   * ACP session config option value (normalized for UI metadata consumers).
   */
  // `code` = protocol value ID, `value` = human label
  models?: Array<{
    code: string;
    value: string;
    description?: string | null;
    supportedEffortLevels?: string[];
    effortDescriptions?: Record<string, string>;
    defaultEffortLevel?: string | null;
    supportedServiceTiers?: string[];
  }>,
  currentModelCode?: string,
  operatingModes?: Array<{ code: string; value: string; description?: string | null }>,
  currentOperatingModeCode?: string,
  thoughtLevels?: Array<{ code: string; value: string; description?: string | null }>,
  currentThoughtLevelCode?: string,
  skills?: Array<{
    name: string;
    description: string;
    path?: string | null;
    enabled: boolean;
    scope?: string | null;
    argumentHint?: string | null;
  }>,
  path: string,
  host: string,
  version?: string,
  name?: string,
  os?: string,
  summary?: {
    text: string,
    updatedAt: number
  },
  machineId?: string,
  claudeSessionId?: string, // Claude Code session ID
  codexThreadId?: string, // Codex app-server thread ID
  /** Previous transport session when this runtime transparently continued a conversation. */
  continuedFromSessionId?: string,
  /** Stable user-facing conversation ID across runtime replacements. */
  conversationRootSessionId?: string,
  codexBranches?: Array<{
    id: string,
    threadId: string,
    label: string,
    parentId?: string,
    forkMessageId?: string,
    forkMessageCreatedAt?: number,
    createdAt: number,
  }>,
  activeCodexBranchId?: string,
  tools?: string[],
  slashCommands?: string[],
  homeDir: string,
  happyHomeDir: string,
  happyLibDir: string,
  happyToolsDir: string,
  startedFromDaemon?: boolean,
  hostPid?: number,
  startedBy?: 'daemon' | 'terminal',
  // Lifecycle state management
  lifecycleState?: 'running' | 'sleeping' | 'archiveRequested' | 'archived' | string,
  lifecycleStateSince?: number,
  sleepReason?: 'runtime-stop' | string,
  archivedBy?: string,
  archiveReason?: string,
  flavor?: string
  sandbox?: SandboxConfig | null
  dangerouslySkipPermissions?: boolean | null
};

export type AgentState = {
  codexInputs?: import('@hapla/wire').CodexInputState;
  codexSideChats?: import('@hapla/wire').CodexSideChat[];
  codexRuntime?: CodexRuntimeState | null;
  controlledByUser?: boolean | null | undefined
  requests?: {
    [id: string]: {
      tool: string,
      arguments: any,
      createdAt: number,
      status?: 'pending' | 'submitting',
      submittedAt?: number,
      protocol?: import('@/codex/utils/codexRequestIdentity').CodexServerRequestContext,
    }
  }
  completedRequests?: {
    [id: string]: {
      tool: string,
      arguments: any,
      createdAt: number,
      completedAt: number,
      status: 'canceled' | 'denied' | 'approved' | 'expired',
      reason?: string,
      mode?: PermissionMode,
      decision?: 'approved' | 'approved_for_session' | 'denied' | 'abort',
      allowTools?: string[]
      protocol?: import('@/codex/utils/codexRequestIdentity').CodexServerRequestContext,
      providerStatus?: 'resolved',
    }
  }
}
