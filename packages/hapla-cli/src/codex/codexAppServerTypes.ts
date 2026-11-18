/**
 * Stable product-facing projections of the generated Codex app-server schema.
 * The JSON-RPC transport deliberately accepts all methods through
 * `requestRaw`/`notifyRaw`; CI regenerates the installed CLI schema to detect
 * protocol drift while these focused types keep the runtime bundle compact.
 */

export type ThreadId = string;

// --- Initialize ---

export type InitializeParams = {
    clientInfo: { name: string; title: string | null; version: string };
    capabilities: {
        experimentalApi: boolean;
        requestAttestation: boolean;
        mcpServerOpenaiFormElicitation?: boolean;
        optOutNotificationMethods?: string[] | null;
    } | null;
};

export type InitializeResponse = { userAgent: string };

// --- Models ---

export type CodexModel = {
    id: string;
    model: string;
    displayName: string;
    description: string;
    isDefault: boolean;
    hidden: boolean;
    defaultReasoningEffort: string;
    supportedReasoningEfforts: Array<{
        reasoningEffort: string;
        description: string;
    }>;
    serviceTiers?: Array<{ id: string; name: string; description: string }>;
    additionalSpeedTiers?: string[];
};

export type ModelListResponse = {
    data: CodexModel[];
    nextCursor?: string | null;
};

// --- Skills ---

export type CodexSkill = {
    name: string;
    description: string;
    shortDescription?: string | null;
    path: string;
    enabled: boolean;
    scope: 'user' | 'repo' | 'system' | 'admin';
};

export type SkillsListResponse = {
    data: Array<{
        cwd: string;
        skills: CodexSkill[];
        errors: Array<{
            path: string;
            message: string;
        }>;
    }>;
};

// --- Thread lifecycle ---

export type NewConversationParams = {
    model: string | null;
    modelProvider: string | null;
    profile: string | null;
    cwd: string | null;
    approvalPolicy: ApprovalPolicy | null;
    sandbox: SandboxMode | null;
    config: Record<string, unknown> | null;
    baseInstructions: string | null;
    developerInstructions: string | null;
    compactPrompt: string | null;
    includeApplyPatchTool: boolean | null;
    experimentalRawEvents: boolean;
    persistExtendedHistory: boolean;
};

export type NewConversationResponse = {
    thread: {
        id: ThreadId;
        path: string;
        [key: string]: unknown;
    };
    model: string;
    modelProvider: string;
    cwd: string;
    approvalPolicy: ApprovalPolicy;
    sandbox: unknown;
    reasoningEffort: ReasoningEffort | null;
};

export type ResumeConversationParams = {
    threadId: ThreadId;
    model: string | null;
    modelProvider: string | null;
    cwd: string | null;
    approvalPolicy: ApprovalPolicy | null;
    sandbox: SandboxMode | null;
    config: Record<string, unknown> | null;
    baseInstructions: string | null;
    developerInstructions: string | null;
    persistExtendedHistory: boolean;
};

export type ResumeConversationResponse = NewConversationResponse;

// --- Turn lifecycle ---

export type SendUserTurnParams = {
    threadId: ThreadId;
    input: InputItem[];
    cwd: string;
    approvalPolicy: ApprovalPolicy;
    sandboxPolicy: SandboxPolicy;
    model: string;
    effort: ReasoningEffort | null;
    summary: ReasoningSummary;
    outputSchema: unknown | null;
};

export type InterruptConversationParams = {
    threadId: ThreadId;
    turnId: string;
};

// The RPC acknowledges receipt only; the terminal status arrives in turn/completed.
export type InterruptConversationResponse = Record<string, never>;

/** Native model command handles; these are not command/exec process IDs or OS PIDs. */
export type ThreadBackgroundTerminal = {
    itemId: string;
    processId: string;
    command: string;
    cwd: string;
    osPid: number | null;
};

export type ThreadBackgroundTerminalsListResponse = {
    data: ThreadBackgroundTerminal[];
    nextCursor: string | null;
};

export type ThreadBackgroundTerminalsTerminateResponse = { terminated: boolean };

// --- Approvals (server → client requests) ---

export type ExecCommandApprovalParams = {
    conversationId: ThreadId;
    callId: string;
    approvalId: string | null;
    command: string[];
    cwd: string;
    reason: string | null;
    parsedCmd: unknown[];
};

export type ApplyPatchApprovalParams = {
    conversationId: ThreadId;
    callId: string;
    fileChanges: Record<string, FileChange>;
    reason: string | null;
    grantRoot: string | null;
};

export type ApprovalResponse = {
    decision: ReviewDecision;
};

export type McpServerElicitationAction = "accept" | "decline" | "cancel";

export type McpServerElicitationRequestResponse = {
    action: McpServerElicitationAction;
    content: Record<string, unknown> | null;
    _meta: Record<string, unknown> | null;
};

export type ReviewDecision =
    | "approved"
    | { approved_execpolicy_amendment: { proposed_execpolicy_amendment: string[] } }
    | "approved_for_session"
    | "denied"
    | "abort";

// --- Shared enums ---

// Codex app-server v2 accepts these policies. `on-failure` was accepted by
// older Codex releases but is rejected by current versions.
export type ApprovalPolicy = "untrusted" | "on-request" | "granular" | "never";
export type SandboxMode = "read-only" | "workspace-write" | "danger-full-access";
// The generated contract is open-ended; available values come from model/list.
export type ReasoningEffort = string;
export type ReasoningSummary = "auto" | "concise" | "detailed" | "none";
export type TurnAbortReason = "interrupted" | "replaced" | "review_ended";

export type InputItem =
    | { type: "text"; text: string; text_elements?: unknown[] }
    | ({ type: "image"; detail?: "auto" | "low" | "high" | "original" } & ({ url: string } | { fileId: string }))
    | { type: "localImage"; detail?: "auto" | "low" | "high" | "original"; path: string }
    | { type: "audio"; url: string }
    | { type: "localAudio"; path: string }
    | { type: "skill"; name: string; path: string }
    | { type: "mention"; name: string; path: string };

export type ThreadForkResponse = {
    thread: { id: string; forkedFromId?: string | null; turns?: unknown[] };
    model: string;
};

// --- MCP Apps / interactive tool surfaces ---

export type McpToolCallAppContext = {
    connectorId: string;
    linkId: string | null;
    resourceUri: string | null;
    appName: string | null;
    templateId: string | null;
    actionName: string | null;
};

export type McpToolCallResult = {
    content: unknown[];
    structuredContent: unknown | null;
    _meta: unknown | null;
};

export type McpToolCallItem = {
    type: "mcpToolCall";
    id: string;
    server: string;
    tool: string;
    status: "inProgress" | "completed" | "failed";
    arguments: unknown;
    appContext: McpToolCallAppContext | null;
    /** Deprecated by Codex; retained for older app-server releases. */
    mcpAppResourceUri?: string;
    /** Descriptor-captured UI presentation, introduced in Codex 0.156.1. */
    mcpAppUi?: { resourceUri: string; preferredModelDisplayMode: "inline" | "fullscreen" } | null;
    pluginId: string | null;
    result: McpToolCallResult | null;
    error: { message: string } | null;
    durationMs: number | null;
};

export type McpResourceContent =
    | { uri: string; mimeType?: string; text: string; _meta?: unknown }
    | { uri: string; mimeType?: string; blob: string; _meta?: unknown };

export type McpResourceReadResponse = { contents: McpResourceContent[] };

export type McpServerToolCallResponse = {
    content: unknown[];
    structuredContent?: unknown;
    isError?: boolean;
    _meta?: unknown;
};

export type SandboxPolicy =
    | { type: "dangerFullAccess" }
    | { type: "readOnly" }
    | { type: "externalSandbox"; networkAccess: boolean }
    | {
          type: "workspaceWrite";
          writableRoots?: string[];
          networkAccess: boolean;
          excludeTmpdirEnvVar: boolean;
          excludeSlashTmp: boolean;
      };

export type FileChange =
    | { type: "add"; content: string }
    | { type: "delete"; content: string }
    | { type: "update"; unified_diff: string; move_path: string | null };

// --- Events ---
// Events arrive as `codex/event` notifications with `{ msg: EventMsg }`.
// EventMsg uses the same type discriminators as the MCP server, so our
// existing handler works without changes. We type it loosely here.
export type EventMsg = { type: string; protocol?: import('./codexProtocolJournal').CodexProtocolContext } & Record<string, unknown>;

// --- JSON-RPC 2.0 wire types ---

export type JsonRpcRequest = {
    jsonrpc?: "2.0";
    id?: number | string;
    method: string;
    params?: unknown;
};

export type JsonRpcResponse = {
    jsonrpc?: "2.0";
    id: number | string;
    result?: unknown;
    error?: { code: number; message: string; data?: unknown };
};
