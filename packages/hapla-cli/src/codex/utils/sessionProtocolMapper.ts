import { randomUUID } from 'node:crypto';
import { createId } from '@paralleldrive/cuid2';
import type { ReasoningOutput } from './reasoningProcessor';
import type { DiffToolCall, DiffToolResult } from './diffProcessor';
import { createEnvelope, type CreateEnvelopeOptions, type SessionEnvelope } from '@hapla/wire';
import { COMMAND_PREVIEW_OUTPUT_BYTES, sanitizeCommandOutput } from './commandOutputStore';

export type CodexTurnState = {
    currentTurnId: string | null;
    startedSubagents?: Set<string>;
    activeSubagents?: Set<string>;
    providerSubagentToSessionSubagent?: Map<string, string>;
};

type CodexMapperResult = {
    currentTurnId: string | null;
    startedSubagents: Set<string>;
    activeSubagents: Set<string>;
    providerSubagentToSessionSubagent: Map<string, string>;
    envelopes: SessionEnvelope[];
};

type LegacyToolLikeMessage = {
    type: 'tool-call' | 'tool-call-result';
    callId: string;
    name?: string;
    input?: unknown;
    output?: {
        content?: string;
        status?: 'completed' | 'canceled';
    };
};

type TurnEndStatus = 'completed' | 'failed' | 'cancelled';

function formatTurnFailure(error: unknown): string {
    const detail = typeof error === 'string' ? error.trim()
        : error && typeof error === 'object' && 'message' in error && typeof error.message === 'string'
            ? error.message.trim() : '';
    return `Codex 执行失败：${detail || '本轮未正常完成，Codex 未提供具体错误信息。'}`;
}

function getStartedSubagents(state: CodexTurnState): Set<string> {
    return state.startedSubagents ?? new Set<string>();
}

function getActiveSubagents(state: CodexTurnState): Set<string> {
    return state.activeSubagents ?? new Set<string>();
}

function getProviderSubagentToSessionSubagent(state: CodexTurnState): Map<string, string> {
    return state.providerSubagentToSessionSubagent ?? new Map<string, string>();
}

function maybeEmitSubagentStart(
    subagent: string | undefined,
    opts: CreateEnvelopeOptions,
    startedSubagents: Set<string>,
    activeSubagents: Set<string>,
    envelopes: SessionEnvelope[],
): void {
    if (!subagent || startedSubagents.has(subagent)) {
        return;
    }

    envelopes.push(createEnvelope('agent', { t: 'start' }, { ...opts, subagent }));
    startedSubagents.add(subagent);
    activeSubagents.add(subagent);
}

function emitSubagentStops(
    opts: CreateEnvelopeOptions,
    startedSubagents: Set<string>,
    activeSubagents: Set<string>,
): SessionEnvelope[] {
    const envelopes: SessionEnvelope[] = [];
    for (const subagent of activeSubagents) {
        envelopes.push(createEnvelope('agent', { t: 'stop' }, { ...opts, subagent }));
    }
    activeSubagents.clear();
    startedSubagents.clear();
    return envelopes;
}

function buildEnvelopeOptions(currentTurnId: string | null, subagent?: string): CreateEnvelopeOptions {
    return {
        ...(currentTurnId ? { turn: currentTurnId } : {}),
        ...(subagent ? { subagent } : {}),
    };
}

function pickProviderSubagent(message: Record<string, unknown>): string | undefined {
    const candidates = [message.subagent, message.parent_call_id, message.parentCallId];
    for (const candidate of candidates) {
        if (typeof candidate === 'string' && candidate.length > 0) {
            return candidate;
        }
    }
    return undefined;
}

function resolveSessionSubagent(
    message: Record<string, unknown>,
    providerSubagentToSessionSubagent: Map<string, string>,
): string | undefined {
    const providerSubagent = pickProviderSubagent(message);
    if (!providerSubagent) {
        return undefined;
    }

    const existing = providerSubagentToSessionSubagent.get(providerSubagent);
    if (existing) {
        return existing;
    }

    const created = createId();
    providerSubagentToSessionSubagent.set(providerSubagent, created);
    return created;
}

function pickCallId(message: Record<string, unknown>): string {
    const callId = message.call_id ?? message.callId;
    if (typeof callId === 'string' && callId.length > 0) {
        return callId;
    }
    return randomUUID();
}

function summarizeCommand(command: unknown): string | null {
    if (typeof command === 'string' && command.trim().length > 0) {
        return command;
    }
    if (Array.isArray(command)) {
        const cmd = command.map(v => String(v)).join(' ').trim();
        return cmd.length > 0 ? cmd : null;
    }
    return null;
}

function commandToTitle(command: string | null): string {
    if (!command) {
        return 'Run command';
    }
    const short = command.length > 80 ? `${command.slice(0, 77)}...` : command;
    return `Run \`${short}\``;
}

function patchDescription(changes: unknown): string {
    if (!changes || typeof changes !== 'object') {
        return 'Applying patch';
    }
    const fileCount = Object.keys(changes as Record<string, unknown>).length;
    if (fileCount === 1) {
        return 'Applying patch to 1 file';
    }
    return `Applying patch to ${fileCount} files`;
}

function mcpToolDisplayName(server: unknown, tool: unknown): string {
    const normalize = (value: unknown) => String(value ?? 'unknown').replace(/[^a-zA-Z0-9_-]/g, '_');
    return `mcp__${normalize(server)}__${normalize(tool)}`;
}

function pickTurnEndStatus(message: Record<string, unknown>, type: unknown): TurnEndStatus {
    const rawStatus = message.status;
    if (rawStatus === 'completed' || rawStatus === 'failed' || rawStatus === 'cancelled') {
        return rawStatus;
    }
    if (rawStatus === 'canceled' || rawStatus === 'interrupted') {
        return 'cancelled';
    }

    // Abort events are treated as cancelled unless they explicitly look like failures.
    if (type === 'turn_aborted') {
        const reason = message.reason;
        const error = message.error;
        if ((typeof reason === 'string' && /(fail|error)/i.test(reason))
            || (typeof error === 'string' && error.length > 0)
            || (error !== undefined && error !== null && typeof error === 'object')) {
            return 'failed';
        }
        return 'cancelled';
    }

    if (message.error !== undefined && message.error !== null) {
        return 'failed';
    }

    return 'completed';
}

export function mapCodexMcpMessageToSessionEnvelopes(message: Record<string, unknown>, state: CodexTurnState): CodexMapperResult {
    const type = message.type;
    const startedSubagents = getStartedSubagents(state);
    const activeSubagents = getActiveSubagents(state);
    const providerSubagentToSessionSubagent = getProviderSubagentToSessionSubagent(state);
    const protocol = message.protocol as { turnId?: unknown } | undefined;
    const providerTurnId = typeof message.turn_id === 'string' ? message.turn_id
        : typeof protocol?.turnId === 'string' ? protocol.turnId : null;

    if (type === 'task_started') {
        const turnId = providerTurnId || createId();
        if (turnId === state.currentTurnId) {
            return { currentTurnId: state.currentTurnId, startedSubagents, activeSubagents, providerSubagentToSessionSubagent, envelopes: [] };
        }
        const turnStart = createEnvelope('agent', { t: 'turn-start' }, { turn: turnId });
        startedSubagents.clear();
        activeSubagents.clear();
        providerSubagentToSessionSubagent.clear();
        return {
            currentTurnId: turnId,
            startedSubagents,
            activeSubagents,
            providerSubagentToSessionSubagent,
            envelopes: [turnStart],
        };
    }

    if (type === 'task_complete' || type === 'turn_aborted') {
        if (providerTurnId && state.currentTurnId && providerTurnId !== state.currentTurnId) {
            return { currentTurnId: state.currentTurnId, startedSubagents, activeSubagents, providerSubagentToSessionSubagent, envelopes: [] };
        }
        if (!state.currentTurnId) {
            return {
                currentTurnId: null,
                startedSubagents,
                activeSubagents,
                providerSubagentToSessionSubagent,
                envelopes: [],
            };
        }

        const lifecycleOpts = { turn: state.currentTurnId } satisfies CreateEnvelopeOptions;
        const status = pickTurnEndStatus(message, type);
        providerSubagentToSessionSubagent.clear();
        return {
            currentTurnId: null,
            startedSubagents,
            activeSubagents,
            providerSubagentToSessionSubagent,
            envelopes: [
                ...emitSubagentStops(lifecycleOpts, startedSubagents, activeSubagents),
                ...(status === 'failed' ? [createEnvelope('agent', {
                    t: 'service', text: formatTurnFailure(message.error),
                }, lifecycleOpts)] : []),
                createEnvelope('agent', {
                    t: 'turn-end',
                    status,
                }, lifecycleOpts),
            ],
        };
    }

    if (type === 'token_count') {
        return {
            currentTurnId: state.currentTurnId,
            startedSubagents,
            activeSubagents,
            providerSubagentToSessionSubagent,
            envelopes: [],
        };
    }

    if (type === 'image_generation_error') {
        const diagnostic = typeof message.message === 'string'
            ? message.message.trim()
            : 'Image generation failed.';
        return {
            currentTurnId: state.currentTurnId,
            startedSubagents,
            activeSubagents,
            providerSubagentToSessionSubagent,
            envelopes: [createEnvelope('agent', {
                t: 'service',
                text: `**Image generation failed**\n\n${diagnostic}`,
            }, buildEnvelopeOptions(state.currentTurnId))],
        };
    }

    const subagent = resolveSessionSubagent(message, providerSubagentToSessionSubagent);
    const opts = buildEnvelopeOptions(providerTurnId || state.currentTurnId, subagent);

    if (type === 'agent_message') {
        if (typeof message.message !== 'string') {
            return {
                currentTurnId: state.currentTurnId,
                startedSubagents,
                activeSubagents,
                providerSubagentToSessionSubagent,
                envelopes: [],
            };
        }

        const envelopes: SessionEnvelope[] = [];
        maybeEmitSubagentStart(subagent, opts, startedSubagents, activeSubagents, envelopes);
        const itemId = typeof message.item_id === 'string' && message.item_id.length > 0
            ? message.item_id
            : undefined;
        envelopes.push(createEnvelope('agent', {
            t: 'text', text: message.message,
            ...(message.delivery === 'async' && Array.isArray(message.questions)
                ? { delivery: 'async' as const, questions: message.questions } : {}),
        }, {
            ...opts,
            ...(itemId ? { id: itemId } : {}),
        }));
        return {
            currentTurnId: state.currentTurnId,
            startedSubagents,
            activeSubagents,
            providerSubagentToSessionSubagent,
            envelopes,
        };
    }

    if (type === 'agent_reasoning' || type === 'agent_reasoning_delta') {
        const text = typeof message.text === 'string'
            ? message.text
            : (typeof message.delta === 'string' ? message.delta : null);

        if (!text || message.summary !== true || type !== 'agent_reasoning') {
            return {
                currentTurnId: state.currentTurnId,
                startedSubagents,
                activeSubagents,
                providerSubagentToSessionSubagent,
                envelopes: [],
            };
        }

        const envelopes: SessionEnvelope[] = [];
        maybeEmitSubagentStart(subagent, opts, startedSubagents, activeSubagents, envelopes);
        envelopes.push(createEnvelope('agent', { t: 'text', text, thinking: true, summary: true }, {
            ...opts,
            ...(typeof message.item_id === 'string' ? { id: message.item_id } : {}),
        }));
        return {
            currentTurnId: state.currentTurnId,
            startedSubagents,
            activeSubagents,
            providerSubagentToSessionSubagent,
            envelopes,
        };
    }

    // exec_approval_request is intentionally NOT mapped here — the permission
    // handler already renders the approval UI via agent state.  Mapping it to
    // tool-call-start too would create a duplicate tool call card.
    if (type === 'exec_command_begin') {
        const call = pickCallId(message);
        const { call_id: _callIdSnake, callId: _callIdCamel, type: _type, ...args } = message;

        const command = summarizeCommand((args as Record<string, unknown>).command);
        const description = typeof (args as Record<string, unknown>).description === 'string'
            ? ((args as Record<string, string>).description)
            : (command ?? 'Execute command');

        const envelopes: SessionEnvelope[] = [];
        maybeEmitSubagentStart(subagent, opts, startedSubagents, activeSubagents, envelopes);
        envelopes.push(
            createEnvelope('agent', {
                t: 'tool-call-start',
                call,
                name: 'CodexBash',
                title: commandToTitle(command),
                description,
                args: args as Record<string, unknown>,
            }, opts)
        );
        return {
            currentTurnId: state.currentTurnId,
            startedSubagents,
            activeSubagents,
            providerSubagentToSessionSubagent,
            envelopes,
        };
    }

    if (type === 'exec_command_end') {
        const call = pickCallId(message);
        const rawOutput = typeof message.output === 'string' ? message.output
            : typeof message.aggregatedOutput === 'string' ? message.aggregatedOutput
                : typeof message.stdout === 'string' ? message.stdout : '';
        const bytes = Buffer.from(rawOutput, 'utf8');
        let offset = Math.max(0, bytes.length - COMMAND_PREVIEW_OUTPUT_BYTES);
        while (offset < bytes.length && (bytes[offset] & 0xc0) === 0x80) offset++;
        const output = sanitizeCommandOutput(bytes.subarray(offset).toString('utf8'));
        const truncated = message.truncated === true || offset > 0;
        const exitCode = typeof message.exit_code === 'number' ? message.exit_code
            : typeof message.exitCode === 'number' ? message.exitCode : null;
        const durationMs = typeof message.duration_ms === 'number' ? message.duration_ms
            : typeof message.durationMs === 'number' ? message.durationMs : null;
        const envelopes: SessionEnvelope[] = [];
        maybeEmitSubagentStart(subagent, opts, startedSubagents, activeSubagents, envelopes);
        envelopes.push(createEnvelope('agent', {
            t: 'tool-call-end',
            call,
            stdout: output,
            outputTruncated: truncated,
            isError: message.status === 'failed' || message.status === 'interrupted' || (exitCode !== null && exitCode !== 0),
            result: {
                output,
                command: summarizeCommand(message.command),
                cwd: typeof message.cwd === 'string' ? message.cwd : null,
                exitCode,
                durationMs,
                status: typeof message.status === 'string' ? message.status : (exitCode === null ? 'completed' : exitCode === 0 ? 'completed' : 'failed'),
                truncated,
                totalBytes: typeof message.totalBytes === 'number' ? message.totalBytes : bytes.length,
                ...(message.completedByTurn === true ? { completedByTurn: true } : {}),
                ...(message.commandNotStarted === true ? { commandNotStarted: true } : {}),
                ...(message.commandTerminationConfirmed === true ? { commandTerminationConfirmed: true } : {}),
                ...(typeof message.logPath === 'string' ? { logPath: message.logPath } : {}),
            },
        }, opts));
        return {
            currentTurnId: state.currentTurnId,
            startedSubagents,
            activeSubagents,
            providerSubagentToSessionSubagent,
            envelopes,
        };
    }

    if (type === 'patch_apply_begin') {
        const call = pickCallId(message);
        const autoApproved = (message as { auto_approved?: unknown }).auto_approved;
        const changes = (message as { changes?: unknown }).changes;

        const envelopes: SessionEnvelope[] = [];
        maybeEmitSubagentStart(subagent, opts, startedSubagents, activeSubagents, envelopes);
        envelopes.push(
            createEnvelope('agent', {
                t: 'tool-call-start',
                call,
                name: 'CodexPatch',
                title: 'Apply patch',
                description: patchDescription(changes),
                args: {
                    auto_approved: autoApproved,
                    changes,
                },
            }, opts)
        );
        return {
            currentTurnId: state.currentTurnId,
            startedSubagents,
            activeSubagents,
            providerSubagentToSessionSubagent,
            envelopes,
        };
    }

    if (type === 'patch_apply_end') {
        const call = pickCallId(message);
        const envelopes: SessionEnvelope[] = [];
        maybeEmitSubagentStart(subagent, opts, startedSubagents, activeSubagents, envelopes);
        envelopes.push(createEnvelope('agent', { t: 'tool-call-end', call }, opts));
        return {
            currentTurnId: state.currentTurnId,
            startedSubagents,
            activeSubagents,
            providerSubagentToSessionSubagent,
            envelopes,
        };
    }

    if (type === 'mcp_tool_call_begin') {
        const call = pickCallId(message);
        const server = typeof message.server === 'string' ? message.server : 'unknown';
        const tool = typeof message.tool === 'string' ? message.tool : 'unknown';
        const resourceUri = typeof message.resource_uri === 'string' ? message.resource_uri : null;
        const toolArguments = message.arguments && typeof message.arguments === 'object'
            ? message.arguments
            : {};
        const envelopes: SessionEnvelope[] = [];
        maybeEmitSubagentStart(subagent, opts, startedSubagents, activeSubagents, envelopes);
        envelopes.push(createEnvelope('agent', {
            t: 'tool-call-start',
            call,
            name: mcpToolDisplayName(server, tool),
            title: `MCP: ${server} / ${tool}`,
            description: resourceUri ? 'Interactive MCP App' : `Calling ${server}`,
            args: {
                ...(toolArguments as Record<string, unknown>),
                __haplaMcpApp: {
                    protocolVersion: 1,
                    server,
                    tool,
                    resourceUri,
                    appContext: message.app_context ?? null,
                    pluginId: message.plugin_id ?? null,
                },
            },
        }, opts));
        return {
            currentTurnId: state.currentTurnId,
            startedSubagents,
            activeSubagents,
            providerSubagentToSessionSubagent,
            envelopes,
        };
    }

    if (type === 'mcp_tool_call_end') {
        const call = pickCallId(message);
        const resourceUri = typeof message.resource_uri === 'string' ? message.resource_uri : null;
        const result = {
            value: message.result ?? null,
            ...(message.error ? { error: message.error } : {}),
            __haplaMcpApp: {
                protocolVersion: 1,
                server: typeof message.server === 'string' ? message.server : 'unknown',
                tool: typeof message.tool === 'string' ? message.tool : 'unknown',
                resourceUri,
                appContext: message.app_context ?? null,
                pluginId: message.plugin_id ?? null,
            },
        };
        return {
            currentTurnId: state.currentTurnId,
            startedSubagents,
            activeSubagents,
            providerSubagentToSessionSubagent,
            envelopes: [createEnvelope('agent', {
                t: 'tool-call-end',
                call,
                result,
                isError: message.status === 'failed' || message.error != null,
            }, opts)],
        };
    }

    if (type === 'codex_item' && message.item && typeof message.item === 'object') {
        const item = message.item as Record<string, unknown>;
        const itemType = typeof item.type === 'string' ? item.type : 'unknown';
        const method = typeof message.method === 'string' ? message.method : '';

        if (method === 'item/completed' && itemType === 'plan' && typeof item.text === 'string') {
            return {
                currentTurnId: state.currentTurnId,
                startedSubagents,
                activeSubagents,
                providerSubagentToSessionSubagent,
                envelopes: [createEnvelope('agent', { t: 'text', text: item.text, thinking: true }, opts)],
            };
        }

        if (method === 'item/completed' && itemType === 'reasoning') {
            const parts = (Array.isArray(item.summary) ? item.summary : [])
                .filter((part): part is string => typeof part === 'string' && part.length > 0);
            return {
                currentTurnId: state.currentTurnId,
                startedSubagents,
                activeSubagents,
                providerSubagentToSessionSubagent,
                envelopes: parts.length > 0
                    ? [createEnvelope('agent', { t: 'text', text: parts.join('\n'), thinking: true, summary: true }, {
                        ...opts, ...(typeof item.id === 'string' ? { id: item.id } : {}),
                    })]
                    : [],
            };
        }

        if (method === 'item/completed' && (
            itemType === 'contextCompaction'
            || itemType === 'enteredReviewMode'
            || itemType === 'exitedReviewMode'
        )) {
            const label = itemType === 'contextCompaction'
                ? 'Codex compacted the conversation context.'
                : (itemType === 'enteredReviewMode' ? 'Codex entered review mode.' : 'Codex exited review mode.');
            return {
                currentTurnId: state.currentTurnId,
                startedSubagents,
                activeSubagents,
                providerSubagentToSessionSubagent,
                envelopes: [createEnvelope('agent', { t: 'service', text: label }, opts)],
            };
        }

        const call = typeof item.id === 'string' ? item.id : pickCallId(message);
        if (method === 'item/started') {
            const { id: _id, type: _itemType, ...args } = item;
            return {
                currentTurnId: state.currentTurnId,
                startedSubagents,
                activeSubagents,
                providerSubagentToSessionSubagent,
                envelopes: [createEnvelope('agent', {
                    t: 'tool-call-start',
                    call,
                    name: `Codex${itemType.charAt(0).toUpperCase()}${itemType.slice(1)}`,
                    title: itemType.replace(/([a-z])([A-Z])/g, '$1 $2'),
                    description: `Codex ${itemType}`,
                    args,
                }, opts)],
            };
        }

        if (method === 'item/completed') {
            return {
                currentTurnId: state.currentTurnId,
                startedSubagents,
                activeSubagents,
                providerSubagentToSessionSubagent,
                envelopes: [createEnvelope('agent', {
                    t: 'tool-call-end',
                    call,
                    result: item,
                    isError: item.status === 'failed' || item.success === false,
                }, opts)],
            };
        }
    }

    return {
        currentTurnId: state.currentTurnId,
        startedSubagents,
        activeSubagents,
        providerSubagentToSessionSubagent,
        envelopes: [],
    };
}

export function mapCodexProcessorMessageToSessionEnvelopes(
    message: ReasoningOutput | DiffToolCall | DiffToolResult,
    state: CodexTurnState,
): SessionEnvelope[] {
    const toolLikeMessage = message as LegacyToolLikeMessage;
    const opts = buildEnvelopeOptions(state.currentTurnId);

    if (message.type === 'reasoning') {
        return [createEnvelope('agent', {
            t: 'text',
            text: message.message,
            thinking: true,
        }, opts)];
    }

    if (message.type === 'tool-call') {
        const title = typeof (toolLikeMessage.input as { title?: unknown } | undefined)?.title === 'string'
            ? (toolLikeMessage.input as { title: string }).title
            : `${toolLikeMessage.name || 'Tool'} call`;

        return [createEnvelope('agent', {
            t: 'tool-call-start',
            call: toolLikeMessage.callId,
            name: toolLikeMessage.name || 'unknown',
            title,
            description: title,
            args: (toolLikeMessage.input && typeof toolLikeMessage.input === 'object'
                ? toolLikeMessage.input
                : {}) as Record<string, unknown>,
        }, opts)];
    }

    if (message.type === 'tool-call-result') {
        const envelopes: SessionEnvelope[] = [];
        const content = toolLikeMessage.output?.content;
        if (typeof content === 'string' && content.trim().length > 0) {
            envelopes.push(createEnvelope('agent', {
                t: 'text',
                text: content,
                thinking: true,
            }, opts));
        }
        envelopes.push(createEnvelope('agent', {
            t: 'tool-call-end',
            call: toolLikeMessage.callId,
        }, opts));
        return envelopes;
    }

    return [];
}
