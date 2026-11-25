import type { EffectiveSessionConfiguration } from '@hapla/wire';
/**
 * Codex App Server Client — drives Codex via the v2 JSON-RPC protocol
 * (`codex app-server`), replacing the legacy MCP-based CodexMcpClient.
 *
 * Protocol: JSON-RPC 2.0 over stdio (newline-delimited JSON).
 * Reference: codex-rs/app-server/README.md in the openai/codex repo.
 *
 * WARNING: @openai/codex-sdk wraps `codex exec`
 * (non-interactive, fire-and-forget). It has NO support for `app-server`,
 * interactive approvals, or bidirectional JSON-RPC. We need app-server for
 * mobile approval routing (exec:request, patch:request, mcp:call), which is
 * why this client is hand-rolled. Re-evaluate if the SDK ever adds an
 * app-server wrapper or approval callbacks.
 */

import type { ChildProcess } from 'node:child_process';
import { spawn as crossSpawn, sync as crossSpawnSync } from 'cross-spawn';
import { createInterface, type Interface as ReadlineInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { configuration } from '@/configuration';
import { CodexProtocolJournal, type CodexProtocolContext } from './codexProtocolJournal';
import { codexEventCorrelation, codexProtocolAdapter } from './codexProtocolAdapter';
import { CodexCommandTermination } from './codexCommandTermination';
import { resolveCodexExecutable } from './utils/resolveCodexExecutable';
import type { CodexServerRequestContext } from './utils/codexRequestIdentity';
import { logger } from '@/ui/logger';
import type {
    InitializeParams,
    NewConversationParams,
    NewConversationResponse,
    ResumeConversationParams,
    ResumeConversationResponse,
    InterruptConversationParams,
    ReviewDecision,
    EventMsg,
    JsonRpcRequest,
    JsonRpcResponse,
    ApprovalPolicy,
    SandboxMode,
    InputItem,
    ReasoningEffort,
    McpServerElicitationRequestResponse,
    CodexModel,
    ModelListResponse,
    CodexSkill,
    SkillsListResponse,
    McpResourceReadResponse,
    McpServerToolCallResponse,
    McpToolCallItem,
} from './codexAppServerTypes';
import type { SandboxConfig } from '@/persistence';
import { initializeSandbox, wrapForMcpTransport } from '@/sandbox/manager';
import packageJson from '../../package.json';
import { activityForCodexItem } from './codexActivity';
import { CodexTurnFailure } from './codexTurnFailure';

type PendingRequest = {
    resolve: (result: unknown) => void;
    reject: (error: Error) => void;
    method: string;
    epoch: number;
    context: ReturnType<typeof codexEventCorrelation>;
};

type LegacyPatchChanges = Record<string, Record<string, unknown>>;

type PendingCommandCleanup = {
    threadId: string;
    turnId: string;
    epoch: number;
    status: string | null;
    error: unknown;
    source: string;
    itemIds: string[];
    operation: Promise<void> | null;
};

const FIRST_CLASS_ITEM_TYPES = new Set([
    'userMessage',
    'agentMessage',
    'imageGeneration',
    'plan',
    'reasoning',
    'contextCompaction',
    'enteredReviewMode',
    'exitedReviewMode',
]);

export type ApprovalHandler = (params: {
    protocol?: CodexServerRequestContext;
    type: 'exec' | 'patch' | 'mcp';
    callId: string;
    command?: string[];
    cwd?: string;
    fileChanges?: Record<string, unknown>;
    reason?: string | null;
    toolName?: string;
    input?: unknown;
    serverName?: string;
    message?: string;
}) => Promise<ReviewDecision>;

export type UserInputHandler = (params: {
    protocol?: CodexServerRequestContext;
    requestId?: string | number;
    threadId: string;
    turnId: string;
    itemId: string;
    questions: Array<{
        id: string;
        header: string;
        question: string;
        isOther: boolean;
        isSecret: boolean;
        options: Array<{ label: string; description: string }> | null;
        multiSelect?: boolean;
        required?: boolean;
    }>;
    autoResolutionMs: number | null;
}) => Promise<{ answers: Record<string, { answers: string[] }>; cancelled?: boolean }>;

export type DynamicToolHandler = (params: unknown) => Promise<{
    contentItems: Array<Record<string, unknown>>;
    success: boolean;
}>;

export type ChatgptAuthTokensRefreshHandler = (params: unknown) => Promise<{
    accessToken: string;
    chatgptAccountId: string;
    chatgptPlanType: string | null;
}>;

export type AttestationHandler = (params: unknown) => Promise<{ token: string }>;

function elicitationOptions(schema: any): Array<{ label: string; description: string }> | null {
    if (Array.isArray(schema?.oneOf)) {
        return schema.oneOf.map((option: any) => ({
            label: String(option?.const ?? option?.title ?? ''),
            description: typeof option?.title === 'string' ? option.title : '',
        }));
    }
    const values = Array.isArray(schema?.enum)
        ? schema.enum
        : (Array.isArray(schema?.items?.enum) ? schema.items.enum : null);
    if (values) {
        return values.map((value: unknown, index: number) => ({
            label: String(value),
            description: Array.isArray(schema?.enumNames) ? String(schema.enumNames[index] ?? '') : '',
        }));
    }
    if (schema?.type === 'boolean') {
        return [
            { label: 'true', description: 'Yes' },
            { label: 'false', description: 'No' },
        ];
    }
    return null;
}

function elicitationValue(schema: any, answers: string[]): unknown {
    if (schema?.type === 'array') return answers;
    const answer = answers[0] ?? '';
    if (schema?.type === 'boolean') return answer === 'true';
    if (schema?.type === 'number' || schema?.type === 'integer') {
        const value = Number(answer);
        return Number.isFinite(value) ? value : answer;
    }
    return answer;
}

/**
 * Check that `codex app-server` is available.
 */
function appServerVersion(executable: string): string | null {
    try {
        const probe = crossSpawnSync(executable, ['--version'], { encoding: 'utf8', windowsHide: true });
        if (probe.error || probe.status !== 0) return null;
        const version = probe.stdout.trim();
        const match = version.match(/codex-cli\s+(\d+\.\d+\.\d+)/);
        if (!match) return null;
        const [, ver] = match;
        const [major, minor] = ver.split('.').map(Number);
        // app-server available in recent versions
        return major > 0 || minor >= 100 ? ver : null;
    } catch {
        return null;
    }
}

function normalizeRawFileChangeList(changes: unknown): LegacyPatchChanges | undefined {
    if (!Array.isArray(changes)) {
        return undefined;
    }

    const normalized: LegacyPatchChanges = {};
    for (const change of changes) {
        if (!change || typeof change !== 'object' || Array.isArray(change)) {
            continue;
        }

        const path = typeof change.path === 'string' ? change.path : null;
        if (!path) {
            continue;
        }

        const entry: Record<string, unknown> = {};
        if (typeof change.diff === 'string') {
            entry.diff = change.diff;
        }
        if (change.kind && typeof change.kind === 'object' && !Array.isArray(change.kind)) {
            entry.kind = change.kind;
        }

        normalized[path] = entry;
    }

    return Object.keys(normalized).length > 0 ? normalized : undefined;
}

export class CodexAppServerClient {
    private checkpointHasHistory = false;
    get isFreshThread(): boolean { return !this.checkpointHasHistory; }

    private executable: string;
    private readonly executableOverride?: string;
    private process: ChildProcess | null = null;
    private readline: ReadlineInterface | null = null;
    private nextId = 1;
    private pending = new Map<number, PendingRequest>();
    private processEpoch = 0;
    private locallyStartedTurnId: string | null = null;
    private turnIdleWaiters = new Set<{
        epoch: number; threadId: string | null; resolve: () => void; reject: (error: Error) => void;
    }>();
    private protocolEpoch = randomUUID();
    private epochStartedAt = 0;
    private cliVersion = 'unknown';
    private adapter = codexProtocolAdapter('unknown');
    private notificationContext: ReturnType<typeof codexEventCorrelation> | null = null;
    private readonly journal = new CodexProtocolJournal(
        join(configuration.logsDir, `codex-${randomUUID()}.jsonl`),
        (error) => logger.warn('[CodexAppServer] Could not persist protocol journal', error),
    );
    private serverRequests = new Map<string | number, { context: ReturnType<typeof codexEventCorrelation>; kind: 'approval' | 'userInput' | 'elicitation' }>();
    private connected = false;
    private sandboxConfig?: SandboxConfig;
    private sandboxCleanup: (() => Promise<void>) | null = null;
    public sandboxEnabled = false;

    // Session state
    private _threadId: string | null = null;
    private _turnId: string | null = null;
    private threadSelection = 0;
    private resolvedModel: string | null = null;
    private effective: EffectiveSessionConfiguration = {};
    private configurationHandler: ((value: EffectiveSessionConfiguration) => void) | undefined;
    private nativeDefaults: { model?: string; model_reasoning_effort?: ReasoningEffort; model_verbosity?: unknown } | undefined;
    get effectiveConfiguration(): EffectiveSessionConfiguration { return { ...this.effective }; }
    setConfigurationHandler(handler: (value: EffectiveSessionConfiguration) => void): void { this.configurationHandler = handler; }
    private publishConfiguration(value: EffectiveSessionConfiguration): void {
        this.effective = value;
        this.configurationHandler?.({ ...value });
    }
    private snapshotConfiguration(result: any): void {
        const sandbox = typeof result.sandbox === 'string' ? result.sandbox : result.sandbox?.type;
        const permissionMode = sandbox === 'readOnly' || sandbox === 'read-only' ? 'read-only'
            : sandbox === 'dangerFullAccess' || sandbox === 'danger-full-access' ? 'yolo'
            : result.approvalPolicy === 'on-request' ? 'safe-yolo' : result.approvalPolicy === 'untrusted' ? 'default' : undefined;
        this.publishConfiguration({ model: result.model, effort: result.reasoningEffort ?? null, permissionMode, threadId: result.thread.id });
    }
    private async configuredDefaults() {
        if (!this.nativeDefaults) {
            const result = await this.request('config/read', { includeLayers: false, cwd: this.threadDefaults?.cwd ?? process.cwd() }) as { config?: { model?: string; model_reasoning_effort?: ReasoningEffort; model_verbosity?: unknown } };
            this.nativeDefaults = result.config ?? {};
        }
        return this.nativeDefaults!;
    }
    private defaultEffort: ReasoningEffort | null = null;
    private defaultEffortModel: string | null = null;
    private modelDefaultEfforts = new Map<string, ReasoningEffort>();
    private appliedVerbosity: 'low' | 'medium' | 'high' | null | undefined;
    private defaultVerbosity: unknown = undefined;
    private threadDefaults: {
        model?: string;
        cwd?: string;
        approvalPolicy?: ApprovalPolicy;
        sandbox?: SandboxMode;
        mcpServers?: Record<string, unknown>;
    } | null = null;

    // Turn completion resolves only for the ID identified by a start notification or RPC response.
    private pendingTurnCompletion: {
        resolve: (aborted: boolean) => void;
        reject: (error: Error) => void;
        turnId: string | null;
    } | null = null;

    // Tracks in-flight interruptTurn() RPCs so sendTurnAndWait can wait for them
    // before starting a new turn (prevents stale turn/interrupt from aborting the next turn).
    private pendingInterrupt: Promise<void> | null = null;
    private interruptTarget: string | null = null;
    private abortOperation: Promise<{ hadActiveTurn: boolean; aborted: boolean; forcedRestart: boolean; resumedThread: boolean }> | null = null;
    private completedTurnStatus = new Map<string, string>();
    private completedTurnErrors = new Map<string, unknown>();
    private failureRecovery: Promise<void> | null = null;
    private finalizedTurnIds = new Set<string>();
    private readonly commandTermination = new CodexCommandTermination();
    private readonly commandCleanups = new Map<string, PendingCommandCleanup>();
    private readonly commandCleanupTimeouts = new Map<string, number>();
    private startingTurn = false;
    private turnStartId: string | null = null;
    private notificationProtocol: 'unknown' | 'legacy' | 'raw' = 'unknown';
    private completedTurnIds = new Set<string>();
    private rawFileChangesByItemId = new Map<string, LegacyPatchChanges>();

    // Handlers set by the consumer (runCodex.ts)
    private eventHandler: ((msg: EventMsg) => void) | null = null;
    private approvalHandler: ApprovalHandler | null = null;
    private userInputHandler: UserInputHandler | null = null;
    private dynamicToolHandler: DynamicToolHandler | null = null;
    private authTokensRefreshHandler: ChatgptAuthTokensRefreshHandler | null = null;
    private attestationHandler: AttestationHandler | null = null;
    private codexArgs: string[];

    constructor(sandboxConfig?: SandboxConfig, codexArgs: string[] = [], executable?: string) {
        this.executableOverride = executable;
        this.executable = executable ?? resolveCodexExecutable();
        this.sandboxConfig = sandboxConfig;
        this.codexArgs = codexArgs;
    }

    get threadId(): string | null {
        return this._threadId;
    }

    get turnId(): string | null {
        return this._turnId;
    }

    get startId(): string | null { return this.turnStartId; }

    get protocolJournalPath(): string { return this.journal.path; }

    /** Wait for an unsolicited provider turn (for example explicit compaction) to finish. */
    waitForTurnIdle(): Promise<void> {
        if (this.failureRecovery) return this.failureRecovery.then(() => this.waitForTurnIdle());
        if (!this.connected) return Promise.reject(new Error('Codex runtime disconnected before becoming idle'));
        if (!this._turnId && !this.startingTurn) return Promise.resolve();
        return new Promise((resolve, reject) => {
            this.turnIdleWaiters.add({ epoch: this.processEpoch, threadId: this._threadId, resolve, reject });
        });
    }

    private settleTurnIdleWaiters(error?: Error): void {
        for (const waiter of this.turnIdleWaiters) {
            const failure = error ?? (waiter.epoch !== this.processEpoch || waiter.threadId !== this._threadId
                ? new Error('Codex idle wait belongs to a replaced runtime or thread') : undefined);
            if (failure) { this.turnIdleWaiters.delete(waiter); waiter.reject(failure); }
            else if (!this._turnId && !this.startingTurn) { this.turnIdleWaiters.delete(waiter); waiter.resolve(); }
        }
    }

    private protocolContext(params?: unknown): Omit<CodexProtocolContext, 'seq' | 'at'> {
        const specific = codexEventCorrelation(params);
        const context = this.notificationContext ?? {};
        return {
            epoch: this.protocolEpoch,
            epochStartedAt: this.epochStartedAt,
            threadId: specific.threadId ?? context.threadId ?? this._threadId ?? undefined,
            turnId: specific.turnId ?? context.turnId ?? this._turnId ?? undefined,
            itemId: specific.itemId ?? context.itemId,
            requestId: specific.requestId ?? context.requestId,
        };
    }

    private emitEvent(event: EventMsg): void {
        const protocol = this.journal.append({
            cliVersion: this.cliVersion, adapter: this.adapter.id,
            protocol: this.protocolContext(event), kind: 'event', direction: 'internal', message: event,
        });
        this.eventHandler?.({ ...event, protocol });
    }

    private recordRaw(message: any, direction: 'incoming' | 'outgoing'): void {
        const responseContext = direction === 'incoming' && !message?.method && message?.id != null
            ? this.pending.get(message.id)?.context : undefined;
        this.journal.append({
            cliVersion: this.cliVersion, adapter: this.adapter.id,
            protocol: { ...this.protocolContext(message?.params ?? message?.result), ...responseContext,
                ...(message?.id != null ? { requestId: message.id } : {}) },
            kind: 'raw', direction, message,
        });
    }

    private applyThreadSnapshot(thread: Record<string, unknown>): void {
        if (thread.status) this.emitEvent({ type: 'codex_thread_status', source: 'snapshot', status: thread.status, thread_id: thread.id });
        if (Array.isArray(thread.turns)) {
            const active = thread.turns.find((turn) => turn?.status === 'inProgress');
            if (active && typeof active.id === 'string') {
                this._turnId = active.id;
                this.emitEvent({ type: 'task_started', thread_id: thread.id, turn_id: active.id });
            }
        }
        this.settleTurnIdleWaiters();
    }

    setEventHandler(handler: (msg: EventMsg) => void): void {
        this.eventHandler = handler;
    }

    setApprovalHandler(handler: ApprovalHandler): void {
        this.approvalHandler = handler;
    }

    setUserInputHandler(handler: UserInputHandler): void {
        this.userInputHandler = handler;
    }

    setDynamicToolHandler(handler: DynamicToolHandler): void {
        this.dynamicToolHandler = handler;
    }

    setChatgptAuthTokensRefreshHandler(handler: ChatgptAuthTokensRefreshHandler): void {
        this.authTokensRefreshHandler = handler;
    }

    setAttestationHandler(handler: AttestationHandler): void {
        this.attestationHandler = handler;
    }

    private extractTurnId(params: any): string | null {
        const turnId = params?.turn?.id ?? params?.turnId ?? params?.turn_id ?? null;
        return typeof turnId === 'string' && turnId.length > 0 ? turnId : null;
    }

    private extractTurnStatus(params: any): string | null {
        const status = params?.turn?.status ?? params?.status ?? null;
        return typeof status === 'string' && status.length > 0 ? status : null;
    }

    private shouldHandleRawNotification(method: string): boolean {
        const isRawNotification = method === 'thread/started'
            || method === 'turn/started'
            || method === 'turn/completed'
            || method === 'thread/status/changed'
            || method === 'thread/tokenUsage/updated'
            || method.startsWith('item/');

        if (!isRawNotification) {
            return false;
        }

        if (this.notificationProtocol === 'legacy') {
            return false;
        }

        if (this.notificationProtocol === 'unknown') {
            this.notificationProtocol = 'raw';
        }

        return true;
    }

    private emitRawTurnCompletion(
        turnId: string | null,
        status: string | null,
        error: unknown,
        source: string,
    ): void {
        const aborted = status === 'cancelled' || status === 'canceled' || status === 'aborted' || status === 'interrupted';
        if (turnId && this.completedTurnIds.has(turnId)) {
            return;
        }
        // A delayed completion must not clear or complete another turn. A response
        // that beats turn/start is retained until that RPC identifies its turn.
        if (!turnId || (this._turnId && this._turnId !== turnId)) return;
        if (this.startingTurn && !this._turnId) {
            this.completedTurnStatus.set(turnId, status ?? 'completed');
            this.completedTurnErrors.set(turnId, error);
            return;
        }
        if (!this._turnId && !this.pendingTurnCompletion) return;
        if (turnId) {
            this.completedTurnIds.add(turnId);
            this.completedTurnStatus.set(turnId, status ?? 'completed');
            for (const [requestId, request] of this.serverRequests) {
                if (request.context.turnId !== turnId) continue;
                this.serverRequests.delete(requestId);
                this.emitEvent({ type: 'codex_request', status: 'resolved', resolution: 'turnEnded', kind: request.kind, ...request.context });
            }
            if (this.completedTurnIds.size > 512) {
                const oldest = this.completedTurnIds.values().next().value!;
                this.completedTurnIds.delete(oldest);
                this.completedTurnStatus.delete(oldest);
                this.completedTurnErrors.delete(oldest);
                this.finalizedTurnIds.delete(oldest);
            }
        }

        const threadId = this._threadId;
        if (aborted && threadId) {
            for (const command of this.commandTermination.takeUnstartedApprovals(threadId, turnId)) {
                this.emitEvent({
                    type: 'exec_command_end', call_id: command.itemId, item_id: command.itemId,
                    thread_id: threadId, turn_id: turnId, command: command.command, cwd: command.cwd,
                    status: 'interrupted', output: '', exit_code: null, duration_ms: null,
                    commandNotStarted: true, completedByTurn: true,
                });
            }
        }
        const commands = threadId ? this.commandTermination.pending(threadId, turnId) : [];
        if ((aborted || status === 'failed') && threadId && commands.length) {
            const cleanup: PendingCommandCleanup = {
                threadId, turnId, epoch: this.processEpoch, status, error, source,
                itemIds: commands.map((command) => command.itemId), operation: null,
            };
            this.commandCleanups.set(turnId, cleanup);
            void this.finishCommandCleanup(cleanup);
            return;
        }
        this.finalizeTurnCompletion(turnId, status, error, source, aborted);
    }

    private finalizeTurnCompletion(turnId: string, status: string | null, error: unknown, source: string, aborted: boolean, cleanupItemIds?: string[]): void {
        this.finalizedTurnIds.add(turnId);
        this.commandCleanups.delete(turnId);
        this.commandCleanupTimeouts.delete(turnId);

        if (aborted) {
            this.emitEvent({
                type: 'turn_aborted',
                ...(turnId ? { turn_id: turnId } : {}),
                ...(status ? { status } : {}),
                ...(error !== undefined && error !== null ? { error } : {}),
                commands_confirmed: true,
                ...(cleanupItemIds ? { cleanup_item_ids: cleanupItemIds } : {}),
            });
        } else this.emitEvent({
            type: 'task_complete',
            ...(turnId ? { turn_id: turnId } : {}),
            ...(status ? { status } : {}),
            ...(error !== undefined && error !== null ? { error } : {}),
        });
        if (status === 'failed' || (!aborted && error != null)) {
            const pending = this.pendingTurnCompletion;
            if (pending && (!pending.turnId || pending.turnId === turnId) && this._threadId) {
                this.pendingTurnCompletion = null;
                pending.reject(new CodexTurnFailure(this._threadId, turnId, this.processEpoch, error));
            }
        } else this.tryResolvePendingTurn(aborted, turnId, source);
        this._turnId = null;
        this.turnStartId = null;
        this.interruptTarget = null;
        this.locallyStartedTurnId = null;
        this.settleTurnIdleWaiters();
    }

    private commandTransport(threadId: string, epoch: number) {
        return {
            request: <T>(method: string, params: unknown, timeoutMs: number) => this.requestRaw<T>(method, params, timeoutMs),
            assertCurrent: () => {
                if (this.processEpoch !== epoch || this._threadId !== threadId || !this.connected) {
                    throw new Error('Codex command cleanup belongs to an inactive runtime or thread');
                }
            },
        };
    }

    private finishCommandCleanup(cleanup: PendingCommandCleanup): Promise<void> {
        if (cleanup.operation) return cleanup.operation;
        this.emitEvent({ type: 'codex_command_cleanup', status: 'pending', thread_id: cleanup.threadId, turn_id: cleanup.turnId, itemIds: cleanup.itemIds });
        const operation = this.commandTermination.terminate(cleanup.threadId, cleanup.turnId,
            this.commandTransport(cleanup.threadId, cleanup.epoch), this.commandCleanupTimeouts.get(cleanup.turnId) ?? 10_000)
            .then(() => {
                if (this.commandCleanups.get(cleanup.turnId) !== cleanup || this.processEpoch !== cleanup.epoch || this._threadId !== cleanup.threadId) return;
                this.emitEvent({ type: 'codex_command_cleanup', status: 'confirmed', thread_id: cleanup.threadId, turn_id: cleanup.turnId, itemIds: cleanup.itemIds });
                const aborted = cleanup.status !== 'failed';
                this.finalizeTurnCompletion(cleanup.turnId, cleanup.status, cleanup.error, cleanup.source, aborted, cleanup.itemIds);
            }).catch((error) => {
                if (this.commandCleanups.get(cleanup.turnId) !== cleanup || this.processEpoch !== cleanup.epoch || this._threadId !== cleanup.threadId) return;
                this.emitEvent({ type: 'codex_command_cleanup', status: 'failed', thread_id: cleanup.threadId, turn_id: cleanup.turnId,
                    itemIds: this.commandTermination.pending(cleanup.threadId, cleanup.turnId).map((command) => command.itemId),
                    message: error instanceof Error ? error.message : String(error) });
                logger.warn('[CodexAppServer] Native command termination remains unconfirmed', error);
            }).finally(() => { if (cleanup.operation === operation) cleanup.operation = null; });
        cleanup.operation = operation;
        return operation;
    }

    private handleRawNotification(method: string, params: any): boolean {
        if (method === 'rawResponseItem/completed') {
            const rawItem = params?.item;
            if (rawItem?.type === 'custom_tool_call_output') {
                const output = rawItem.output;
                const text = typeof output === 'string'
                    ? output
                    : (Array.isArray(output)
                        ? output
                            .map((part) => part && typeof part === 'object' && typeof part.text === 'string' ? part.text : '')
                            .filter(Boolean)
                            .join('\n')
                        : '');
                if (/image generation failed/i.test(text)) {
                    this.emitEvent({
                        type: 'image_generation_error',
                        call_id: typeof rawItem.call_id === 'string' ? rawItem.call_id : null,
                        message: text.slice(0, 4000),
                    });
                }
            }
            return true;
        }

        if (!this.shouldHandleRawNotification(method)) {
            return false;
        }

        if (method === 'turn/started') {
            const turnId = this.extractTurnId(params);
            if (turnId && this._turnId === turnId) return true;
            if (turnId && (this.completedTurnIds.has(turnId) || (this._turnId && this._turnId !== turnId))) return true;
            if (turnId) {
                this._turnId = turnId;
            }
            this.markPendingTurnStarted(turnId);
            this.emitEvent({
                type: 'task_started',
                ...(turnId ? { turn_id: turnId } : {}),
            });
            return true;
        }

        if (method === 'turn/completed') {
            this.emitRawTurnCompletion(
                this.extractTurnId(params),
                this.extractTurnStatus(params),
                params?.turn?.error ?? params?.error,
                method,
            );
            return true;
        }

        if (method === 'thread/status/changed') {
            // Thread status is informational. In particular, `idle` can race
            // with the next turn/start request and does not carry a turn ID,
            // so it must never resolve a turn completion promise.
            this.emitEvent({ type: 'codex_thread_status', source: 'notification', status: params?.status, thread_id: params?.threadId });
            return true;
        }

        if (method === 'thread/tokenUsage/updated') {
            const tokenUsage = params?.tokenUsage;
            if (tokenUsage && typeof tokenUsage === 'object') {
                this.emitEvent({
                    type: 'token_count',
                    ...tokenUsage,
                });
            }
            return true;
        }

        if (method === 'item/agentMessage/delta') {
            const delta = params?.delta;
            const itemId = params?.itemId;
            if (typeof delta === 'string' && delta.length > 0 && typeof itemId === 'string' && itemId.length > 0) {
                this.emitEvent({
                    type: 'agent_message_delta',
                    delta,
                    item_id: itemId,
                    thread_id: params?.threadId,
                    turn_id: params?.turnId,
                });
            }
            return true;
        }

        if (method === 'item/reasoning/summaryTextDelta') {
            if (typeof params?.delta === 'string' && typeof params?.itemId === 'string') this.emitEvent({
                type: 'agent_reasoning_delta', summary: true, delta: params.delta,
                summary_index: params.summaryIndex, item_id: params.itemId,
                thread_id: params.threadId, turn_id: params.turnId,
            });
            return true;
        }
        if (method === 'item/reasoning/summaryPartAdded') {
            this.emitEvent({ type: 'agent_reasoning_section_break', summary: true, summary_index: params.summaryIndex,
                item_id: params.itemId, thread_id: params.threadId, turn_id: params.turnId });
            return true;
        }
        // Raw thinking is journaled, but is never projected as ordinary message content.
        if (method === 'item/reasoning/textDelta') return true;

        if (method === 'item/commandExecution/outputDelta') {
            if (typeof params?.threadId === 'string' && typeof params?.turnId === 'string' && typeof params?.itemId === 'string') {
                this.commandTermination.observeOutput(params.threadId, params.turnId, params.itemId);
            }
            this.emitEvent({
                type: 'exec_command_output_delta', delta: params?.delta,
                call_id: params?.itemId, item_id: params?.itemId,
                thread_id: params?.threadId, turn_id: params?.turnId,
            });
            return true;
        }

        const item = params?.item;
        if (!item || typeof item !== 'object') {
            // Unknown item deltas remain available to future adapters and diagnostics.
            return false;
        }

        if (method === 'item/started' && item.type !== 'userMessage') {
            this.emitEvent({
                type: 'codex_activity',
                ...activityForCodexItem(item as Record<string, unknown>),
            });
        }

        // These item families have dedicated message/media/service renderers.
        // Forwarding their `started` notification into the generic tool
        // fallback creates a tool card that can never receive its matching end
        // event, while forwarding user messages also duplicates private prompt
        // plumbing in Coder mode.
        if (method === 'item/started' && FIRST_CLASS_ITEM_TYPES.has(item.type)) {
            return true;
        }
        if (item.type === 'userMessage') {
            return true;
        }

        if (method === 'item/started' && item.type === 'commandExecution') {
            if (typeof params?.threadId === 'string' && typeof params?.turnId === 'string') {
                this.commandTermination.observe(params.threadId, params.turnId, item, false);
            }
            const callId = typeof item.id === 'string' ? item.id : '';
            this.emitEvent({
                type: 'exec_command_begin',
                call_id: callId,
                callId,
                command: item.command,
                cwd: item.cwd,
                description: item.command,
            });
            return true;
        }

        if (method === 'item/completed' && item.type === 'commandExecution') {
            if (typeof params?.threadId === 'string' && typeof params?.turnId === 'string') {
                this.commandTermination.observe(params.threadId, params.turnId, item, true);
                const cleanup = this.commandCleanups.get(params.turnId);
                if (cleanup && !cleanup.operation) void this.finishCommandCleanup(cleanup);
            }
            const callId = typeof item.id === 'string' ? item.id : '';
            this.emitEvent({
                type: 'exec_command_end',
                call_id: callId,
                callId,
                output: item.aggregatedOutput ?? '',
                exit_code: item.exitCode ?? null,
                duration_ms: item.durationMs ?? null,
                status: item.status,
                cwd: item.cwd,
                command: item.command,
            });
            return true;
        }

        if (item.type === 'fileChange') {
            const callId = typeof item.id === 'string' ? item.id : '';
            const changes = normalizeRawFileChangeList(item.changes);

            if (callId && changes) {
                this.rawFileChangesByItemId.set(callId, changes);
            }

            if (method === 'item/started') {
                this.emitEvent({
                    type: 'patch_apply_begin',
                    call_id: callId,
                    callId,
                    changes: changes ?? {},
                });
                return true;
            }

            if (method === 'item/completed') {
                this.emitEvent({
                    type: 'patch_apply_end',
                    call_id: callId,
                    callId,
                    status: item.status,
                });

                if (callId && (item.status === 'completed' || item.status === 'failed' || item.status === 'declined')) {
                    this.rawFileChangesByItemId.delete(callId);
                }
                return true;
            }
        }

        if (method === 'item/completed' && item.type === 'agentMessage') {
            const text = typeof item.text === 'string' ? item.text : '';
            if (text.length > 0) {
                this.emitEvent({
                    type: 'agent_message',
                    message: text,
                    item_id: item.id,
                    phase: item.phase,
                    ...(item.delivery === 'async' ? { delivery: item.delivery, questions: item.questions } : {}),
                    thread_id: params?.threadId,
                    turn_id: params?.turnId,
                });
            }

            // A final answer item is content, not a lifecycle boundary. Codex
            // can still emit usage and other items before `turn/completed`.
            return true;
        }

        if (method === 'item/completed' && item.type === 'reasoning') {
            const summary = Array.isArray(item.summary) ? item.summary.filter((part: unknown): part is string => typeof part === 'string').join('\n\n') : '';
            this.emitEvent({ type: 'agent_reasoning', summary: true, text: summary, message: summary,
                item_id: item.id, thread_id: params.threadId, turn_id: params.turnId });
            return true;
        }

        if (method === 'item/completed' && item.type === 'imageGeneration') {
            const savedPath = typeof item.savedPath === 'string' ? item.savedPath : null;
            if (savedPath) {
                this.emitEvent({
                    type: 'generated_image',
                    path: savedPath,
                    item_id: item.id,
                    status: item.status,
                });
            }
            return true;
        }

        if (item.type === 'mcpToolCall') {
            const mcpItem = item as McpToolCallItem;
            const resourceUri = mcpItem.mcpAppUi?.resourceUri ?? mcpItem.appContext?.resourceUri ?? mcpItem.mcpAppResourceUri ?? null;
            const common = {
                call_id: mcpItem.id,
                callId: mcpItem.id,
                server: mcpItem.server,
                tool: mcpItem.tool,
                arguments: mcpItem.arguments,
                app_context: mcpItem.appContext,
                mcp_app_ui: mcpItem.mcpAppUi ?? null,
                resource_uri: resourceUri,
                plugin_id: mcpItem.pluginId,
                status: mcpItem.status,
            };

            if (method === 'item/started') {
                this.emitEvent({ type: 'mcp_tool_call_begin', ...common });
                return true;
            }

            if (method === 'item/completed') {
                this.emitEvent({
                    type: 'mcp_tool_call_end',
                    ...common,
                    result: mcpItem.result,
                    error: mcpItem.error,
                    duration_ms: mcpItem.durationMs,
                });
                return true;
            }
        }

        // Preserve every currently unsupported Codex item instead of silently
        // swallowing it. Consumers can progressively add first-class views
        // without losing protocol data in the bridge.
        if (method.startsWith('item/')) {
            this.emitEvent({
                type: 'codex_item',
                method,
                item,
                thread_id: params?.threadId,
                turn_id: params?.turnId,
            });
            return true;
        }

        return false;
    }

    // ─── Lifecycle ──────────────────────────────────────────────

    async connect(): Promise<void> {
        if (this.connected) return;

        // A long-lived session may predate an installed CLI update.
        this.executable = this.executableOverride ?? resolveCodexExecutable();

        const cliVersion = appServerVersion(this.executable);
        if (!cliVersion) {
            throw new Error(
                'Codex CLI is not installed\n\n' +
                'Please install Codex CLI using one of these methods:\n\n' +
                'Option 1 - npm (recommended):\n  npm install -g @openai/codex\n\n' +
                'Option 2 - Homebrew (macOS):\n  brew install --cask codex\n\n' +
                'Alternatively, use Claude Code:\n  hapla claude',
            );
        }

        this.cliVersion = cliVersion;
        this.adapter = codexProtocolAdapter(cliVersion);
        if (!this.adapter.verified) logger.warn(`[CodexAppServer] Unverified CLI ${cliVersion}; protocol snapshot is ${this.adapter.verifiedVersion}`);

        const appServerArgs = [...this.codexArgs, 'app-server', '--listen', 'stdio://'];
        let command = this.executable;
        let args = appServerArgs;
        this.sandboxEnabled = false;

        if (this.sandboxConfig?.enabled && process.platform !== 'win32') {
            try {
                this.sandboxCleanup = await initializeSandbox(this.sandboxConfig, process.cwd());
                const wrapped = await wrapForMcpTransport(this.executable, appServerArgs);
                command = wrapped.command;
                args = wrapped.args;
                this.sandboxEnabled = true;
                logger.info(`[CodexAppServer] Sandbox enabled`);
            } catch (error) {
                logger.warn('[CodexAppServer] Failed to initialize sandbox; continuing without.', error);
                this.sandboxCleanup = null;
            }
        }

        // Build env — same filtering as the old MCP client
        const env: Record<string, string> = {};
        for (const [key, value] of Object.entries(process.env)) {
            if (typeof value === 'string') env[key] = value;
        }
        // Mute noisy rollout list logging
        const filter = 'codex_core::rollout::list=off';
        if (!env.RUST_LOG) {
            env.RUST_LOG = filter;
        } else if (!env.RUST_LOG.includes('codex_core::rollout::list=')) {
            env.RUST_LOG += `,${filter}`;
        }
        if (this.sandboxEnabled) {
            env.CODEX_SANDBOX = 'seatbelt';
        }

        logger.debug(`[CodexAppServer] Spawning: ${command} ${args.join(' ')}`);

        const epoch = ++this.processEpoch;
        this.protocolEpoch = randomUUID();
        this.epochStartedAt = Math.max(Date.now(), this.epochStartedAt + 1);
        this.emitEvent({ type: 'codex_runtime_started', cliVersion, adapter: this.adapter.id, verified: this.adapter.verified });
        // Use cross-spawn so npm-installed wrappers (codex.cmd / codex.ps1) resolve on Windows.
        // Native child_process.spawn fails with ENOENT for .cmd shims (issues #980, #1016).
        const proc = crossSpawn(command, args, {
            stdio: ['pipe', 'pipe', 'pipe'],
            env,
            windowsHide: true,
        });
        this.process = proc;

        proc.on('error', (err) => {
            logger.debug('[CodexAppServer] Process error:', err);
        });

        proc.on('exit', (code, signal) => {
            logger.debug(`[CodexAppServer] Process exited: code=${code} signal=${signal}`);
            // Ignore stale process exits from prior generations during reconnect.
            if (this.process !== proc || this.processEpoch !== epoch) {
                logger.debug('[CodexAppServer] Ignoring stale process exit');
                return;
            }
            this.connected = false;
            // Reject all pending requests
            for (const [id, req] of this.pending) {
                if (req.epoch !== epoch) continue;
                req.reject(new Error(`Codex process exited (code=${code}) while waiting for ${req.method}`));
                this.pending.delete(id);
            }
            this.emitEvent({ type: 'codex_runtime_error', reason: 'processExited', message: `Codex process exited (code=${code})` });
            this.rejectPendingTurn(new Error('Codex runtime disconnected before confirming turn completion'));
        });

        // Pipe stderr for debug logging
        proc.stderr?.on('data', (chunk: Buffer) => {
            if (this.process !== proc || this.processEpoch !== epoch) return;
            const text = chunk.toString().trim();
            if (text) logger.debug(`[CodexAppServer:stderr] ${text}`);
        });

        // Parse newline-delimited JSON from stdout
        this.readline = createInterface({ input: proc.stdout! });
        this.readline.on('line', (line) => {
            if (this.process !== proc || this.processEpoch !== epoch) return;
            this.handleLine(line, epoch);
        });

        // Perform initialize handshake
        const initParams: InitializeParams = {
            clientInfo: {
                name: 'hapla-codex',
                title: 'Hapla Codex Client',
                version: packageJson.version,
            },
            capabilities: {
                // collaborationMode is experimental even for the default mode.
                // Opting into the API describes the fields this client uses;
                // snapshot verification separately tracks a reviewed contract.
                experimentalApi: true,
                requestAttestation: this.attestationHandler !== null,
                mcpServerOpenaiFormElicitation: this.adapter.verified && this.userInputHandler !== null,
            },
        };
        await this.request('initialize', initParams);
        this.notify('initialized');
        this.connected = true;
        // A completed handshake can accept the first prompt even before a thread
        // is loaded. Reconnect keeps its thread loading until resume supplies a snapshot.
        if (!this._threadId) this.emitEvent({ type: 'codex_thread_status', source: 'snapshot', status: { type: 'notLoaded' } });
        logger.debug('[CodexAppServer] Connected and initialized');
    }

    private async disconnectInternal(opts?: { preserveThreadState?: boolean; waitForExit?: boolean }): Promise<void> {
        if (!this.connected && !this.process) return;

        const proc = this.process;
        const pid = proc?.pid;
        const epoch = this.processEpoch;
        logger.debug(`[CodexAppServer] Disconnecting; pid=${pid ?? 'none'}`);

        // A cold resume must not race the previous process's rollout writer.
        const exited = opts?.waitForExit && proc && proc.exitCode == null && proc.signalCode == null
            ? new Promise<void>((resolve, reject) => {
                const onExit = () => { clearTimeout(timer); resolve(); };
                const timer = setTimeout(() => {
                    proc.removeListener('exit', onExit);
                    reject(new Error('Codex process did not exit before conversation recovery'));
                }, 5_000);
                proc.once('exit', onExit);
            }) : undefined;
        void exited?.catch(() => {});

        this.readline?.close();
        this.readline = null;

        try {
            proc?.stdin?.end();
            proc?.kill('SIGTERM');
        } catch { /* ignore */ }

        // Force kill after 2s (unref so timer doesn't block process exit)
        if (pid) {
            const killTimer = setTimeout(() => {
                try {
                    if (proc?.exitCode == null && proc?.signalCode == null) proc?.kill('SIGKILL');
                } catch { /* already dead */ }
            }, 2000);
            killTimer.unref();
            proc?.once('exit', () => clearTimeout(killTimer));
        }

        this.process = null;
        this.threadSelection += 1;
        this.connected = false;
        this._turnId = null;
        this.turnStartId = null;
        this.notificationProtocol = 'unknown';
        this.completedTurnIds.clear();
        this.locallyStartedTurnId = null;
        this.completedTurnStatus.clear();
        this.completedTurnErrors.clear();
        this.finalizedTurnIds.clear();
        this.commandTermination.clear();
        this.commandCleanups.clear();
        this.commandCleanupTimeouts.clear();
        this.rawFileChangesByItemId.clear();
        this.serverRequests.clear();
        this.interruptTarget = null;
        if (!opts?.preserveThreadState) {
            this._threadId = null;
            this.threadDefaults = null;
        }

        // Fail in-flight requests from this process generation.
        for (const [id, req] of this.pending) {
            if (req.epoch !== epoch) continue;
            req.reject(new Error(`Codex process disconnected while waiting for ${req.method}`));
            this.pending.delete(id);
        }

        this.rejectPendingTurn(new Error('Codex runtime disconnected before confirming turn completion'));

        if (this.sandboxCleanup) {
            try { await this.sandboxCleanup(); } catch { /* ignore */ }
            this.sandboxCleanup = null;
        }
        this.sandboxEnabled = false;

        await exited;

        logger.debug('[CodexAppServer] Disconnected');
    }

    async disconnect(): Promise<void> {
        await this.failureRecovery?.catch(() => {});
        await this.disconnectInternal();
    }

    private async restoreAfterServerError(failure: CodexTurnFailure): Promise<void> {
        const threadId = failure.threadId;
        const defaults = this.threadDefaults;
        const model = this.resolvedModel ?? defaults?.model;
        try {
            await this.disconnectInternal({ preserveThreadState: true, waitForExit: true });
            await this.connect();
            const resumed = await this.resumeThread({ threadId, model });
            if (resumed.threadId !== threadId) throw new Error('Codex resumed a different conversation');
            failure.recovery = 'restored';
        } catch (error) {
            // Keep the original history address even when recovery fails. Never
            // fall back to thread/start and silently create an empty conversation.
            await this.disconnectInternal({ preserveThreadState: true });
            this._threadId = threadId;
            this.threadDefaults = defaults;
            failure.recovery = 'failed';
            failure.recoveryError = error instanceof Error ? error.message : String(error);
            this.emitEvent({ type: 'codex_runtime_error', reason: 'serverErrorRecoveryFailed', message: failure.recoveryError });
            logger.warn('[CodexAppServer] Could not restore conversation after server error', error);
            throw error;
        }
    }

    /** Returns the model catalog advertised by the installed Codex app-server. */
    async listModels(): Promise<CodexModel[]> {
        const models: CodexModel[] = [];
        let cursor: string | null = null;

        do {
            const result = await this.request('model/list', {
                cursor,
                includeHidden: false,
            }) as ModelListResponse;
            models.push(...result.data);
            cursor = result.nextCursor ?? null;
        } while (cursor);

        for (const model of models) this.modelDefaultEfforts.set(model.model, model.defaultReasoningEffort);
        return models;
    }

    /** Returns skills visible to the installed Codex CLI for a workspace. */
    async listSkills(cwd: string = process.cwd(), forceReload = false): Promise<CodexSkill[]> {
        const result = await this.request('skills/list', {
            cwds: [cwd],
            forceReload,
        }) as SkillsListResponse;

        return result.data.flatMap((entry) => entry.skills);
    }

    async setSkillExtraRoots(extraRoots: string[]): Promise<void> {
        await this.request('skills/extraRoots/set', { extraRoots });
    }

    /** Enables or disables one Codex skill using the CLI's own config API. */
    async setSkillEnabled(skill: Pick<CodexSkill, 'name' | 'path'>, enabled: boolean): Promise<boolean> {
        const result = await this.request('skills/config/write', {
            enabled,
            name: skill.name,
            path: skill.path,
        }) as { effectiveEnabled: boolean };

        return result.effectiveEnabled;
    }

    /** Read an MCP Apps resource through the active Codex thread. */
    async readMcpResource(server: string, uri: string): Promise<McpResourceReadResponse> {
        return await this.request('mcpServer/resource/read', {
            threadId: this._threadId,
            server,
            uri,
        }) as McpResourceReadResponse;
    }

    /** Call an MCP tool as the UI host for an MCP App. */
    async callMcpTool(
        server: string,
        tool: string,
        args: unknown = {},
        meta?: unknown,
    ): Promise<McpServerToolCallResponse> {
        if (!this._threadId) {
            throw new Error('No active thread.');
        }
        return await this.request('mcpServer/tool/call', {
            threadId: this._threadId,
            server,
            tool,
            arguments: args,
            ...(meta !== undefined ? { _meta: meta } : {}),
        }, 120_000) as McpServerToolCallResponse;
    }

    private buildThreadConfig(mcpServers?: Record<string, unknown>): Record<string, unknown> | null {
        return mcpServers ? { mcp_servers: mcpServers } : null;
    }

    private rememberThreadDefaults(opts: {
        model?: string;
        cwd?: string;
        approvalPolicy?: ApprovalPolicy;
        sandbox?: SandboxMode;
        mcpServers?: Record<string, unknown>;
    }): void {
        this.threadDefaults = {
            model: opts.model,
            cwd: opts.cwd,
            approvalPolicy: opts.approvalPolicy,
            sandbox: opts.sandbox,
            mcpServers: opts.mcpServers,
        };
    }

    // ─── Thread management ──────────────────────────────────────

    async startThread(opts: {
        model?: string;
        cwd?: string;
        approvalPolicy?: ApprovalPolicy;
        sandbox?: SandboxMode;
        mcpServers?: Record<string, unknown>;
        verbosity?: 'low' | 'medium' | 'high' | null;
    }): Promise<{ threadId: string; model: string }> {
        if (this.commandCleanups.size) throw new Error('Finish native command interruption before switching Codex threads');
        const selection = ++this.threadSelection;
        const params: NewConversationParams = {
            model: opts.model ?? null,
            modelProvider: null,
            profile: null,
            cwd: opts.cwd ?? process.cwd(),
            approvalPolicy: opts.approvalPolicy ?? null,
            sandbox: opts.sandbox ?? null,
            config: opts.verbosity ? { ...this.buildThreadConfig(opts.mcpServers), model_verbosity: opts.verbosity } : this.buildThreadConfig(opts.mcpServers),
            baseInstructions: null,
            developerInstructions: null,
            compactPrompt: null,
            includeApplyPatchTool: null,
            // v2 item notifications are the canonical bridge. Enabling the
            // experimental legacy event stream causes duplicate notifications
            // and can mask v2 agent messages when it arrives first.
            experimentalRawEvents: false,
            persistExtendedHistory: true,
        };

        const result = await this.request('thread/start', params) as NewConversationResponse;
        if (selection !== this.threadSelection) throw new Error('Ignoring stale Codex thread/start response');
        this.resolvedModel = result.model;
        this.snapshotConfiguration(result);
        if (this.defaultEffortModel === null) this.defaultEffortModel = result.model;
        if (this.defaultEffort === null && 'reasoningEffort' in result && typeof result.reasoningEffort === 'string') this.defaultEffort = result.reasoningEffort;
        this._threadId = result.thread.id;
        this.checkpointHasHistory = false;
        this._turnId = null;
        this.appliedVerbosity = opts.verbosity;
        this.applyThreadSnapshot(result.thread);
        this.rememberThreadDefaults(opts);
        logger.debug('[CodexAppServer] Thread started:', this._threadId);
        return { threadId: result.thread.id, model: result.model };
    }

    async resumeThread(opts?: {
        threadId?: string;
        model?: string;
        cwd?: string;
        approvalPolicy?: ApprovalPolicy;
        sandbox?: SandboxMode;
        mcpServers?: Record<string, unknown>;
    }): Promise<{ threadId: string; model: string }> {
        if (this.commandCleanups.size) throw new Error('Finish native command interruption before switching Codex threads');
        const threadId = opts?.threadId ?? this._threadId;
        if (!threadId) {
            throw new Error('No thread available to resume.');
        }

        const selection = ++this.threadSelection;

        const defaults = this.threadDefaults ?? {};
        const params: ResumeConversationParams = {
            threadId,
            model: opts?.model ?? defaults.model ?? null,
            modelProvider: null,
            cwd: opts?.cwd ?? defaults.cwd ?? process.cwd(),
            approvalPolicy: opts?.approvalPolicy ?? defaults.approvalPolicy ?? null,
            sandbox: opts?.sandbox ?? defaults.sandbox ?? null,
            config: this.buildThreadConfig(opts?.mcpServers ?? defaults.mcpServers),
            baseInstructions: null,
            developerInstructions: null,
            persistExtendedHistory: true,
        };

        const result = await this.request('thread/resume', params) as ResumeConversationResponse;
        if (selection !== this.threadSelection) throw new Error('Ignoring stale Codex thread/resume response');
        this.resolvedModel = result.model;
        this.snapshotConfiguration(result);
        if (this.defaultEffortModel === null) this.defaultEffortModel = result.model;
        this.appliedVerbosity = undefined;
        if (this.defaultEffort === null && 'reasoningEffort' in result && typeof result.reasoningEffort === 'string') this.defaultEffort = result.reasoningEffort;
        this._threadId = result.thread.id;
        this.checkpointHasHistory = true;
        this._turnId = null;
        this.applyThreadSnapshot(result.thread);
        this.rememberThreadDefaults({
            model: opts?.model ?? defaults.model,
            cwd: opts?.cwd ?? defaults.cwd,
            approvalPolicy: opts?.approvalPolicy ?? defaults.approvalPolicy,
            sandbox: opts?.sandbox ?? defaults.sandbox,
            mcpServers: opts?.mcpServers ?? defaults.mcpServers,
        });
        logger.debug('[CodexAppServer] Thread resumed:', this._threadId);
        return { threadId: result.thread.id, model: result.model };
    }

    /** Fork the active Codex thread and make the returned branch active. */
    async forkThread(opts?: {
        sourceThreadId?: string;
        deferGoalContinuation?: boolean;
        lastTurnId?: string;
        model?: string;
        cwd?: string;
    }): Promise<{ threadId: string; model: string; forkedFromId: string }> {
        if (this.commandCleanups.size) throw new Error('Finish native command interruption before switching Codex threads');
        const sourceThreadId = opts?.sourceThreadId ?? this._threadId;
        if (!sourceThreadId) throw new Error('No active thread is available to fork.');
        const selection = ++this.threadSelection;
        const defaults = this.threadDefaults ?? {};
        const result = await this.request('thread/fork', {
            threadId: sourceThreadId,
            ...(opts?.deferGoalContinuation ? { deferGoalContinuation: true } : {}),
            lastTurnId: opts?.lastTurnId ?? null,
            model: opts?.model ?? defaults.model ?? null,
            cwd: opts?.cwd ?? defaults.cwd ?? process.cwd(),
            approvalPolicy: defaults.approvalPolicy ?? null,
            sandbox: defaults.sandbox ?? null,
            config: this.buildThreadConfig(defaults.mcpServers),
            persistExtendedHistory: true,
        }) as import('./codexAppServerTypes').ThreadForkResponse;
        if (selection !== this.threadSelection) throw new Error('Ignoring stale Codex thread/fork response');
        this.resolvedModel = result.model;
        this.snapshotConfiguration(result);
        if (this.defaultEffortModel === null) this.defaultEffortModel = result.model;
        this.appliedVerbosity = undefined;
        if (this.defaultEffort === null && 'reasoningEffort' in result && typeof result.reasoningEffort === 'string') this.defaultEffort = result.reasoningEffort;
        this._threadId = result.thread.id;
        this.checkpointHasHistory = true;
        this._turnId = null;
        this.applyThreadSnapshot(result.thread);
        this.rememberThreadDefaults({ ...defaults, model: opts?.model ?? defaults.model, cwd: opts?.cwd ?? defaults.cwd });
        return { threadId: result.thread.id, model: result.model, forkedFromId: sourceThreadId };
    }

    /** Start an empty sibling branch while retaining the current thread as its parent. */
    async startSiblingThread(opts?: {
        model?: string;
        cwd?: string;
    }): Promise<{ threadId: string; model: string; forkedFromId: string }> {
        const sourceThreadId = this._threadId;
        if (!sourceThreadId) throw new Error('No active thread is available to branch from.');
        const defaults = this.threadDefaults ?? {};
        const started = await this.startThread({
            model: opts?.model ?? defaults.model,
            cwd: opts?.cwd ?? defaults.cwd,
            approvalPolicy: defaults.approvalPolicy,
            sandbox: defaults.sandbox,
            mcpServers: defaults.mcpServers,
        });
        return { ...started, forkedFromId: sourceThreadId };
    }

    async readThreadTurns(threadId: string = this._threadId ?? ''): Promise<any[]> {
        if (!threadId) throw new Error('No thread is available to read.');
        const result = await this.requestRaw<any>('thread/read', { threadId, includeTurns: true });
        return Array.isArray(result?.thread?.turns) ? result.thread.turns : [];
    }

    async reconnectAndResumeThread(): Promise<boolean> {
        const threadId = this._threadId;
        await this.disconnectInternal({ preserveThreadState: !!threadId });
        await this.connect();

        if (!threadId) {
            return false;
        }

        try {
            await this.resumeThread({ threadId });
            return true;
        } catch (error) {
            logger.warn('[CodexAppServer] Failed to resume thread after reconnect', error);
            this._threadId = null;
            this.threadDefaults = null;
            return false;
        }
    }

    // ─── Turn management ────────────────────────────────────────

    /** Grace period before querying authoritative thread state (ms). */
    private static readonly ABORT_GRACE_MS = 3_000;

    private resolvePendingTurn(aborted: boolean): void {
        if (!this.pendingTurnCompletion) return;
        this.pendingTurnCompletion.resolve(aborted);
        this.pendingTurnCompletion = null;
    }

    private rejectPendingTurn(error: Error): void {
        this.settleTurnIdleWaiters(error);
        if (!this.pendingTurnCompletion) return;
        this.pendingTurnCompletion.reject(error);
        this.pendingTurnCompletion = null;
    }

    private markPendingTurnStarted(turnId?: string | null): void {
        if (!this.pendingTurnCompletion) return;
        if (turnId) {
            this.pendingTurnCompletion.turnId = turnId;
        }
    }

    private tryResolvePendingTurn(aborted: boolean, turnId: string | null, source: string): void {
        const pending = this.pendingTurnCompletion;
        if (!pending) return;

        // Guard against stale completion notifications from a *different* turn.
        // We use turn ID matching instead of the `started` flag because Codex
        // can skip the turn/started notification entirely for fast turns,
        // which would cause us to discard a valid turn/completed and hang forever.
        if (pending.turnId && turnId && pending.turnId !== turnId) {
            logger.debug(
                `[CodexAppServer] Ignoring ${source} for turn ${turnId}; awaiting ${pending.turnId}`,
            );
            return;
        }

        this.resolvePendingTurn(aborted);
    }

    private async waitForTurnCompletion(turnId: string, timeoutMs: number): Promise<boolean> {
        const deadline = Date.now() + Math.max(0, timeoutMs);
        while (!this.finalizedTurnIds.has(turnId)) {
            if (Date.now() >= deadline) return false;
            await new Promise((resolve) => setTimeout(resolve, 25));
        }
        return true;
    }

    /** An RPC acknowledgement never proves interruption; only the exact turn's terminal status does. */
    abortTurnWithFallback(opts?: {
        gracePeriodMs?: number;
        forceRestartOnTimeout?: boolean;
        expectedStartId?: string;
        expectedTurnId?: string;
        commandCleanupTimeoutMs?: number;
    }): Promise<{ hadActiveTurn: boolean; aborted: boolean; forcedRestart: boolean; resumedThread: boolean }> {
        if (this.abortOperation) return this.abortOperation;
        const operation = this.performAbort(opts);
        this.abortOperation = operation;
        void operation.finally(() => {
            if (this.abortOperation === operation) this.abortOperation = null;
        }).catch(() => {});
        return operation;
    }

    private async performAbort(opts?: {
        gracePeriodMs?: number; forceRestartOnTimeout?: boolean; expectedStartId?: string; expectedTurnId?: string; commandCleanupTimeoutMs?: number;
    }) {
        if ((opts?.expectedStartId && opts.expectedStartId !== this.turnStartId)
            || (opts?.expectedTurnId && opts.expectedTurnId !== this._turnId)) {
            return { hadActiveTurn: false, aborted: false, forcedRestart: false, resumedThread: false };
        }
        // A stop may arrive while turn/start is still awaiting its response.
        const startId = this.turnStartId;
        const initialTurnId = this._turnId;
        const threadId = this._threadId;
        const epoch = this.processEpoch;
        while (this.startingTurn && !this._turnId && this.turnStartId === startId && this.processEpoch === epoch) {
            await new Promise((resolve) => setTimeout(resolve, 10));
        }
        const turnId = this.processEpoch === epoch && this._threadId === threadId
            && (initialTurnId ? this._turnId === initialTurnId : this.turnStartId === startId) ? this._turnId : null;
        if (!turnId || !threadId) {
            return { hadActiveTurn: false, aborted: false, forcedRestart: false, resumedThread: false };
        }
        const result = (forcedRestart = false, resumedThread = false) => ({
            hadActiveTurn: true,
            aborted: this.finalizedTurnIds.has(turnId) && this.completedTurnStatus.get(turnId) === 'interrupted',
            forcedRestart, resumedThread,
        });
        this.commandCleanupTimeouts.set(turnId, opts?.commandCleanupTimeoutMs ?? 10_000);
        const existingCleanup = this.commandCleanups.get(turnId);
        if (existingCleanup) {
            await this.finishCommandCleanup(existingCleanup);
            return result();
        }
        // Snapshot only the native commands already attributed to this turn.
        // This also distinguishes actual disappearance from an empty/incomplete view.
        try {
            await this.commandTermination.capture(threadId, turnId, this.commandTransport(threadId, epoch));
        } catch (error) {
            logger.debug('[CodexAppServer] Could not capture command presence before interruption', error);
        }
        try {
            await this.interruptTurn();
        } catch (error) {
            logger.warn('[CodexAppServer] Interrupt RPC failed; checking authoritative state', error);
        }
        const gracePeriodMs = opts?.gracePeriodMs ?? CodexAppServerClient.ABORT_GRACE_MS;
        if (await this.waitForTurnCompletion(turnId, gracePeriodMs)) return result();
        const pendingCleanup = this.commandCleanups.get(turnId);
        if (pendingCleanup) {
            if (pendingCleanup.operation) await pendingCleanup.operation;
            return result();
        }

        // Reconcile a lost terminal notification before any recovery action.
        try {
            const read = await this.request('thread/read', { threadId, includeTurns: true }, 2_000) as {
                thread?: { turns?: Array<{ id: string; status: string; error?: unknown }> };
            };
            const turn = read?.thread?.turns?.find((candidate) => candidate.id === turnId);
            if (epoch === this.processEpoch && this._threadId === threadId && this._turnId === turnId
                && turn && ['completed', 'interrupted', 'failed'].includes(turn.status)) {
                this.emitRawTurnCompletion(turnId, turn.status, turn.error, 'thread/read');
            }
        } catch (error) {
            logger.debug('[CodexAppServer] Interrupt state reconciliation failed', error);
        }
        const reconciledCleanup = this.commandCleanups.get(turnId);
        if (reconciledCleanup?.operation) await reconciledCleanup.operation;
        if (this.completedTurnStatus.has(turnId)) return result();
        if (epoch !== this.processEpoch || this._threadId !== threadId || this._turnId !== turnId) return result();

        this.interruptTarget = null; // An unconfirmed request may be retried explicitly.
        this.emitEvent({ type: 'codex_interrupt', status: 'failed', thread_id: threadId, turn_id: turnId });
        if (opts?.forceRestartOnTimeout !== true) return result();

        this.emitEvent({ type: 'codex_runtime_error', reason: 'interruptUnconfirmed', forced_restart: true,
            thread_id: threadId, turn_id: turnId, message: 'Restarting this session runtime without a confirmed interrupt result' });
        const resumedThread = await this.reconnectAndResumeThread();
        return { hadActiveTurn: true, aborted: false, forcedRestart: true, resumedThread };
    }

    /**
     * Send a user turn and wait for it to complete.
     * Returns when task_complete or turn_aborted is received.
     */
    async sendTurnContent(input: InputItem[], opts?: {
        model?: string | null;
        cwd?: string;
        approvalPolicy?: ApprovalPolicy;
        sandbox?: SandboxMode;
        networkAccess?: boolean;
        effort?: ReasoningEffort | null;
        verbosity?: 'low' | 'medium' | 'high' | null;
        serviceTier?: string | null;
        collaborationMode?: 'default' | 'plan';
    }): Promise<void> {
        if (this.failureRecovery) await this.failureRecovery;
        if (this.abortOperation) await this.abortOperation;
        if (this._turnId && this._turnId !== this.locallyStartedTurnId && !this.pendingTurnCompletion && !this.startingTurn) await this.waitForTurnIdle();
        if (!this._threadId) {
            throw new Error('No active thread. Call startThread first.');
        }

        // Build params — only include optional fields when set (server uses thread defaults otherwise)
        const params: Record<string, unknown> = {
            threadId: this._threadId,
            input,
        };
        if (opts?.cwd) params.cwd = opts.cwd;
        if (opts?.approvalPolicy) params.approvalPolicy = opts.approvalPolicy;
        let selectedModel = opts?.model ?? this.resolvedModel;
        if (opts?.model === null) {
            const defaults = await this.configuredDefaults();
            selectedModel = defaults.model ?? (await this.listModels()).find(model => model.isDefault)?.model ?? null;
            if (!selectedModel) throw new Error('原生 CLI 没有返回默认模型，请选择明确的模型');
        }
        if (opts?.model !== undefined && selectedModel) params.model = selectedModel;
        const baselineEffort = selectedModel && selectedModel !== this.defaultEffortModel
            ? this.modelDefaultEfforts.get(selectedModel) ?? null : this.defaultEffort;
        if (opts?.effort !== undefined) params.effort = opts.effort ?? (await this.configuredDefaults()).model_reasoning_effort ?? baselineEffort;
        if (opts?.serviceTier !== undefined) params.serviceTier = opts.serviceTier;
        if (opts?.collaborationMode && selectedModel) {
            params.collaborationMode = { mode: opts.collaborationMode, settings: {
                model: selectedModel,
                reasoning_effort: params.effort ?? (opts?.model !== undefined ? baselineEffort : this.effective.effort) ?? baselineEffort,
                developer_instructions: null,
            } };
        }
        // Verbosity is a thread configuration override, not a turn/start field.
        // Resume the same thread while idle; never write the user's config.toml.
        if (opts?.verbosity !== undefined && opts.verbosity !== this.appliedVerbosity) {
            if (opts.verbosity !== null || this.appliedVerbosity != null) {
                if (this.defaultVerbosity === undefined) {
                    const config = await this.request('config/read', { includeLayers: false, cwd: this.threadDefaults?.cwd ?? process.cwd() }) as { config?: { model_verbosity?: unknown } };
                    this.defaultVerbosity = config.config?.model_verbosity ?? null;
                }
                if (this._turnId || this.startingTurn) throw new Error('Wait for the current turn before changing output detail');
                await this.request('thread/resume', {
                    threadId: this._threadId,
                    config: { ...this.buildThreadConfig(this.threadDefaults?.mcpServers), model_verbosity: opts.verbosity ?? this.defaultVerbosity },
                    persistExtendedHistory: true,
                });
            }
            this.appliedVerbosity = opts.verbosity;
        }

        // Map sandbox mode to the camelCase policy format the server expects
        if (opts?.sandbox) {
            switch (opts.sandbox) {
                case 'workspace-write':
                    params.sandboxPolicy = {
                        type: 'workspaceWrite',
                        writableRoots: [],
                        networkAccess: opts.networkAccess === true,
                        excludeTmpdirEnvVar: false,
                        excludeSlashTmp: false,
                    };
                    break;
                case 'danger-full-access':
                    params.sandboxPolicy = { type: 'dangerFullAccess' };
                    break;
                case 'read-only':
                    params.sandboxPolicy = { type: 'readOnly' };
                    break;
            }
        }

        if (this._turnId || this.startingTurn) throw new Error('A Codex turn is still active; wait for its authoritative completion.');
        this.startingTurn = true;
        const startId = randomUUID();
        this.turnStartId = startId;
        this.emitEvent({ type: 'codex_turn_starting', startId, thread_id: this._threadId });
        try {
            this.checkpointHasHistory = true;
            const result = await this.request('turn/start', params) as { turn?: { id?: string | null } };
            if (this._threadId !== params.threadId) throw new Error('Ignoring a turn/start response for a previous thread');
            if (selectedModel) this.resolvedModel = selectedModel;
            this.publishConfiguration({ ...this.effective, model: selectedModel,
                ...(opts?.effort !== undefined ? { effort: params.effort as ReasoningEffort | null } : selectedModel !== this.effective.model ? { effort: null } : {}),
                ...(opts?.sandbox ? { permissionMode: opts.sandbox === 'read-only' ? 'read-only' : opts.sandbox === 'danger-full-access' ? 'yolo' : opts.approvalPolicy === 'on-request' ? 'safe-yolo' : 'default' } as const : {}),
                ...(opts?.serviceTier !== undefined ? { serviceTier: opts.serviceTier } : {}),
                ...(opts?.collaborationMode !== undefined ? { collaborationMode: opts.collaborationMode } : {}),
                ...(opts?.verbosity !== undefined ? { verbosity: opts.verbosity } : {}),
                threadId: this._threadId!, turnId: typeof result.turn?.id === 'string' ? result.turn.id : undefined,
            });
            const turnId = result?.turn?.id;
            if (typeof turnId === 'string' && turnId.length > 0 && !this.completedTurnIds.has(turnId)) {
                const alreadyStarted = this._turnId === turnId;
                this.locallyStartedTurnId = turnId;
                this._turnId = turnId;
                this.markPendingTurnStarted(turnId);
                if (!alreadyStarted) this.emitEvent({ type: 'task_started', turn_id: turnId, thread_id: this._threadId });
                this.startingTurn = false;
                const completedStatus = this.completedTurnStatus.get(turnId);
                if (completedStatus) this.emitRawTurnCompletion(turnId, completedStatus, this.completedTurnErrors.get(turnId), 'turn/start');
            }
        } catch (error) {
            if (this.turnStartId === startId) {
                this.emitEvent({ type: 'codex_turn_start_failed', startId, thread_id: params.threadId,
                    message: error instanceof Error ? error.message : String(error) });
                this.turnStartId = null;
            }
            throw error;
        } finally {
            this.startingTurn = false;
            this.settleTurnIdleWaiters();
        }
    }

    async sendTurn(prompt: string, opts?: {
        model?: string | null;
        cwd?: string;
        approvalPolicy?: ApprovalPolicy;
        sandbox?: SandboxMode;
        networkAccess?: boolean;
        effort?: ReasoningEffort | null;
        verbosity?: 'low' | 'medium' | 'high' | null;
        serviceTier?: string | null;
        collaborationMode?: 'default' | 'plan';
    }): Promise<void> {
        return this.sendTurnContent([
            { type: 'text', text: prompt },
        ], opts);
    }

    /** Append user input to the currently running turn using the active-turn precondition. */
    async steerTurnContent(input: InputItem[], clientUserMessageId?: string): Promise<{ turnId: string }> {
        if (!this._threadId || !this._turnId) {
            throw new Error('No active Codex turn is available to steer.');
        }
        const result = await this.request('turn/steer', {
            threadId: this._threadId,
            input,
            expectedTurnId: this._turnId,
            clientUserMessageId: clientUserMessageId ?? null,
            responsesapiClientMetadata: null,
            additionalContext: null,
        }) as { turnId: string };
        return result;
    }

    async steerTurn(prompt: string, clientUserMessageId?: string): Promise<{ turnId: string }> {
        return this.steerTurnContent([{ type: 'text', text: prompt }], clientUserMessageId);
    }

    async sendTurnAndWait(prompt: string, opts?: {
        model?: string | null; cwd?: string; approvalPolicy?: ApprovalPolicy; sandbox?: SandboxMode;
        networkAccess?: boolean; effort?: ReasoningEffort | null; turnTimeoutMs?: number;
        verbosity?: 'low' | 'medium' | 'high' | null; serviceTier?: string | null; collaborationMode?: 'default' | 'plan';
    }): Promise<{ aborted: boolean }> {
        return this.sendTurnContentAndWait([{ type: 'text', text: prompt }], opts);
    }

    async sendTurnContentAndWait(input: InputItem[], opts?: {
        model?: string | null; cwd?: string; approvalPolicy?: ApprovalPolicy; sandbox?: SandboxMode;
        networkAccess?: boolean; effort?: ReasoningEffort | null; turnTimeoutMs?: number;
        verbosity?: 'low' | 'medium' | 'high' | null; serviceTier?: string | null; collaborationMode?: 'default' | 'plan';
    }): Promise<{ aborted: boolean }> {
        if (this.failureRecovery) await this.failureRecovery;
        if (this.abortOperation) await this.abortOperation;
        if (this.pendingInterrupt) await this.pendingInterrupt;
        if (this._turnId && this._turnId !== this.locallyStartedTurnId && !this.pendingTurnCompletion && !this.startingTurn) await this.waitForTurnIdle();
        if (this.pendingTurnCompletion || this._turnId || this.startingTurn) {
            throw new Error('A Codex turn is still active; wait for its authoritative completion.');
        }
        let timer: ReturnType<typeof setTimeout> | undefined;
        const completion = new Promise<boolean>((resolve, reject) => {
            this.pendingTurnCompletion = { resolve, reject, turnId: null };
        });
        // Install a handler immediately: disconnect or timeout can precede the start RPC response.
        void completion.catch(() => {});
        // Long reasoning/compaction has no arbitrary product timeout. An explicit
        // caller timeout fails the wait while retaining the active provider turn.
        if (opts?.turnTimeoutMs !== undefined) {
            timer = setTimeout(() => {
                const error = new Error(`Codex turn completion was not confirmed within ${opts.turnTimeoutMs}ms`);
                this.emitEvent({ type: 'codex_runtime_error', reason: 'completionUnconfirmed', message: error.message });
                this.rejectPendingTurn(error);
            }, opts.turnTimeoutMs);
        }
        try {
            await this.sendTurnContent(input, opts);
            return { aborted: await completion };
        } catch (error) {
            this.pendingTurnCompletion = null;
            // A terminal failure already confirmed the turn's end. Its wait
            // timeout must not later mark the replacement runtime as unconfirmed.
            if (timer) { clearTimeout(timer); timer = undefined; }
            if (error instanceof CodexTurnFailure && error.isServerError
                && error.processEpoch === this.processEpoch && error.threadId === this._threadId
                && !this._turnId && !this.startingTurn && !this.commandCleanups.size) {
                // Restore once after an authoritative failure. The failed input
                // stays in its saved history; no tools or prompt are replayed.
                const recovery = this.restoreAfterServerError(error);
                this.failureRecovery = recovery;
                try { await recovery; } catch { /* Preserve the original provider error. */ }
                finally { if (this.failureRecovery === recovery) this.failureRecovery = null; }
            }
            throw error;
        } finally {
            if (timer) clearTimeout(timer);
        }
    }

    async interruptTurn(): Promise<void> {
        if (this.pendingInterrupt) return this.pendingInterrupt;
        if (!this._threadId || !this._turnId) return;
        const params: InterruptConversationParams = { threadId: this._threadId, turnId: this._turnId };
        const target = `${this.processEpoch}:${params.threadId}:${params.turnId}`;
        if (this.interruptTarget === target) return;
        this.interruptTarget = target;
        this.emitEvent({ type: 'codex_interrupt', status: 'requested', thread_id: params.threadId, turn_id: params.turnId });
        const epoch = this.processEpoch;
        const operation = this.request('turn/interrupt', params).then(() => {
            if (this.processEpoch === epoch && this._turnId === params.turnId) {
                this.emitEvent({ type: 'codex_interrupt', status: 'acknowledged', thread_id: params.threadId, turn_id: params.turnId });
            }
        }).catch((error) => {
            if (this.processEpoch === epoch && this._turnId === params.turnId) {
                this.interruptTarget = null;
                this.emitEvent({ type: 'codex_interrupt', status: 'failed', thread_id: params.threadId, turn_id: params.turnId });
            }
            throw error;
        });
        this.pendingInterrupt = operation;
        try { await operation; } finally {
            if (this.pendingInterrupt === operation) this.pendingInterrupt = null;
        }
    }

    // ─── State queries ──────────────────────────────────────────

    hasActiveThread(): boolean {
        return this._threadId !== null;
    }

    // ─── JSON-RPC transport ─────────────────────────────────────

    /** Default timeout for RPC requests (ms). */
    private static readonly REQUEST_TIMEOUT_MS = 30_000;

    /**
     * Send any current or future Codex app-server request without waiting for a
     * Hapla release to add a convenience wrapper. The transport remains fully
     * JSON-RPC compatible while first-class product methods stay typed above.
     */
    requestRaw<T = unknown>(method: string, params?: unknown, timeoutMs?: number): Promise<T> {
        const timeout = timeoutMs ?? CodexAppServerClient.REQUEST_TIMEOUT_MS;
        return new Promise<T>((resolve, reject) => {
            if (!this.process?.stdin?.writable) {
                reject(new Error(`Cannot send ${method}: stdin not writable`));
                return;
            }
            const id = this.nextId++;

            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error(`${method} timed out after ${timeout}ms (id=${id})`));
            }, timeout);

            this.pending.set(id, {
                resolve: (result) => { clearTimeout(timer); resolve(result as T); },
                reject: (err) => { clearTimeout(timer); reject(err); },
                method,
                epoch: this.processEpoch,
                context: codexEventCorrelation(params),
            });

            const msg: JsonRpcRequest = { jsonrpc: '2.0', id, method, params };
            const line = JSON.stringify(msg) + '\n';
            logger.debug(`[CodexAppServer] → ${method} (id=${id})`);
            this.recordRaw(msg, 'outgoing');
            this.process.stdin.write(line);
        });
    }

    /** Send any Codex client notification over the negotiated JSON-RPC stream. */
    notifyRaw(method: string, params?: unknown): void {
        if (!this.process?.stdin?.writable) return;
        const msg: JsonRpcRequest = { jsonrpc: '2.0', method, params };
        this.recordRaw(msg, 'outgoing');
        this.process.stdin.write(JSON.stringify(msg) + '\n');
        logger.debug(`[CodexAppServer] → ${method} (notification)`);
    }

    private request(method: string, params?: unknown, timeoutMs?: number): Promise<unknown> {
        return this.requestRaw(method, params, timeoutMs);
    }

    private notify(method: string, params?: unknown): void {
        this.notifyRaw(method, params);
    }

    private respond(id: string | number, result: unknown): void {
        if (!this.process?.stdin?.writable) return;
        const msg: JsonRpcResponse = { jsonrpc: '2.0', id, result };
        this.recordRaw(msg, 'outgoing');
        this.process.stdin.write(JSON.stringify(msg) + '\n');
        logger.debug(`[CodexAppServer] → response (id=${id})`);
    }

    private respondError(id: string | number, code: number, message: string): void {
        if (!this.process?.stdin?.writable) return;
        const response = {
            jsonrpc: '2.0' as const,
            id,
            error: { code, message },
        };
        this.recordRaw(response, 'outgoing');
        this.process.stdin.write(JSON.stringify(response) + '\n');
        logger.debug(`[CodexAppServer] → error response (id=${id}, code=${code})`);
    }

    private handleLine(line: string, sourceEpoch: number = this.processEpoch): void {
        if (sourceEpoch !== this.processEpoch) {
            return;
        }
        if (!line.trim()) return;

        let msg: any;
        try {
            msg = JSON.parse(line);
        } catch {
            logger.debug('[CodexAppServer] Non-JSON line:', line.substring(0, 200));
            return;
        }

        this.recordRaw(msg, 'incoming');

        // Response to our request
        if (msg.id != null && (msg.result !== undefined || msg.error !== undefined)) {
            const pending = this.pending.get(msg.id);
            if (pending) {
                if (pending.epoch !== sourceEpoch) {
                    logger.debug(`[CodexAppServer] Ignoring response from stale epoch for id=${msg.id}`);
                    return;
                }
                this.pending.delete(msg.id);
                if (msg.error) {
                    pending.reject(new Error(`${pending.method}: ${msg.error.message} (code=${msg.error.code})`));
                } else {
                    pending.resolve(msg.result);
                }
            }
            return;
        }

        // Server → client request (approvals)
        if (msg.id != null && msg.method) {
            this.handleServerRequest(msg.id, msg.method, msg.params, sourceEpoch).catch((err) => {
                logger.debug('[CodexAppServer] Error handling server request:', err);
            });
            return;
        }

        // Notification (no id)
        if (msg.method) {
            this.notificationContext = codexEventCorrelation(msg.params);
            try { this.handleNotification(msg.method, msg.params); }
            finally { this.notificationContext = null; }
            return;
        }

        logger.debug('[CodexAppServer] Unhandled message:', JSON.stringify(msg).substring(0, 300));
    }

    /**
     * Map our internal ReviewDecision to the wire format the server expects.
     * Server uses: accept, acceptForSession, decline, cancel
     * Our handler uses: approved, approved_for_session, denied, abort
     */
    /**
     * Map our internal ReviewDecision to the wire format codex expects.
     * v2 methods (item/*) use: accept/acceptForSession/decline/cancel
     * Legacy methods (execCommandApproval/applyPatchApproval) use: approved/approved_for_session/denied/abort
     */
    private mapDecisionToWire(decision: ReviewDecision, legacy: boolean): string | Record<string, unknown> {
        if (typeof decision === 'string') {
            if (legacy) {
                // Legacy wire format — pass through as-is (approved/denied/abort)
                return decision;
            }
            // v2 wire format
            switch (decision) {
                case 'approved': return 'accept';
                case 'approved_for_session': return 'acceptForSession';
                case 'denied': return 'decline';
                case 'abort': return 'cancel';
                default: return 'decline';
            }
        }
        // Object variant: approved_execpolicy_amendment → pass through as-is
        if ('approved_execpolicy_amendment' in decision) {
            return decision;
        }
        return legacy ? 'denied' : 'decline';
    }

    private parseToolNameFromElicitationMessage(message: unknown): string | null {
        if (typeof message !== 'string') {
            return null;
        }
        const match = message.match(/tool "([^"]+)"/i);
        return match?.[1] ?? null;
    }

    private mapDecisionToMcpElicitationResponse(
        decision: ReviewDecision,
        params: any,
    ): McpServerElicitationRequestResponse {
        if (typeof decision === 'string') {
            switch (decision) {
                case 'approved':
                case 'approved_for_session':
                    return {
                        action: 'accept',
                        content: params?.mode === 'form' ? {} : null,
                        _meta: null,
                    };
                case 'abort':
                    return {
                        action: 'cancel',
                        content: null,
                        _meta: null,
                    };
                case 'denied':
                default:
                    return {
                        action: 'decline',
                        content: null,
                        _meta: null,
                    };
            }
        }

        return {
            action: 'decline',
            content: null,
            _meta: null,
        };
    }

    private async handleServerRequest(id: string | number, method: string, params: any, sourceEpoch: number): Promise<void> {
        const context = { ...codexEventCorrelation(params), requestId: id };
        const requestProtocol: CodexServerRequestContext = { epoch: this.protocolEpoch, ...context };
        if (context.turnId && this.completedTurnIds.has(context.turnId)) {
            this.respondError(id, -32600, 'Request targets a completed Codex turn');
            return;
        }
        if (context.threadId && this._threadId && context.threadId !== this._threadId) return;
        if (context.turnId && this._turnId && context.turnId !== this._turnId) return;
        if (this.serverRequests.has(id)) return;
        if (method === 'mcpServer/elicitation/request' && params?.mode === 'openai/userVerification') {
            // No user-verification extension is advertised during initialize.
            // A verification challenge must never become a generic approval.
            this.respondError(id, -32601, 'Hapla does not support openai/userVerification requests.');
            logger.warn('[CodexAppServer] Declined unsupported user verification request.');
            return;
        }
        const kind = (method === 'item/tool/requestUserInput' || method === 'tool/requestUserInput') ? 'userInput'
            : method === 'mcpServer/elicitation/request' ? 'elicitation'
            : (method.endsWith('/requestApproval') || method.endsWith('Approval') ? 'approval' : null);
        const tracked = kind ? { context, kind: kind as 'approval' | 'userInput' | 'elicitation' } : null;
        const nativeCommandApproval = method === 'item/commandExecution/requestApproval'
            && context.threadId && context.turnId && context.itemId;
        if (nativeCommandApproval) this.commandTermination.observeApproval(context.threadId!, context.turnId!, context.itemId!, 'pending');
        if (tracked) {
            this.serverRequests.set(id, tracked);
            this.emitEvent({ type: 'codex_request', status: 'pending', kind, ...context });
        }
        const stillCurrent = () => this.process !== null && sourceEpoch === this.processEpoch
            && (!context.threadId || !this._threadId || context.threadId === this._threadId)
            && (!context.turnId || !this._turnId || context.turnId === this._turnId)
            && (!context.turnId || !this.completedTurnIds.has(context.turnId))
            && (!tracked || this.serverRequests.get(id) === tracked);
        const withContext = (action: () => void) => {
            if (!stillCurrent()) return;
            const previous = this.notificationContext;
            this.notificationContext = context;
            try { action(); } finally { this.notificationContext = previous; }
        };
        const respond = (result: unknown) => withContext(() => {
            if (nativeCommandApproval) {
                const decision = (result as { decision?: unknown })?.decision;
                const granted = decision === 'accept' || decision === 'acceptForSession'
                    || (decision !== null && typeof decision === 'object');
                this.commandTermination.observeApproval(context.threadId!, context.turnId!, context.itemId!, granted ? 'granted' : 'rejected');
            }
            this.respond(id, result);
        });
        const respondError = (code: number, message: string) => withContext(() => this.respondError(id, code, message));
        if (method === 'mcpServer/elicitation/request') {
            if ((params?.mode === 'form' || params?.mode === 'openai/form')
                && this.userInputHandler
                && params?.requestedSchema?.properties
                && typeof params.requestedSchema.properties === 'object'
                && Object.keys(params.requestedSchema.properties).length > 0) {
                const required = new Set(Array.isArray(params.requestedSchema.required) ? params.requestedSchema.required : []);
                const entries = Object.entries(params.requestedSchema.properties) as Array<[string, any]>;
                const response = await this.userInputHandler({
                    protocol: requestProtocol,
                    requestId: id,
                    threadId: params.threadId,
                    turnId: params.turnId ?? '',
                    itemId: `mcp-elicitation:${params.serverName}:${id}`,
                    autoResolutionMs: null,
                    questions: entries.map(([key, schema]) => ({
                        id: key,
                        header: typeof schema?.title === 'string' ? schema.title : key,
                        question: typeof schema?.description === 'string' ? schema.description : params.message,
                        isOther: !elicitationOptions(schema),
                        isSecret: schema?.format === 'password',
                        options: elicitationOptions(schema),
                        multiSelect: schema?.type === 'array',
                        required: required.has(key),
                    })),
                });
                if (response.cancelled) {
                    respond({ action: 'cancel', content: null, _meta: null });
                    return;
                }
                const content: Record<string, unknown> = {};
                for (const [key, schema] of entries) {
                    const answers = response.answers[key]?.answers ?? [];
                    if (answers.length > 0) content[key] = elicitationValue(schema, answers);
                }
                respond({ action: 'accept', content, _meta: null });
                return;
            }
            const toolName = this.parseToolNameFromElicitationMessage(params?.message) ?? params?.serverName ?? 'McpTool';
            const decision = await this.handleApproval({
                protocol: requestProtocol,
                type: 'mcp',
                callId: `${params?.serverName ?? 'mcp'}:${id}`,
                toolName,
                input: {
                    ...(params?._meta?.tool_params ?? {}),
                    ...(typeof params?.url === 'string' ? { url: params.url } : {}),
                },
                serverName: params?.serverName,
                message: params?.message,
            });
            respond(this.mapDecisionToMcpElicitationResponse(decision, params));
            return;
        }

        // Command execution approval
        if (method === 'item/commandExecution/requestApproval' || method === 'execCommandApproval') {
            const legacy = method === 'execCommandApproval';
            const callId = params.itemId ?? params.callId ?? String(id);
            const decision = await this.handleApproval({
                protocol: requestProtocol,
                type: 'exec',
                callId,
                command: params.command != null ? [params.command] : [],
                cwd: params.cwd,
                reason: params.reason,
            });
            respond({ decision: this.mapDecisionToWire(decision, legacy) });
            return;
        }

        // File change / patch approval
        if (method === 'item/fileChange/requestApproval' || method === 'applyPatchApproval') {
            const legacy = method === 'applyPatchApproval';
            const callId = params.itemId ?? params.callId ?? String(id);
            const decision = await this.handleApproval({
                protocol: requestProtocol,
                type: 'patch',
                callId,
                fileChanges: params.fileChanges ?? (typeof callId === 'string'
                    ? this.rawFileChangesByItemId.get(callId)
                    : undefined),
                reason: params.reason,
            });
            respond({ decision: this.mapDecisionToWire(decision, legacy) });
            return;
        }

        if ((method === 'item/tool/requestUserInput' || method === 'tool/requestUserInput')) {
            this.emitEvent({ type: 'codex_request_user_input', ...params });
            const response = this.userInputHandler
                ? await this.userInputHandler({ ...params, requestId: id, protocol: requestProtocol })
                : { answers: {} };
            respond({ answers: response.answers });
            return;
        }

        if (method === 'item/tool/call') {
            this.emitEvent({ type: 'codex_dynamic_tool_call', ...params });
            if (this.dynamicToolHandler) {
                respond(await this.dynamicToolHandler(params));
                return;
            }
            respond({
                contentItems: [{ type: 'inputText', text: `Hapla has no dynamic tool registered for ${params?.tool ?? 'this call'}.` }],
                success: false,
            });
            return;
        }

        if (method === 'account/chatgptAuthTokens/refresh') {
            if (!this.authTokensRefreshHandler) {
                respondError(-32601, 'Hapla does not own externally managed ChatGPT tokens.');
                return;
            }
            respond(await this.authTokensRefreshHandler(params));
            return;
        }

        if (method === 'attestation/generate') {
            if (!this.attestationHandler) {
                respondError(-32601, 'Client attestation is not configured.');
                return;
            }
            respond(await this.attestationHandler(params));
            return;
        }

        if (method === 'currentTime/read') {
            respond({ currentTimeAt: Math.floor(Date.now() / 1000) });
            return;
        }

        if (method === 'item/permissions/requestApproval') {
            const decision = await this.handleApproval({
                protocol: requestProtocol,
                type: 'mcp',
                callId: params?.itemId ?? String(id),
                toolName: 'RequestPermissions',
                input: {
                    cwd: params?.cwd,
                    reason: params?.reason,
                    permissions: params?.permissions,
                },
                message: params?.reason,
            });
            const accepted = decision === 'approved' || decision === 'approved_for_session';
            const requested = params?.permissions && typeof params.permissions === 'object'
                ? params.permissions
                : {};
            respond({
                permissions: accepted
                    ? {
                        ...(requested.network ? { network: requested.network } : {}),
                        ...(requested.fileSystem ? { fileSystem: requested.fileSystem } : {}),
                    }
                    : {},
                scope: decision === 'approved_for_session' ? 'session' : 'turn',
            });
            return;
        }

        // Unknown server request — fail closed so Codex does not mistake an
        // empty object for approval or successful client-side execution.
        logger.debug(`[CodexAppServer] Unknown server request: ${method}`);
        respondError(-32601, `Unsupported Codex app-server request: ${method}`);
    }

    private async handleApproval(params: Parameters<ApprovalHandler>[0]): Promise<ReviewDecision> {
        if (this.approvalHandler) {
            try {
                return await this.approvalHandler(params);
            } catch (err) {
                logger.debug('[CodexAppServer] Approval handler error:', err);
                return 'denied';
            }
        }
        return 'denied'; // default: deny if no handler
    }

    private handleNotification(method: string, params: any): void {
        const context = codexEventCorrelation(params);
        if (context.threadId && this._threadId && context.threadId !== this._threadId) return;
        if (method === 'serverRequest/resolved') {
            const requestId = params?.requestId;
            const request = this.serverRequests.get(requestId);
            if (request) {
                this.serverRequests.delete(requestId);
                this.emitEvent({ type: 'codex_request', status: 'resolved', kind: request.kind, ...request.context });
            }
            return;
        }
        // A real command terminal item may trail its turn's interruption. Preserve
        // its exit code/output for the original item without reviving that turn.
        const completesEndedCommand = method === 'item/completed'
            && params?.item?.type === 'commandExecution'
            && context.threadId === this._threadId
            && !!context.turnId && this.completedTurnIds.has(context.turnId);
        const pendingCleanupOutput = method === 'item/commandExecution/outputDelta'
            && context.threadId === this._threadId && !!context.turnId && this.commandCleanups.has(context.turnId)
            && this.commandTermination.pending(context.threadId!, context.turnId).some((command) => command.itemId === context.itemId);
        if (method.startsWith('item/') && context.turnId && this._turnId && context.turnId !== this._turnId && !completesEndedCommand && !pendingCleanupOutput) return;
        if (method.startsWith('item/') && context.turnId && this.completedTurnIds.has(context.turnId) && !completesEndedCommand && !pendingCleanupOutput) return;
        // Legacy notifications use a separate compatibility adapter and share terminal guards.
        if (method === 'codex/event' || method.startsWith('codex/event/')) {
            this.notificationProtocol = 'legacy';
            const msg = params?.msg;
            if (msg) {
                const turnId = msg.turn_id ?? msg.turnId ?? null;
                if (msg.type === 'task_complete' || msg.type === 'turn_aborted') {
                    this.emitRawTurnCompletion(turnId, msg.type === 'turn_aborted' ? 'interrupted' : 'completed', msg.error, method);
                    return;
                }
                if (turnId && (this.completedTurnIds.has(turnId) || (this._turnId && turnId !== this._turnId))) return;
                if (msg.type === 'task_started') {
                    if (turnId && this._turnId === turnId) return;
                    if (turnId) this._turnId = turnId;
                    this.markPendingTurnStarted(turnId);
                }
                this.emitEvent(msg);
            }
            return;
        }

        if (this.handleRawNotification(method, params)) {
            logger.debug(`[CodexAppServer] Raw notification: ${method}`);
            return;
        }

        // v2 lifecycle notifications
        if (method === 'thread/started' || method === 'turn/started' ||
            method === 'turn/completed' || method === 'thread/status/changed') {
            logger.debug(`[CodexAppServer] Lifecycle notification: ${method}`);
            // Mark the turn as started so the completion guard lets it through.
            if (method === 'thread/status/changed') {
                this.emitEvent({ type: 'codex_thread_status', source: 'notification', status: params?.status, thread_id: params?.threadId });
            }
            if (method === 'turn/started') {
                const turnId = this.extractTurnId(params);
                if (turnId && this._turnId === turnId) return;
                if (turnId && (this.completedTurnIds.has(turnId) || (this._turnId && this._turnId !== turnId))) return;
                if (turnId) {
                    this._turnId = turnId;
                }
                this.markPendingTurnStarted(turnId);
            }
            // turn/completed is a fallback signal — for mid-inference interrupts,
            // Codex may only signal completion here (not via codex/event turn_aborted).
            // emitRawTurnCompletion deduplicates via completedTurnIds if legacy already handled it.
            if (method === 'turn/completed') {
                this.emitRawTurnCompletion(
                    this.extractTurnId(params),
                    this.extractTurnStatus(params),
                    params?.turn?.error ?? params?.error,
                    method,
                );
            }
            return;
        }

        // MCP server lifecycle: log payload so we can diagnose failed launches
        // (e.g. an MCP bridge failing on Windows due to shebang execution).
        if (method === 'mcpServer/startupStatus/updated') {
            logger.debug(`[CodexAppServer] mcpServer startup status:`, params);
            return;
        }

        // Preserve all future protocol notifications for the bridge consumer.
        // This is the compatibility escape hatch for newly added app-server
        // methods; first-class renderers can be added without losing data.
        this.emitEvent({ type: 'codex_notification', method, params });
        logger.debug(`[CodexAppServer] Notification: ${method}`);
    }
}
