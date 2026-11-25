/**
 * Message Reducer for Real-time Sync System
 * 
 * This reducer is the core message processing engine that transforms raw messages from
 * the sync system into a structured, deduplicated message history. It handles complex
 * scenarios including tool permissions, sidechains, and message deduplication.
 * 
 * ## Core Responsibilities:
 * 
 * 1. **Message Deduplication**: Prevents duplicate messages using multiple tracking mechanisms:
 *    - localId tracking for user messages
 *    - messageId tracking for all messages
 *    - Permission ID tracking for tool permissions
 * 
 * 2. **Tool Permission Management**: Integrates with AgentState to handle tool permissions:
 *    - Creates placeholder messages for pending permission requests
 *    - Updates permission status (pending → approved/denied/canceled)
 *    - Matches incoming tool calls to approved permissions
 *    - Prioritizes tool calls over permissions when both exist
 * 
 * 3. **Tool Call Lifecycle**: Manages the complete lifecycle of tool calls:
 *    - Creation from permission requests or direct tool calls
 *    - Matching tool calls to existing permission messages
 *    - Processing tool results and updating states
 *    - Handling errors and completion states
 * 
 * 4. **Sidechain Processing**: Handles nested conversation branches (sidechains):
 *    - Identifies sidechain messages using the tracer
 *    - Stores sidechain messages separately
 *    - Links sidechains to their parent tool calls
 * 
 * ## Processing Phases:
 * 
 * The reducer processes messages in a specific order to ensure correct behavior:
 * 
 * **Phase 0: AgentState Permissions**
 *   - Processes pending and completed permission requests
 *   - Creates tool messages for permissions
 *   - Skips completed permissions if matching tool call (same name AND arguments) exists in incoming messages
 *   - Phase 2 will handle matching tool calls to existing permission messages
 * 
 * **Phase 0.5: Message-to-Event Conversion**
 *   - Parses messages to check if they should be converted to events
 *   - Converts matching messages to events immediately
 *   - Converted messages skip all subsequent processing phases
 *   - Supports user commands, tool results, and metadata-driven conversions
 * 
 * **Phase 1: User and Text Messages**
 *   - Processes user messages with deduplication
 *   - Processes agent text messages
 *   - Skips tool calls for later phases
 * 
 * **Phase 2: Tool Calls**
 *   - Processes incoming tool calls from agents
 *   - Matches to existing permission messages when possible
 *   - Creates new tool messages when no match exists
 *   - Prioritizes newest permission when multiple matches
 * 
 * **Phase 3: Tool Results**
 *   - Updates tool messages with results
 *   - Sets completion or error states
 *   - Updates completion timestamps
 * 
 * **Phase 4: Sidechains**
 *   - Processes sidechain messages separately
 *   - Stores in sidechain map linked to parent tool
 *   - Handles nested tool calls within sidechains
 * 
 * **Phase 5: Mode Switch Events**
 *   - Processes agent event messages
 *   - Handles mode changes and other events
 * 
 * ## Key Behaviors:
 * 
 * - **Idempotency**: Calling the reducer multiple times with the same data produces no duplicates
 * - **Priority Rules**: When both tool calls and permissions exist, tool calls take priority
 * - **Argument Matching**: Tool calls match to permissions based on both name AND arguments
 * - **Timestamp Preservation**: Original timestamps are preserved when matching tools to permissions
 * - **State Persistence**: The ReducerState maintains all mappings across calls
 * - **Message Immutability**: NEVER modify message timestamps or core properties after creation
 *   Messages can only have their tool state/result updated, never their creation metadata
 * - **Timestamp Preservation**: NEVER change a message's createdAt timestamp. The timestamp
 *   represents when the message was originally created and must be preserved throughout all
 *   processing phases. This is critical for maintaining correct message ordering.
 * 
 * ## Permission Matching Algorithm:
 * 
 * When a tool call arrives, the matching algorithm:
 * 1. Checks if the tool has already been processed (via toolIdToMessageId)
 * 2. Searches for approved permission messages with:
 *    - Same tool name
 *    - Matching arguments (deep equality)
 *    - Not already linked to another tool
 * 3. Prioritizes the newest matching permission
 * 4. Updates the permission message with tool execution details
 * 5. Falls back to creating a new tool message if no match
 * 
 * ## Data Flow:
 * 
 * Raw Messages → Normalizer → Reducer → Structured Messages
 *                              ↑
 *                         AgentState
 * 
 * The reducer receives:
 * - Normalized messages from the sync system
 * - Current AgentState with permission information
 * 
 * And produces:
 * - Structured Message objects for UI rendering
 * - Updated internal state for future processing
 */

import { Message, ToolCall } from "../typesMessage";
import { AgentEvent, NormalizedMessage, UsageData } from "../typesRaw";
import { createTracer, traceMessages, TracerState } from "./reducerTracer";
import { AgentState, TodoItem, TodoItemsSchema } from "../storageTypes";
import { MessageMeta } from "../typesMessageMeta";
import { parseMessageAsEvent } from "./messageToEvent";
import equal from 'fast-deep-equal';
import { canonicalStreamMessageId } from '../sessionStream';

type ReducerMessage = {
    id: string;
    realID: string | null;
    createdAt: number;
    role: 'user' | 'agent';
    text: string | null;
    isThinking?: boolean;
    event: AgentEvent | null;
    tool: ToolCall | null;
    meta?: MessageMeta;
    images?: Array<{ mediaType: string; data?: string; url?: string }>;
    media?: Array<{ mediaType: string; url: string; name?: string; size?: number }>;
}

type StoredPermission = {
    tool: string;
    arguments: any;
    createdAt: number;
    completedAt?: number;
    status: 'pending' | 'submitting' | 'approved' | 'denied' | 'canceled' | 'expired';
    reason?: string;
    mode?: string;
    allowedTools?: string[];
    decision?: 'approved' | 'approved_for_session' | 'denied' | 'abort';
};

export type ReducerState = {
    inputEdits?: Map<string, { text: string; revision: number }>;
    toolIdToMessageId: Map<string, string>; // toolId/permissionId -> messageId (since they're the same now)
    sidechainToolIdToMessageId: Map<string, string>; // toolId -> sidechain messageId (for dual tracking)
    permissions: Map<string, StoredPermission>; // Store permission details by ID for quick lookup
    localIds: Map<string, string>;
    messageIds: Map<string, string>; // originalId -> internalId
    messages: Map<string, ReducerMessage>;
    sidechains: Map<string, ReducerMessage[]>;
    terminalTurns: Map<string, { status: 'cancelled' | 'failed'; at: number }>;
    tracerState: TracerState; // Tracer state for sidechain processing
    latestTodos?: {
        todos: TodoItem[];
        timestamp: number;
    };
    latestUsage?: {
        inputTokens: number;
        outputTokens: number;
        cacheCreation: number;
        cacheRead: number;
        contextSize: number;
        timestamp: number;
    };
};

export function createReducer(): ReducerState {
    return {
        toolIdToMessageId: new Map(),
        sidechainToolIdToMessageId: new Map(),
        permissions: new Map(),
        messages: new Map(),
        localIds: new Map(),
        messageIds: new Map(),
        sidechains: new Map(),
        terminalTurns: new Map(),
        tracerState: createTracer()
    }
};

const ENABLE_LOGGING = false;

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function matchesToolResultScope(tool: ReducerMessage, message: NormalizedMessage): boolean {
    return (!message.meta?.turnId || !tool.meta?.turnId || message.meta.turnId === tool.meta.turnId)
        && (message.meta?.branchId ?? 'main') === (tool.meta?.branchId ?? 'main');
}

function recordToolCompletionSource(tool: ToolCall, result: unknown): void {
    if (isRecord(result) && result.completedByTurn === true) tool.completedByTurn = true;
    else delete tool.completedByTurn;
}

function mergeToolInputs(existingInput: unknown, nextInput: unknown): unknown {
    if (isRecord(existingInput) && isRecord(nextInput)) {
        return { ...nextInput, ...existingInput };
    }
    return nextInput ?? existingInput;
}

function getSidechainOwner(state: ReducerState, sidechainId: string): ReducerMessage | null {
    const ownerMessageId = state.messageIds.get(sidechainId);
    if (ownerMessageId) {
        const owner = state.messages.get(ownerMessageId);
        if (owner?.tool) {
            return owner;
        }
    }

    for (const message of state.messages.values()) {
        if (message.realID === sidechainId && message.tool) {
            return message;
        }
    }

    return null;
}

function getVisibleSidechainPrompt(owner: ReducerMessage | null): string | null {
    const prompt = owner?.tool?.input?.prompt;
    if (typeof prompt !== 'string') {
        return null;
    }
    const normalized = prompt.trim();
    return normalized.length > 0 ? normalized : null;
}

function isDuplicateSidechainPrompt(
    existingSidechain: ReducerMessage[],
    ownerPrompt: string | null,
    text: string,
): boolean {
    if (existingSidechain.length > 0 || !ownerPrompt) {
        return false;
    }

    return text.trim() === ownerPrompt;
}

function getNormalizedUserText(msg: NormalizedMessage & { role: 'user' }): string {
    return msg.content.type === 'text'
        ? (msg.content as any).text
        : (msg.content as any).parts?.filter((p: any) => p.type === 'text').map((p: any) => p.text).join('\n') || '[image]';
}

function getNormalizedUserImages(msg: NormalizedMessage & { role: 'user' }): Array<{ mediaType: string; data?: string; url?: string }> | undefined {
    if (msg.content.type !== 'multimodal') {
        return undefined;
    }

    const images = (msg.content as any).parts?.filter((p: any) => p.type === 'image').map((p: any) => ({
        mediaType: p.source?.media_type,
        data: p.source?.data,
        url: p.source?.url,
    })).filter((image: any) => image.mediaType && (image.data || image.url));

    return images && images.length > 0 ? images : undefined;
}

export type ReducerResult = {
    messages: Message[];
    todos?: TodoItem[];
    usage?: {
        inputTokens: number;
        outputTokens: number;
        cacheCreation: number;
        cacheRead: number;
        contextSize: number;
    };
    hasReadyEvent?: boolean;
};

function updateLatestTodos(state: ReducerState, value: unknown, timestamp: number) {
    const parsed = TodoItemsSchema.safeParse(value);
    if (!parsed.success) {
        return;
    }

    if (!state.latestTodos || timestamp > state.latestTodos.timestamp) {
        state.latestTodos = {
            todos: parsed.data,
            timestamp,
        };
    }
}

export function reducer(state: ReducerState, messages: NormalizedMessage[], agentState?: AgentState | null): ReducerResult {
    if (ENABLE_LOGGING) {
        console.log(`[REDUCER] Called with ${messages.length} messages, agentState: ${agentState ? 'YES' : 'NO'}`);
        if (agentState?.requests) {
            console.log(`[REDUCER] AgentState has ${Object.keys(agentState.requests).length} pending requests`);
        }
        if (agentState?.completedRequests) {
            console.log(`[REDUCER] AgentState has ${Object.keys(agentState.completedRequests).length} completed requests`);
        }
    }

    let newMessages: Message[] = [];
    let changed: Set<string> = new Set();
    let hasReadyEvent = false;

    // First, trace all messages to identify sidechains
    const tracedMessages = traceMessages(state.tracerState, messages);

    // Separate sidechain and non-sidechain messages
    let nonSidechainMessages = tracedMessages.filter(msg => !msg.sidechainId);
    const sidechainMessages = tracedMessages.filter(msg => msg.sidechainId);

    //
    // Phase 0.5: Message-to-Event Conversion
    // Convert certain messages to events before normal processing
    //

    if (ENABLE_LOGGING) {
        console.log(`[REDUCER] Phase 0.5: Message-to-Event Conversion`);
    }

    const messagesToProcess: NormalizedMessage[] = [];
    const convertedEvents: { message: NormalizedMessage, event: AgentEvent }[] = [];

    for (const msg of nonSidechainMessages) {
        // Check if we've already processed this message
        if (
            msg.role === 'user'
            && msg.localId
            && state.localIds.has(msg.localId)
            && (!state.messageIds.has(msg.localId) || state.messageIds.has(msg.id))
        ) {
            continue;
        }
        if (state.messageIds.has(msg.id)) {
            continue;
        }

        // Filter out ready events completely - they should not create any message
        if (msg.role === 'event' && msg.content.type === 'ready') {
            // Mark as processed to prevent duplication but don't add to messages
            state.messageIds.set(msg.id, msg.id);
            hasReadyEvent = true;
            continue;
        }

        // Session protocol turn-start markers are lifecycle-only and should stay invisible.
        if (msg.role === 'event' && msg.content.type === 'message' && msg.content.message === 'Turn started') {
            state.messageIds.set(msg.id, msg.id);
            continue;
        }

        // Handle context reset events - reset state and let the message be shown
        if (msg.role === 'event' && msg.content.type === 'message' && msg.content.message === 'Context was reset') {
            // Reset todos to empty array and reset usage to zero
            state.latestTodos = {
                todos: [],
                timestamp: msg.createdAt  // Use message timestamp, not current time
            };
            state.latestUsage = {
                inputTokens: 0,
                outputTokens: 0,
                cacheCreation: 0,
                cacheRead: 0,
                contextSize: 0,
                timestamp: msg.createdAt  // Use message timestamp to avoid blocking older usage data
            };
            // Don't continue - let the event be processed normally to create a message
        }

        // Handle compaction completed events - reset context but keep todos
        if (msg.role === 'event' && msg.content.type === 'message' && msg.content.message === 'Compaction completed') {
            // Reset usage/context to zero but keep todos unchanged
            state.latestUsage = {
                inputTokens: 0,
                outputTokens: 0,
                cacheCreation: 0,
                cacheRead: 0,
                contextSize: 0,
                timestamp: msg.createdAt  // Use message timestamp to avoid blocking older usage data
            };
            // Don't continue - let the event be processed normally to create a message
        }

        // Try to parse message as event
        const event = parseMessageAsEvent(msg);
        if (event) {
            if (ENABLE_LOGGING) {
                console.log(`[REDUCER] Converting message ${msg.id} to event:`, event);
            }
            convertedEvents.push({ message: msg, event });
            // Mark as processed to prevent duplication
            state.messageIds.set(msg.id, msg.id);
            if (msg.role === 'user' && msg.localId) {
                state.localIds.set(msg.localId, msg.id);
            }
        } else {
            messagesToProcess.push(msg);
        }
    }

    // Process converted events immediately
    for (const { message, event } of convertedEvents) {
        const mid = allocateId();
        state.messages.set(mid, {
            id: mid,
            realID: message.id,
            role: 'agent',
            createdAt: message.createdAt,
            event: event,
            tool: null,
            text: null,
            meta: message.meta,
        });
        changed.add(mid);
    }

    // Update nonSidechainMessages to only include messages that weren't converted
    nonSidechainMessages = messagesToProcess;

    // Build a set of incoming tool IDs for quick lookup
    const incomingToolIds = new Set<string>();
    for (let msg of nonSidechainMessages) {
        if (msg.role === 'agent') {
            for (let c of msg.content) {
                if (c.type === 'tool-call') {
                    incomingToolIds.add(c.id);
                }
            }
        }
    }

    //
    // Phase 0: Process AgentState permissions
    //

    if (ENABLE_LOGGING) {
        console.log(`[REDUCER] Phase 0: Processing AgentState`);
    }
    if (agentState) {
        // Process pending permission requests
        if (agentState.requests) {
            for (const [permId, request] of Object.entries(agentState.requests)) {
                // Skip if this permission is also in completedRequests (completed takes precedence)
                if (agentState.completedRequests && agentState.completedRequests[permId]) {
                    continue;
                }

                // Check if we already have a message for this permission ID
                const existingMessageId = state.toolIdToMessageId.get(permId);
                if (existingMessageId) {
                    // Update existing tool message with permission info
                    const message = state.messages.get(existingMessageId);
                    if (message?.tool && (!message.tool.permission || message.tool.permission.status === 'pending' || message.tool.permission.status === 'submitting')
                        && (!message.tool.permission || message.tool.permission.status !== (request.status ?? 'pending')
                            || message.tool.permission.submittedAt !== request.submittedAt
                            || !equal(message.tool.permission.protocol, request.protocol)
                            || !equal(message.tool.input, request.arguments))) {
                        if (ENABLE_LOGGING) {
                            console.log(`[REDUCER] Updating existing tool ${permId} with permission`);
                        }
                        message.tool.permission = {
                            id: permId,
                            status: request.status ?? 'pending', protocol: request.protocol, submittedAt: request.submittedAt
                        };
                        message.tool.input = request.arguments;
                        changed.add(existingMessageId);
                    }
                } else {
                    if (ENABLE_LOGGING) {
                        console.log(`[REDUCER] Creating new message for permission ${permId}`);
                    }

                    // Create a new tool message for the permission request
                    let mid = allocateId();
                    let toolCall: ToolCall = {
                        name: request.tool,
                        state: 'running' as const,
                        input: request.arguments,
                        createdAt: request.createdAt || Date.now(),
                        startedAt: null,
                        completedAt: null,
                        description: null,
                        result: undefined,
                        permission: {
                            id: permId,
                            status: request.status ?? 'pending', protocol: request.protocol, submittedAt: request.submittedAt
                        }
                    };

                    state.messages.set(mid, {
                        id: mid,
                        realID: null,
                        role: 'agent',
                        createdAt: request.createdAt || Date.now(),
                        text: null,
                        tool: toolCall,
                        event: null,
                    });

                    // Store by permission ID (which will match tool ID)
                    state.toolIdToMessageId.set(permId, mid);

                    changed.add(mid);
                }

                // Store permission details for quick lookup
                state.permissions.set(permId, {
                    tool: request.tool,
                    arguments: request.arguments,
                    createdAt: request.createdAt || Date.now(),
                    status: request.status ?? 'pending'
                });
            }
        }

        // Process completed permission requests
        if (agentState.completedRequests) {
            for (const [permId, completed] of Object.entries(agentState.completedRequests)) {
                // Check if we have a message for this permission ID
                const messageId = state.toolIdToMessageId.get(permId);
                if (messageId) {
                    const message = state.messages.get(messageId);
                    if (message?.tool) {
                        // Skip if tool has already started actual execution with approval
                        if (message.tool.startedAt && message.tool.permission?.status === 'approved') {
                            continue;
                        }

                        // Skip if permission already has date (came from tool result - preferred over agentState)
                        if (message.tool.permission?.date) {
                            continue;
                        }

                        // Check if we need to update ANY field
                        const needsUpdate = 
                            message.tool.permission?.status !== completed.status ||
                            message.tool.permission?.reason !== completed.reason ||
                            message.tool.permission?.mode !== completed.mode ||
                            message.tool.permission?.allowedTools !== completed.allowedTools ||
                            message.tool.permission?.decision !== completed.decision;

                        if (!needsUpdate) {
                            continue;
                        }

                        let hasChanged = false;

                        // Update permission status
                        if (!message.tool.permission) {
                            message.tool.permission = {
                                id: permId,
                                status: completed.status,
                                protocol: completed.protocol, providerStatus: completed.providerStatus,
                                mode: completed.mode || undefined,
                                allowedTools: completed.allowedTools || undefined,
                                decision: completed.decision || undefined,
                                reason: completed.reason || undefined
                            };
                            hasChanged = true;
                        } else {
                            // Update all fields
                            message.tool.permission.status = completed.status;
                            message.tool.permission.protocol = completed.protocol;
                            message.tool.permission.providerStatus = completed.providerStatus;
                            message.tool.permission.mode = completed.mode || undefined;
                            message.tool.permission.allowedTools = completed.allowedTools || undefined;
                            message.tool.permission.decision = completed.decision || undefined;
                            if (completed.reason) {
                                message.tool.permission.reason = completed.reason;
                            }
                            hasChanged = true;
                        }

                        // Update tool state based on permission status
                        if (completed.status === 'approved') {
                            if (message.tool.name === 'AskUserQuestion' && completed.providerStatus === 'resolved') {
                                message.tool.state = 'completed';
                                message.tool.completedAt = completed.completedAt ?? Date.now();
                                hasChanged = true;
                            }
                            if (message.tool.state !== 'completed' && message.tool.state !== 'error' && message.tool.state !== 'running') {
                                message.tool.state = 'running';
                                hasChanged = true;
                            }
                        } else {
                            // denied or canceled
                            if (message.tool.state !== 'error' && message.tool.state !== 'completed') {
                                message.tool.state = 'error';
                                message.tool.completedAt = completed.completedAt || Date.now();
                                if (!message.tool.result && completed.reason) {
                                    message.tool.result = { error: completed.reason };
                                }
                                hasChanged = true;
                            }
                        }

                        // Update stored permission
                        state.permissions.set(permId, {
                            tool: completed.tool,
                            arguments: completed.arguments,
                            createdAt: completed.createdAt || Date.now(),
                            completedAt: completed.completedAt || undefined,
                            status: completed.status,
                            reason: completed.reason || undefined,
                            mode: completed.mode || undefined,
                            allowedTools: completed.allowedTools || undefined,
                            decision: completed.decision || undefined
                        });

                        if (hasChanged) {
                            changed.add(messageId);
                        }
                    }
                } else {
                    // No existing message - check if tool ID is in incoming messages
                    if (incomingToolIds.has(permId)) {
                        if (ENABLE_LOGGING) {
                            console.log(`[REDUCER] Storing permission ${permId} for incoming tool`);
                        }
                        // Store permission for when tool arrives in Phase 2
                        state.permissions.set(permId, {
                            tool: completed.tool,
                            arguments: completed.arguments,
                            createdAt: completed.createdAt || Date.now(),
                            completedAt: completed.completedAt || undefined,
                            status: completed.status,
                            reason: completed.reason || undefined
                        });
                        continue;
                    }

                    // Skip if already processed as pending
                    if (agentState.requests && agentState.requests[permId]) {
                        continue;
                    }

                    // Create a new message for completed permission without tool
                    let mid = allocateId();
                    let toolCall: ToolCall = {
                        name: completed.tool,
                        state: completed.status === 'approved' ? 'completed' : 'error',
                        input: completed.arguments,
                        createdAt: completed.createdAt || Date.now(),
                        startedAt: null,
                        completedAt: completed.completedAt || Date.now(),
                        description: null,
                        result: completed.status === 'approved'
                            ? 'Approved'
                            : (completed.reason ? { error: completed.reason } : undefined),
                        permission: {
                            id: permId,
                            status: completed.status,
                            reason: completed.reason || undefined,
                            mode: completed.mode || undefined,
                            allowedTools: completed.allowedTools || undefined,
                            decision: completed.decision || undefined
                        }
                    };

                    state.messages.set(mid, {
                        id: mid,
                        realID: null,
                        role: 'agent',
                        createdAt: completed.createdAt || Date.now(),
                        text: null,
                        tool: toolCall,
                        event: null,
                    });

                    state.toolIdToMessageId.set(permId, mid);

                    // Store permission details
                    state.permissions.set(permId, {
                        tool: completed.tool,
                        arguments: completed.arguments,
                        createdAt: completed.createdAt || Date.now(),
                        completedAt: completed.completedAt || undefined,
                        status: completed.status,
                        reason: completed.reason || undefined,
                        mode: completed.mode || undefined,
                        allowedTools: completed.allowedTools || undefined,
                        decision: completed.decision || undefined
                    });

                    changed.add(mid);
                }
            }
        }
    }

    //
    // Phase 1: Process non-sidechain user messages and text messages
    // 

    for (let msg of nonSidechainMessages) {
        if (msg.role === 'user') {
            if (msg.meta?.inputEdit) {
                const edit = msg.meta.inputEdit;
                state.inputEdits ??= new Map();
                if ((state.inputEdits.get(edit.messageId)?.revision ?? 0) < edit.revision) {
                    const value = { text: getNormalizedUserText(msg), revision: edit.revision };
                    state.inputEdits.set(edit.messageId, value);
                    const targetId = state.messageIds.get(edit.messageId) ?? state.localIds.get(edit.messageId);
                    const target = targetId ? state.messages.get(targetId) : undefined;
                    if (target && target.role === 'user') {
                        target.text = value.text;
                        target.meta = { ...target.meta, displayText: value.text };
                        changed.add(target.id);
                    }
                }
                continue;
            }
            // Check if we've seen this localId before
            if (msg.localId && state.localIds.has(msg.localId)) {
                const existingMessageId = state.localIds.get(msg.localId);
                const canUpgradeLocalEcho = state.messageIds.has(msg.localId);
                if (existingMessageId && canUpgradeLocalEcho) {
                    const existingMessage = state.messages.get(existingMessageId);
                    if (existingMessage && existingMessage.role === 'user') {
                        existingMessage.realID = msg.id;
                        const edit = state.inputEdits?.get(msg.id) ?? state.inputEdits?.get(msg.localId);
                        existingMessage.text = edit?.text ?? getNormalizedUserText(msg);
                        existingMessage.meta = edit ? { ...msg.meta, displayText: edit.text } : msg.meta;
                        existingMessage.images = getNormalizedUserImages(msg);
                        changed.add(existingMessageId);
                        state.messageIds.set(msg.id, existingMessageId);
                    }
                }
                continue;
            }
            // Check if we've seen this message ID before
            if (state.messageIds.has(msg.id)) {
                continue;
            }

            // Revisions may arrive before their original message during pagination.
            const inputEdit = state.inputEdits?.get(msg.id) ?? (msg.localId ? state.inputEdits?.get(msg.localId) : undefined);
            let mid = allocateId();
            state.messages.set(mid, {
                id: mid,
                realID: msg.id,
                role: 'user',
                createdAt: msg.createdAt,
                text: inputEdit?.text ?? getNormalizedUserText(msg),
                tool: null,
                event: null,
                meta: inputEdit ? { ...msg.meta, displayText: inputEdit.text } : msg.meta,
                images: getNormalizedUserImages(msg),
            });

            // Track both localId and messageId
            if (msg.localId) {
                state.localIds.set(msg.localId, mid);
            }
            state.messageIds.set(msg.id, mid);

            changed.add(mid);
        } else if (msg.role === 'agent') {
            // Check if we've seen this agent message before
            if (state.messageIds.has(msg.id)) {
                continue;
            }

            // Mark this message as seen
            state.messageIds.set(msg.id, msg.id);

            // Process usage data if present
            if (msg.usage) {
                processUsageData(state, msg.usage, msg.createdAt);
            }

            // Process text and thinking content (tool calls handled in Phase 2)
            for (let c of msg.content) {
                if (c.type === 'text' || c.type === 'thinking') {
                    const mid = (c.type === 'text' || msg.meta?.reasoningSummary) && msg.meta?.streamId
                        ? canonicalStreamMessageId(msg.meta.streamId, msg.meta.branchId, msg.meta.reasoningSummary ? 'reasoning-summary' : 'text')
                        : allocateId();
                    const isThinking = c.type === 'thinking';
                    const existingQuestion = state.messages.get(mid)?.meta?.asyncQuestion;
                    state.messages.set(mid, {
                        id: mid,
                        realID: msg.id,
                        role: 'agent',
                        createdAt: msg.createdAt,
                        text: isThinking ? (msg.meta?.reasoningSummary ? c.thinking : `*${c.thinking}*`) : c.text,
                        isThinking,
                        tool: null,
                        event: null,
                        meta: existingQuestion && !msg.meta?.asyncQuestion
                            ? { ...msg.meta, asyncQuestion: existingQuestion } : msg.meta,
                    });
                    changed.add(mid);
                } else if (c.type === 'media') {
                    let mid = allocateId();
                    state.messages.set(mid, {
                        id: mid,
                        realID: msg.id,
                        role: 'agent',
                        createdAt: msg.createdAt,
                        text: null,
                        tool: null,
                        event: null,
                        media: [{
                            mediaType: c.mediaType,
                            url: c.url,
                            name: c.name,
                            size: c.size,
                        }],
                        meta: msg.meta,
                    });
                    changed.add(mid);
                }
            }
        }
    }

    //
    // Phase 2: Process non-sidechain tool calls
    //

    if (ENABLE_LOGGING) {
        console.log(`[REDUCER] Phase 2: Processing tool calls`);
    }
    for (let msg of nonSidechainMessages) {
        if (msg.role === 'agent') {
            for (let c of msg.content) {
                if (c.type === 'tool-call') {
                    // Direct lookup by tool ID (since permission ID = tool ID now)
                    const existingMessageId = state.toolIdToMessageId.get(c.id);

                    if (existingMessageId) {
                        if (ENABLE_LOGGING) {
                            console.log(`[REDUCER] Found existing message for tool ${c.id}`);
                        }
                        // Update existing message with tool execution details
                        const message = state.messages.get(existingMessageId);
                        if (message?.tool) {
                            message.realID = msg.id;
                            message.meta = { ...message.meta, ...msg.meta };
                            message.tool.input = mergeToolInputs(message.tool.input, c.input);
                            message.tool.description = c.description;
                            message.tool.startedAt = msg.createdAt;
                            // If permission was approved and shown as completed (no tool), now it's running
                            if (message.tool.permission?.status === 'approved' && message.tool.state === 'completed') {
                                message.tool.state = 'running';
                                message.tool.completedAt = null;
                                message.tool.result = undefined;
                            }
                            changed.add(existingMessageId);

                        }
                    } else {
                        if (ENABLE_LOGGING) {
                            console.log(`[REDUCER] Creating new message for tool ${c.id}`);
                        }
                        // Check if there's a stored permission for this tool
                        const permission = state.permissions.get(c.id);

                        let toolCall: ToolCall = {
                            name: c.name,
                            state: 'running' as const,
                            input: permission ? mergeToolInputs(permission.arguments, c.input) : c.input,
                            createdAt: permission ? permission.createdAt : msg.createdAt,  // Use permission timestamp if available
                            startedAt: msg.createdAt,
                            completedAt: null,
                            description: c.description,
                            result: undefined,
                        };

                        // Add permission info if found
                        if (permission) {
                            if (ENABLE_LOGGING) {
                                console.log(`[REDUCER] Found stored permission for tool ${c.id}`);
                            }
                            toolCall.permission = {
                                id: c.id,
                                status: permission.status,
                                reason: permission.reason,
                                mode: permission.mode,
                                allowedTools: permission.allowedTools,
                                decision: permission.decision
                            };

                            // Update state based on permission status
                            if (permission.status !== 'approved') {
                                toolCall.state = 'error';
                                toolCall.completedAt = permission.completedAt || msg.createdAt;
                                if (permission.reason) {
                                    toolCall.result = { error: permission.reason };
                                }
                            }
                        }

                        let mid = allocateId();
                        state.messages.set(mid, {
                            id: mid,
                            realID: msg.id,
                            role: 'agent',
                            createdAt: msg.createdAt,
                            text: null,
                            tool: toolCall,
                            event: null,
                            meta: msg.meta,
                        });

                        state.toolIdToMessageId.set(c.id, mid);
                        changed.add(mid);

                    }
                }
            }
        }
    }

    //
    // Phase 3: Process non-sidechain tool results
    //

    for (let msg of nonSidechainMessages) {
        if (msg.role === 'agent') {
            for (let c of msg.content) {
                if (c.type === 'tool-result') {
                    // Find the message containing this tool
                    let messageId = state.toolIdToMessageId.get(c.tool_use_id);
                    if (!messageId) {
                        continue;
                    }

                    let message = state.messages.get(messageId);
                    if (!message || !message.tool) {
                        continue;
                    }

                    if (message.tool.state !== 'running' && !message.tool.completedByTurn) {
                        continue;
                    }
                    if (!matchesToolResultScope(message, msg)) continue;

                    // Update tool state and result
                    message.tool.state = c.is_error ? 'error' : 'completed';
                    message.tool.result = c.content;
                    message.tool.completedAt = msg.createdAt;
                    recordToolCompletionSource(message.tool, c.content);

                    // Update permission data if provided by backend
                    if (c.permissions) {
                        // Merge with existing permission to preserve decision field from agentState
                        if (message.tool.permission) {
                            // Preserve existing decision if not provided in tool result
                            const existingDecision = message.tool.permission.decision;
                            message.tool.permission = {
                                ...message.tool.permission,
                                id: c.tool_use_id,
                                status: c.permissions.result === 'approved' ? 'approved' : 'denied',
                                date: c.permissions.date,
                                mode: c.permissions.mode,
                                allowedTools: c.permissions.allowedTools,
                                decision: c.permissions.decision || existingDecision
                            };
                        } else {
                            message.tool.permission = {
                                id: c.tool_use_id,
                                status: c.permissions.result === 'approved' ? 'approved' : 'denied',
                                date: c.permissions.date,
                                mode: c.permissions.mode,
                                allowedTools: c.permissions.allowedTools,
                                decision: c.permissions.decision
                            };
                        }
                    }

                    if (message.tool.name === 'TodoWrite' && !c.is_error) {
                        updateLatestTodos(state, message.tool.result?.newTodos, msg.createdAt);
                    }

                    changed.add(messageId);
                }
            }
        }
    }

    //
    // Phase 4: Process sidechains and store them in state
    //

    // For each sidechain message, store it in the state and mark the Task as changed
    for (const msg of sidechainMessages) {
        if (!msg.sidechainId) continue;

        // Skip if we already processed this message
        if (state.messageIds.has(msg.id)) continue;

        // Mark as processed
        state.messageIds.set(msg.id, msg.id);

        // Get or create the sidechain array for this Task
        const existingSidechain = state.sidechains.get(msg.sidechainId) || [];
        const owner = getSidechainOwner(state, msg.sidechainId);
        const ownerPrompt = getVisibleSidechainPrompt(owner);

        // Process and add new sidechain messages
        if (msg.role === 'agent' && msg.content[0]?.type === 'sidechain') {
            // This is the sidechain root - create a user message
            if (isDuplicateSidechainPrompt(existingSidechain, ownerPrompt, msg.content[0].prompt)) {
                state.sidechains.set(msg.sidechainId, existingSidechain);
                continue;
            }
            let mid = allocateId();
            let userMsg: ReducerMessage = {
                id: mid,
                realID: msg.id,
                role: 'user',
                createdAt: msg.createdAt,
                text: msg.content[0].prompt,
                tool: null,
                event: null,
                meta: msg.meta,
            };
            state.messages.set(mid, userMsg);
            existingSidechain.push(userMsg);
        } else if (msg.role === 'agent') {
            // Process agent content in sidechain
            for (let c of msg.content) {
                if (c.type === 'text' || c.type === 'thinking') {
                    const text = c.type === 'thinking' ? c.thinking : c.text;
                    if (c.type === 'text' && isDuplicateSidechainPrompt(existingSidechain, ownerPrompt, text)) {
                        continue;
                    }
                    let mid = allocateId();
                    const isThinking = c.type === 'thinking';
                    let textMsg: ReducerMessage = {
                        id: mid,
                        realID: msg.id,
                        role: 'agent',
                        createdAt: msg.createdAt,
                        text: isThinking ? (msg.meta?.reasoningSummary ? c.thinking : `*${c.thinking}*`) : c.text,
                        isThinking,
                        tool: null,
                        event: null,
                        meta: msg.meta,
                    };
                    state.messages.set(mid, textMsg);
                    existingSidechain.push(textMsg);
                } else if (c.type === 'media') {
                    let mid = allocateId();
                    let mediaMsg: ReducerMessage = {
                        id: mid,
                        realID: msg.id,
                        role: 'agent',
                        createdAt: msg.createdAt,
                        text: null,
                        tool: null,
                        event: null,
                        media: [{ mediaType: c.mediaType, url: c.url, name: c.name, size: c.size }],
                        meta: msg.meta,
                    };
                    state.messages.set(mid, mediaMsg);
                    existingSidechain.push(mediaMsg);
                } else if (c.type === 'tool-call') {
                    // Check if there's already a permission message for this tool
                    const existingPermissionMessageId = state.toolIdToMessageId.get(c.id);

                    let mid = allocateId();
                    let toolCall: ToolCall = {
                        name: c.name,
                        state: 'running' as const,
                        input: c.input,
                        createdAt: msg.createdAt,
                        startedAt: null,
                        completedAt: null,
                        description: c.description,
                        result: undefined
                    };

                    // If there's a permission message, copy its permission info
                    if (existingPermissionMessageId) {
                        const permissionMessage = state.messages.get(existingPermissionMessageId);
                        if (permissionMessage?.tool?.permission) {
                            permissionMessage.meta = { ...permissionMessage.meta, ...msg.meta };
                            toolCall.permission = { ...permissionMessage.tool.permission };
                            // Update the permission message to show it's running
                            if (permissionMessage.tool.state !== 'completed' && permissionMessage.tool.state !== 'error') {
                                permissionMessage.tool.state = 'running';
                                permissionMessage.tool.startedAt = msg.createdAt;
                                permissionMessage.tool.description = c.description;
                                changed.add(existingPermissionMessageId);
                            }
                        }
                    }

                    let toolMsg: ReducerMessage = {
                        id: mid,
                        realID: msg.id,
                        role: 'agent',
                        createdAt: msg.createdAt,
                        text: null,
                        tool: toolCall,
                        event: null,
                        meta: msg.meta,
                    };
                    state.messages.set(mid, toolMsg);
                    existingSidechain.push(toolMsg);

                    // Map sidechain tool separately to avoid overwriting permission mapping
                    state.sidechainToolIdToMessageId.set(c.id, mid);
                } else if (c.type === 'tool-result') {
                    // Process tool result in sidechain - update BOTH messages

                    // Update the sidechain tool message
                    let sidechainMessageId = state.sidechainToolIdToMessageId.get(c.tool_use_id);
                    if (sidechainMessageId) {
                        let sidechainMessage = state.messages.get(sidechainMessageId);
                        if (sidechainMessage?.tool && (sidechainMessage.tool.state === 'running' || sidechainMessage.tool.completedByTurn)
                            && matchesToolResultScope(sidechainMessage, msg)) {
                            sidechainMessage.tool.state = c.is_error ? 'error' : 'completed';
                            sidechainMessage.tool.result = c.content;
                            sidechainMessage.tool.completedAt = msg.createdAt;
                            recordToolCompletionSource(sidechainMessage.tool, c.content);
                            
                            // Update permission data if provided by backend
                            if (c.permissions) {
                                // Merge with existing permission to preserve decision field from agentState
                                if (sidechainMessage.tool.permission) {
                                    const existingDecision = sidechainMessage.tool.permission.decision;
                                    sidechainMessage.tool.permission = {
                                        ...sidechainMessage.tool.permission,
                                        id: c.tool_use_id,
                                        status: c.permissions.result === 'approved' ? 'approved' : 'denied',
                                        date: c.permissions.date,
                                        mode: c.permissions.mode,
                                        allowedTools: c.permissions.allowedTools,
                                        decision: c.permissions.decision || existingDecision
                                    };
                                } else {
                                    sidechainMessage.tool.permission = {
                                        id: c.tool_use_id,
                                        status: c.permissions.result === 'approved' ? 'approved' : 'denied',
                                        date: c.permissions.date,
                                        mode: c.permissions.mode,
                                        allowedTools: c.permissions.allowedTools,
                                        decision: c.permissions.decision
                                    };
                                }
                            }
                        }
                    }

                    // Also update the main permission message if it exists
                    let permissionMessageId = state.toolIdToMessageId.get(c.tool_use_id);
                    if (permissionMessageId) {
                        let permissionMessage = state.messages.get(permissionMessageId);
                        if (permissionMessage?.tool && (permissionMessage.tool.state === 'running' || permissionMessage.tool.completedByTurn)
                            && matchesToolResultScope(permissionMessage, msg)) {
                            permissionMessage.tool.state = c.is_error ? 'error' : 'completed';
                            permissionMessage.tool.result = c.content;
                            permissionMessage.tool.completedAt = msg.createdAt;
                            recordToolCompletionSource(permissionMessage.tool, c.content);
                            
                            // Update permission data if provided by backend
                            if (c.permissions) {
                                // Merge with existing permission to preserve decision field from agentState
                                if (permissionMessage.tool.permission) {
                                    const existingDecision = permissionMessage.tool.permission.decision;
                                    permissionMessage.tool.permission = {
                                        ...permissionMessage.tool.permission,
                                        id: c.tool_use_id,
                                        status: c.permissions.result === 'approved' ? 'approved' : 'denied',
                                        date: c.permissions.date,
                                        mode: c.permissions.mode,
                                        allowedTools: c.permissions.allowedTools,
                                        decision: c.permissions.decision || existingDecision
                                    };
                                } else {
                                    permissionMessage.tool.permission = {
                                        id: c.tool_use_id,
                                        status: c.permissions.result === 'approved' ? 'approved' : 'denied',
                                        date: c.permissions.date,
                                        mode: c.permissions.mode,
                                        allowedTools: c.permissions.allowedTools,
                                        decision: c.permissions.decision
                                    };
                                }
                            }
                            
                            changed.add(permissionMessageId);
                        }
                    }
                }
            }
        }

        // Update the sidechain in state
        state.sidechains.set(msg.sidechainId, existingSidechain);

        // Find the Task tool message that owns this sidechain and mark it as changed
        // msg.sidechainId is the realID of the Task message
        for (const [internalId, message] of state.messages) {
            if (message.realID === msg.sidechainId && message.tool) {
                changed.add(internalId);
                break;
            }
        }
    }

    //
    // Phase 5: Process mode-switch messages
    //

    for (let msg of nonSidechainMessages) {
        if (msg.role === 'event') {
            let mid = allocateId();
            state.messages.set(mid, {
                id: mid,
                realID: msg.id,
                role: 'agent',
                createdAt: msg.createdAt,
                event: msg.content,
                tool: null,
                text: null,
                meta: msg.meta,
            });
            changed.add(mid);
        }
    }

    //
    // A cancelled/failed turn is authoritative even if the provider omits item/completed.
    // Keep its scope so a late tool-start from this same turn cannot resurrect a spinner.
    for (const message of messages) {
        if (!message.meta?.turnId || (message.turnEndStatus !== 'cancelled' && message.turnEndStatus !== 'failed')) continue;
        const key = JSON.stringify([message.meta.branchId ?? 'main', message.meta.turnId]);
        state.terminalTurns.set(key, { status: message.turnEndStatus, at: message.createdAt });
    }
    while (state.terminalTurns.size > 512) state.terminalTurns.delete(state.terminalTurns.keys().next().value!);
    const settleTool = (message: ReducerMessage): boolean => {
        if (message.tool?.state !== 'running' || !message.meta?.turnId) return false;
        const terminal = state.terminalTurns.get(JSON.stringify([message.meta.branchId ?? 'main', message.meta.turnId]));
        if (!terminal) return false;
        message.tool.state = 'error';
        message.tool.completedAt = terminal.at;
        message.tool.completedByTurn = true;
        message.tool.result = {
            ...(isRecord(message.tool.result) ? message.tool.result : {}),
            status: terminal.status === 'cancelled' ? 'interrupted' : 'failed',
        };
        return true;
    };
    const sidechainOwners = new Map<string, string>();
    for (const [ownerId, children] of state.sidechains) {
        for (const child of children) sidechainOwners.set(child.id, ownerId);
    }
    for (const message of state.messages.values()) {
        if (!settleTool(message)) continue;
        // Child tools live in state.messages too. Re-render their owning root card;
        // publishing the child itself would duplicate it as a top-level message.
        let visible = message;
        const visited = new Set<string>();
        while (sidechainOwners.has(visible.id) && !visited.has(visible.id)) {
            visited.add(visible.id);
            const owner = getSidechainOwner(state, sidechainOwners.get(visible.id)!);
            if (!owner) break;
            visible = owner;
        }
        if (!sidechainOwners.has(visible.id)) changed.add(visible.id);
    }

    // Collect changed messages (only root-level messages)
    //

    for (let id of changed) {
        let existing = state.messages.get(id);
        if (!existing) continue;

        let message = convertReducerMessageToMessage(existing, state);
        if (message) {
            newMessages.push(message);
        }
    }

    //
    // Debug changes
    //

    if (ENABLE_LOGGING) {
        console.log(JSON.stringify(messages, null, 2));
        console.log(`[REDUCER] Changed messages: ${changed.size}`);
    }

    return {
        messages: newMessages,
        todos: state.latestTodos?.todos,
        usage: state.latestUsage ? {
            inputTokens: state.latestUsage.inputTokens,
            outputTokens: state.latestUsage.outputTokens,
            cacheCreation: state.latestUsage.cacheCreation,
            cacheRead: state.latestUsage.cacheRead,
            contextSize: state.latestUsage.contextSize
        } : undefined,
        hasReadyEvent: hasReadyEvent || undefined
    };
}

//
// Helpers
//

function allocateId() {
    return Math.random().toString(36).substring(2, 15);
}

function processUsageData(state: ReducerState, usage: UsageData, timestamp: number) {
    // Only update if this is newer than the current latest usage
    if (!state.latestUsage || timestamp > state.latestUsage.timestamp) {
        state.latestUsage = {
            inputTokens: usage.input_tokens,
            outputTokens: usage.output_tokens,
            cacheCreation: usage.cache_creation_input_tokens || 0,
            cacheRead: usage.cache_read_input_tokens || 0,
            contextSize: (usage.cache_creation_input_tokens || 0) + (usage.cache_read_input_tokens || 0) + usage.input_tokens,
            timestamp: timestamp
        };
    }
}


function convertReducerMessageToMessage(reducerMsg: ReducerMessage, state: ReducerState): Message | null {
    if (reducerMsg.role === 'user' && reducerMsg.text !== null) {
        return {
            id: reducerMsg.id,
            localId: null,
            createdAt: reducerMsg.createdAt,
            kind: 'user-text',
            sourceMessageId: reducerMsg.realID ?? undefined,
            text: reducerMsg.text,
            ...(reducerMsg.meta?.displayText && { displayText: reducerMsg.meta.displayText }),
            meta: reducerMsg.meta,
            images: reducerMsg.images,
        };
    } else if (reducerMsg.role === 'agent' && reducerMsg.text !== null) {
        return {
            id: reducerMsg.id,
            localId: null,
            createdAt: reducerMsg.createdAt,
            kind: 'agent-text',
            text: reducerMsg.text,
            ...(reducerMsg.isThinking && { isThinking: true }),
            meta: reducerMsg.meta
        };
    } else if (reducerMsg.role === 'agent' && reducerMsg.media?.length) {
        return {
            id: reducerMsg.id,
            localId: null,
            createdAt: reducerMsg.createdAt,
            kind: 'agent-media',
            media: reducerMsg.media,
            meta: reducerMsg.meta,
        };
    } else if (reducerMsg.role === 'agent' && reducerMsg.tool !== null) {
        // Convert children recursively
        let childMessages: Message[] = [];
        let children = reducerMsg.realID ? state.sidechains.get(reducerMsg.realID) || [] : [];
        for (let child of children) {
            let childMessage = convertReducerMessageToMessage(child, state);
            if (childMessage) {
                childMessages.push(childMessage);
            }
        }

        return {
            id: reducerMsg.id,
            localId: null,
            createdAt: reducerMsg.createdAt,
            kind: 'tool-call',
            tool: { ...reducerMsg.tool },
            children: childMessages,
            meta: reducerMsg.meta
        };
    } else if (reducerMsg.role === 'agent' && reducerMsg.event !== null) {
        return {
            id: reducerMsg.id,
            createdAt: reducerMsg.createdAt,
            kind: 'agent-event',
            event: reducerMsg.event,
            meta: reducerMsg.meta
        };
    }

    return null;
}
