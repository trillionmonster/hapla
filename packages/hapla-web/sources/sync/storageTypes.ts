import { codexInputStateSchema, codexSideChatSchema } from '@hapla/wire';
import { z } from "zod";
import { CodexRuntimeStateSchema } from '@hapla/wire';
import type { CodexPreferences } from './codexPreferences';

//
// Agent states
//

export const MetadataSchema = z.object({
    models: z.array(z.object({
        code: z.string(),
        value: z.string(),
        description: z.string().nullish(),
        supportedEffortLevels: z.array(z.string()).optional(),
        effortDescriptions: z.record(z.string(), z.string()).optional(),
        defaultEffortLevel: z.string().nullish(),
        supportedServiceTiers: z.array(z.string()).optional(),
    })).optional(),
    currentModelCode: z.string().optional(),
    operatingModes: z.array(z.object({
        code: z.string(),
        value: z.string(),
        description: z.string().nullish(),
    })).optional(),
    currentOperatingModeCode: z.string().optional(),
    thoughtLevels: z.array(z.object({
        code: z.string(),
        value: z.string(),
        description: z.string().nullish(),
    })).optional(),
    currentThoughtLevelCode: z.string().optional(),
    skills: z.array(z.object({
        name: z.string(),
        description: z.string(),
        path: z.string().nullish(),
        enabled: z.boolean(),
        scope: z.string().nullish(),
        argumentHint: z.string().nullish(),
        interactive: z.object({ id: z.string(), displayName: z.string() }).nullish(),
    })).optional(),
    path: z.string().optional(),
    host: z.string().optional(),
    version: z.string().optional(),
    name: z.string().optional(),
    os: z.string().optional(),
    summary: z.object({
        text: z.string(),
        updatedAt: z.number()
    }).optional(),
    machineId: z.string().optional(),
    claudeSessionId: z.string().optional(), // Claude Code session ID
    codexThreadId: z.string().optional(), // Codex app-server thread ID
    continuedFromSessionId: z.string().optional(),
    conversationRootSessionId: z.string().optional(),
    codexBranches: z.array(z.object({
        id: z.string(),
        threadId: z.string(),
        label: z.string(),
        parentId: z.string().optional(),
        forkMessageId: z.string().optional(),
        forkMessageCreatedAt: z.number().optional(),
        createdAt: z.number(),
    })).optional(),
    activeCodexBranchId: z.string().optional(),
    tools: z.array(z.string()).optional(),
    slashCommands: z.array(z.string()).optional(),
    homeDir: z.string().optional(), // User's home directory on the machine
    happyHomeDir: z.string().optional(), // Legacy wire key; current value points to ~/.hapla.
    startedFromDaemon: z.boolean().optional(),
    hostPid: z.number().optional(), // Process ID of the session
    startedBy: z.enum(['daemon', 'terminal']).optional(),
    flavor: z.string().nullish(), // Session flavor/variant identifier
    sandbox: z.any().nullish(), // Sandbox config metadata from CLI (or null when disabled)
    dangerouslySkipPermissions: z.boolean().nullish(), // Claude --dangerously-skip-permissions mode (or null when unknown)
    lifecycleState: z.string().optional(),
    lifecycleStateSince: z.number().optional(),
    sleepReason: z.string().optional(),
    archivedBy: z.string().optional(),
    archiveReason: z.string().optional(),
}).passthrough().transform((metadata) => ({
    ...metadata,
    path: metadata.path ?? '',
    host: metadata.host ?? '',
}));

export type Metadata = z.infer<typeof MetadataSchema>;

export const RequestProtocolSchema = z.object({
    epoch: z.string(), requestId: z.union([z.string(), z.number()]),
    threadId: z.string().optional(), turnId: z.string().optional(), itemId: z.string().optional(),
});

export const AgentStateSchema = z.object({
    codexInputs: codexInputStateSchema.optional(),
    codexSideChats: z.array(codexSideChatSchema).optional(),
    codexRuntime: CodexRuntimeStateSchema.nullish(),
    controlledByUser: z.boolean().nullish(),
    requests: z.record(z.string(), z.object({
        tool: z.string(),
        arguments: z.any(),
        createdAt: z.number().nullish(),
        status: z.enum(['pending', 'submitting']).optional(),
        protocol: RequestProtocolSchema.optional(),
        submittedAt: z.number().optional(),
    })).nullish(),
    completedRequests: z.record(z.string(), z.object({
        tool: z.string(),
        arguments: z.any(),
        createdAt: z.number().nullish(),
        completedAt: z.number().nullish(),
        status: z.enum(['canceled', 'denied', 'approved', 'expired']),
        protocol: RequestProtocolSchema.optional(),
        providerStatus: z.literal('resolved').optional(),
        reason: z.string().nullish(),
        mode: z.string().nullish(),
        allowedTools: z.array(z.string()).nullish(),
        decision: z.enum(['approved', 'approved_for_session', 'denied', 'abort']).nullish()
    })).nullish()
});

export type AgentState = z.infer<typeof AgentStateSchema>;

export const TodoItemSchema = z.object({
    content: z.string(),
    status: z.enum(['pending', 'in_progress', 'completed']),
    priority: z.enum(['high', 'medium', 'low']).optional(),
    id: z.string().optional(),
});

export const TodoItemsSchema = z.array(TodoItemSchema);

export type TodoItem = z.infer<typeof TodoItemSchema>;

export interface Session {
    id: string,
    /** Stable server-side identity shared by every runtime of one conversation. */
    conversationId?: string | null,
    seq: number,
    createdAt: number,
    updatedAt: number,
    /** Server timestamp of the last persisted user message, never a heartbeat. */
    lastUserMessageAt?: number | null,
    lastUserMessageIndexedSeq?: number,
    /** Presentation-only creation fallback shared by collapsed runtime records. */
    questionFallbackCreatedAt?: number,
    questionOrderId?: string,
    active: boolean,
    activeAt: number,
    metadata: Metadata | null,
    metadataVersion: number,
    agentState: AgentState | null,
    agentStateVersion: number,
    thinking: boolean,
    thinkingAt: number,
    activity?: {
        phase: string;
        detail?: string;
        itemType?: string;
    } | null,
    presence: "online" | number, // "online" when active, timestamp when last seen
    todos?: TodoItem[];
    hasDraft?: boolean; // Lightweight marker retained while the draft body is unloaded.
    draft?: string | null; // Local draft message, not synced to server
    permissionMode?: string | null; // Local permission mode key, not synced to server
    modelMode?: string | null; // Local model key, not synced to server
    effortLevel?: string | null; // Local selection; copied into each outbound message as CLI effort metadata
    codexPreferences?: CodexPreferences;
    // IMPORTANT: latestUsage is extracted from reducerState.latestUsage after message processing.
    // We store it directly on Session to ensure it's available immediately on load.
    // Do NOT store reducerState itself on Session - it's mutable and should only exist in SessionMessages.
    latestUsage?: {
        inputTokens: number;
        outputTokens: number;
        cacheCreation: number;
        cacheRead: number;
        contextSize: number;
        timestamp: number;
    } | null;
}

export interface DecryptedMessage {
    id: string,
    seq: number | null,
    localId: string | null,
    content: any,
    createdAt: number,
}

//
// Machine states
//

export const MachineMetadataSchema = z.object({
    host: z.string(),
    platform: z.string(),
    happyCliVersion: z.string(), // Legacy encrypted wire key retained for stored machine records.
    happyHomeDir: z.string(), // Legacy encrypted wire key; current value points to ~/.hapla.
    homeDir: z.string(), // User's home directory (matches CLI field name)
    // Optional fields that may be added in future versions
    username: z.string().optional(),
    arch: z.string().optional(),
    displayName: z.string().optional(), // Custom display name for the machine
    // Daemon status fields
    daemonLastKnownStatus: z.enum(['running', 'shutting-down']).optional(),
    daemonLastKnownPid: z.number().optional(),
    shutdownRequestedAt: z.number().optional(),
    shutdownSource: z.enum(['hapla-app', 'hapla-cli', 'happy-app', 'happy-cli', 'os-signal', 'unknown']).optional(),
    cliAvailability: z.object({
        claude: z.boolean(),
        codex: z.boolean(),
        detectedAt: z.number(),
    }).passthrough().optional(),
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
});

export type MachineMetadata = z.infer<typeof MachineMetadataSchema>;

export interface Machine {
    id: string;
    seq: number;
    createdAt: number;
    updatedAt: number;
    active: boolean;
    activeAt: number;  // Changed from lastActiveAt to activeAt for consistency
    metadata: MachineMetadata | null;
    metadataVersion: number;
    daemonState: any | null;  // Dynamic daemon state (runtime info)
    daemonStateVersion: number;
}

//
// Git Status
//

export interface GitStatus {
    branch: string | null;
    isDirty: boolean;
    modifiedCount: number;
    untrackedCount: number;
    stagedCount: number;
    lastUpdatedAt: number;
    // Line change statistics - separated by staged vs unstaged
    stagedLinesAdded: number;
    stagedLinesRemoved: number;
    unstagedLinesAdded: number;
    unstagedLinesRemoved: number;
    // Computed totals
    linesAdded: number;      // stagedLinesAdded + unstagedLinesAdded
    linesRemoved: number;    // stagedLinesRemoved + unstagedLinesRemoved
    linesChanged: number;    // Total lines that were modified (added + removed)
    // Branch tracking information (from porcelain v2)
    upstreamBranch?: string | null; // Name of upstream branch
    aheadCount?: number; // Commits ahead of upstream
    behindCount?: number; // Commits behind upstream
    stashCount?: number; // Number of stash entries
}
