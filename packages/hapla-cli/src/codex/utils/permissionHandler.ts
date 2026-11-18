/**
 * Codex Permission Handler
 *
 * Handles tool permission requests and responses for Codex sessions.
 * Extends BasePermissionHandler with Codex-specific configuration.
 */

import { logger } from "@/ui/logger";
import { ApiSessionClient } from "@/api/apiSession";
import type { AgentState } from "@/api/types";
import type { EventMsg } from '../codexAppServerTypes';
import { codexRequestIdentity, type CodexServerRequestContext } from './codexRequestIdentity';
import {
    BasePermissionHandler,
    PermissionResult,
    PendingRequest
} from '@/utils/BasePermissionHandler';
import type { PermissionResponse } from '@/utils/BasePermissionHandler';

type ProtocolRequest = {
    protocol: CodexServerRequestContext;
    toolName: string;
    input: unknown;
    createdAt: number;
    submittedAt?: number;
    decision?: PermissionResult['decision'];
    expiresAt?: number;
    expirationTimer?: ReturnType<typeof setTimeout>;
    expirationSubmitted?: boolean;
    promise: Promise<PermissionResult>;
};

const MAX_TIMER_DELAY_MS = 2_147_483_647;

function withQuestionExpiration(input: unknown, toolName: string, createdAt: number): {
    input: unknown;
    expiresAt?: number;
} {
    if (toolName !== 'AskUserQuestion' || !input || typeof input !== 'object' || Array.isArray(input)) {
        return { input };
    }
    const rawTimeout = (input as Record<string, unknown>).autoResolutionMs;
    const autoResolutionMs = typeof rawTimeout === 'number' && Number.isFinite(rawTimeout)
        ? Math.max(0, rawTimeout)
        : null;
    const expiresAt = autoResolutionMs === null ? null : createdAt + autoResolutionMs;
    return {
        input: { ...input, autoResolutionMs, expiresAt },
        ...(expiresAt === null ? {} : { expiresAt }),
    };
}

function redactInput(input: unknown): unknown {
    if (Array.isArray(input)) return input.map(redactInput);
    if (!input || typeof input !== 'object') return input;
    return Object.fromEntries(Object.entries(input).map(([key, value]) => [key,
        /^(?:password|passwd|access_?token|refresh_?token|api_?key|authorization|secret)$/i.test(key) ? '[已隐藏]' : redactInput(value),
    ]));
}

// Re-export types for backwards compatibility
export type { PermissionResult, PendingRequest };

/**
 * Codex-specific permission handler.
 */
export class CodexPermissionHandler extends BasePermissionHandler {
    private protocolRequests = new Map<string, ProtocolRequest>();
    private static readonly ALWAYS_AUTO_APPROVE_NAMES = [
        'change_title',
    ];

    constructor(session: ApiSessionClient) {
        super(session);
    }

    protected getLogPrefix(): string {
        return '[Codex]';
    }

    private shouldAutoApprove(toolName: string, toolCallId: string): boolean {
        if (CodexPermissionHandler.ALWAYS_AUTO_APPROVE_NAMES.some((name) => toolName.toLowerCase() === name.toLowerCase())) {
            return true;
        }

        return false;
    }

    /**
     * Handle a tool permission request
     * @param toolCallId - The unique ID of the tool call
     * @param toolName - The name of the tool being called
     * @param input - The input parameters for the tool
     * @returns Promise resolving to permission result
     */
    async handleToolCall(
        toolCallId: string,
        toolName: string,
        input: unknown,
        protocol?: CodexServerRequestContext,
    ): Promise<PermissionResult> {
        if (protocol) {
            const id = codexRequestIdentity(protocol);
            const existing = this.protocolRequests.get(id);
            if (existing) return existing.promise;
            let resolve!: PendingRequest['resolve'];
            let reject!: PendingRequest['reject'];
            const promise = new Promise<PermissionResult>((yes, no) => { resolve = yes; reject = no; });
            const createdAt = Date.now();
            const timedInput = withQuestionExpiration(input, toolName, createdAt);
            const request: ProtocolRequest = {
                protocol,
                toolName,
                input: redactInput(timedInput.input),
                createdAt,
                promise,
                ...(timedInput.expiresAt === undefined ? {} : { expiresAt: timedInput.expiresAt }),
            };
            this.protocolRequests.set(id, request);
            this.pendingRequests.set(id, { resolve, reject, toolName, input: timedInput.input });
            this.publishProtocolRequest(id, request);
            this.scheduleExpiration(id, request);
            if (this.shouldAutoApprove(toolName, toolCallId)) this.submitProtocolRequest(id, { decision: 'approved' });
            return promise;
        }
        if (this.shouldAutoApprove(toolName, toolCallId)) {
            logger.debug(`${this.getLogPrefix()} Auto-approving tool ${toolName} (${toolCallId})`);

            this.session.updateAgentState((currentState) => ({
                ...currentState,
                completedRequests: {
                    ...currentState.completedRequests,
                    [toolCallId]: {
                        tool: toolName,
                        arguments: input,
                        createdAt: Date.now(),
                        completedAt: Date.now(),
                        status: 'approved',
                        decision: 'approved',
                    },
                },
            } satisfies AgentState));

            return { decision: 'approved' };
        }

        return new Promise<PermissionResult>((resolve, reject) => {
            // Store the pending request
            this.pendingRequests.set(toolCallId, {
                resolve,
                reject,
                toolName,
                input
            });

            // Update agent state with pending request
            this.addPendingRequestToState(toolCallId, toolName, input);

            logger.debug(`${this.getLogPrefix()} Permission request sent for tool: ${toolName} (${toolCallId})`);
        });
    }

    protected override setupRpcHandler(): void {
        const registeredSession = this.session;
        this.session.rpcHandlerManager.registerHandler<PermissionResponse, { status: 'submitting' | 'resolved' }>(
            'permission', async response => {
                if (registeredSession !== this.session) throw new Error('Permission handler belongs to a replaced session connection');
                const tracked = this.protocolRequests?.get(response.id);
                if (tracked?.submittedAt !== undefined) return { status: 'submitting' };
                const pending = this.pendingRequests.get(response.id);
                if (!pending) throw new Error('This request is no longer pending in the active Codex runtime');
                const result: PermissionResult = response.approved
                    ? { decision: response.decision === 'approved_for_session' ? 'approved_for_session' : 'approved', ...(response.updatedInput ? { updatedInput: response.updatedInput } : {}) }
                    : { decision: response.decision === 'denied' ? 'denied' : 'abort' };
                if (tracked) {
                    this.submitProtocolRequest(response.id, result);
                    return { status: 'submitting' };
                }
                // Legacy providers lack authoritative request lifecycle notifications.
                this.pendingRequests.delete(response.id);
                pending.resolve(result);
                this.session.updateAgentState(state => {
                    const request = state.requests?.[response.id];
                    if (!request) return state;
                    const { [response.id]: removed, ...requests } = state.requests ?? {};
                    return { ...state, requests, completedRequests: { ...state.completedRequests, [response.id]: {
                        ...request, status: response.approved ? 'approved' : 'denied', decision: result.decision, completedAt: Date.now(),
                    } } };
                });
                return { status: 'resolved' };
            },
        );
    }

    private publishProtocolRequest(id: string, request: ProtocolRequest) {
        this.session.updateAgentState(state => ({ ...state, requests: { ...state.requests, [id]: {
            tool: request.toolName, arguments: request.input, createdAt: request.createdAt,
            protocol: request.protocol, status: request.submittedAt === undefined ? 'pending' : 'submitting',
            ...(request.submittedAt !== undefined ? { submittedAt: request.submittedAt } : {}),
        } } }));
    }

    private clearExpiration(request: ProtocolRequest) {
        if (request.expirationTimer !== undefined) clearTimeout(request.expirationTimer);
        request.expirationTimer = undefined;
    }

    private scheduleExpiration(id: string, request: ProtocolRequest) {
        if (request.expiresAt === undefined || request.submittedAt !== undefined) return;
        this.clearExpiration(request);
        const remaining = request.expiresAt - Date.now();
        if (remaining > MAX_TIMER_DELAY_MS) {
            request.expirationTimer = setTimeout(() => this.scheduleExpiration(id, request), MAX_TIMER_DELAY_MS);
            return;
        }
        request.expirationTimer = setTimeout(() => {
            request.expirationTimer = undefined;
            if (this.protocolRequests.get(id) !== request || request.submittedAt !== undefined) return;
            request.expirationSubmitted = true;
            this.submitProtocolRequest(id, { decision: 'abort' });
        }, Math.max(0, remaining));
    }

    private submitProtocolRequest(id: string, result: PermissionResult) {
        const request = this.protocolRequests.get(id);
        const pending = this.pendingRequests.get(id);
        if (!request || !pending || request.submittedAt !== undefined) return;
        this.clearExpiration(request);
        request.submittedAt = Date.now();
        request.decision = result.decision;
        // Answers (including secrets) go only to the waiting provider callback.
        // They are never added to persisted agent state or completed request cards.
        this.publishProtocolRequest(id, request);
        pending.resolve(result);
    }

    private closeProtocolRequest(id: string, authoritative: boolean, reason: string) {
        const request = this.protocolRequests.get(id);
        if (!request) return;
        this.clearExpiration(request);
        this.protocolRequests.delete(id);
        const pending = this.pendingRequests.get(id);
        this.pendingRequests.delete(id);
        if (request.submittedAt === undefined) pending?.resolve({ decision: 'abort' });
        const status = authoritative && request.expirationSubmitted
            ? 'expired'
            : !authoritative || request.decision === undefined || request.decision === 'abort'
            ? 'canceled' : request.decision === 'denied' ? 'denied' : 'approved';
        this.session.updateAgentState(state => {
            const { [id]: removed, ...requests } = state.requests ?? {};
            return { ...state, requests, completedRequests: { ...state.completedRequests, [id]: {
                tool: request.toolName, arguments: request.input, createdAt: request.createdAt,
                completedAt: Date.now(), status,
                reason: status === 'expired' ? 'Request expired' : reason,
                protocol: request.protocol,
                ...(request.decision ? { decision: request.decision } : {}),
                ...(authoritative ? { providerStatus: 'resolved' as const } : {}),
            } } };
        });
    }

    /** Only provider notifications close a submitted request successfully. */
    observeProtocolEvent(event: EventMsg) {
        const context = event.protocol;
        if (!context) return;
        for (const [id, request] of this.protocolRequests) {
            const sameEpoch = request.protocol.epoch === context.epoch;
            if (event.type === 'codex_runtime_started' && !sameEpoch) {
                this.closeProtocolRequest(id, false, 'Codex runtime restarted');
            } else if (sameEpoch && event.type === 'codex_request' && event.status === 'resolved'
                && request.protocol.requestId === context.requestId) {
                this.closeProtocolRequest(id, !event.resolution, event.resolution ? String(event.resolution) : 'Resolved by Codex');
            } else if (sameEpoch && (event.type === 'turn_aborted' || event.type === 'task_complete')
                && request.protocol.turnId && request.protocol.turnId === context.turnId) {
                this.closeProtocolRequest(id, false, 'Codex turn ended');
            } else if (sameEpoch && event.type === 'codex_thread_status'
                && (['processExited', 'disconnected', 'processError'].includes(String(event.reason))
                    || (event.source === 'snapshot' && context.threadId && request.protocol.threadId && context.threadId !== request.protocol.threadId))) {
                this.closeProtocolRequest(id, false, 'Codex request is no longer active');
            }
        }
    }

    override updateSession(session: ApiSessionClient): void {
        super.updateSession(session);
        for (const [id, request] of this.protocolRequests) this.publishProtocolRequest(id, request);
    }

    override abortAll(): void {
        // A stop button submits cancellation; it does not fabricate provider resolution.
        for (const id of this.protocolRequests.keys()) this.submitProtocolRequest(id, { decision: 'abort' });
        // Retain the old contract for legacy callers without request correlation.
        const legacyIds: string[] = [];
        for (const [id, pending] of this.pendingRequests) {
            if (this.protocolRequests.has(id)) continue;
            legacyIds.push(id);
            this.pendingRequests.delete(id);
            pending.resolve({ decision: 'abort' });
        }
        if (legacyIds.length) this.session.updateAgentState(state => {
            const requests = { ...state.requests };
            const completedRequests = { ...state.completedRequests };
            for (const id of legacyIds) {
                if (requests[id]) completedRequests[id] = { ...requests[id], completedAt: Date.now(), status: 'canceled', reason: 'Aborted by user' };
                delete requests[id];
            }
            return { ...state, requests, completedRequests };
        });
    }

    override reset(): void {
        for (const id of [...this.protocolRequests.keys()]) this.closeProtocolRequest(id, false, 'Codex runtime reset');
        super.reset();
    }
}
