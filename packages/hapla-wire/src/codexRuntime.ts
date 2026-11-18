import { z } from 'zod';

export const CodexRuntimeStateSchema = z.object({
    epoch: z.string(),
    epochStartedAt: z.number(),
    seq: z.number().int().nonnegative(),
    updatedAt: z.number(),
    threadId: z.string().nullable(),
    turnId: z.string().nullable(),
    startId: z.string().nullable().optional(),
    runtime: z.enum(['loading', 'notLoaded', 'idle', 'active', 'systemError']),
    turn: z.enum(['none', 'starting', 'running', 'interruptRequested', 'completed', 'interrupted', 'failed']),
    activity: z.object({
        phase: z.string(),
        itemType: z.string().optional(),
        itemId: z.string().optional(),
    }).nullable(),
    interrupt: z.enum(['none', 'requested', 'acknowledged', 'failed']),
    lastInterrupt: z.object({
        turnId: z.string(),
        status: z.enum(['interrupted', 'failed']),
        at: z.number(),
    }).optional(),
    pendingRequests: z.record(z.object({
        kind: z.enum(['approval', 'userInput', 'elicitation']),
        turnId: z.string().optional(),
        itemId: z.string().optional(),
    })),
});

export type CodexRuntimeState = z.infer<typeof CodexRuntimeStateSchema>;

export function isCodexTurnRunning(state: CodexRuntimeState): boolean {
    return state.turn === 'starting' || state.turn === 'running' || state.turn === 'interruptRequested';
}

/** Only protocol events may change execution state. Heartbeats are deliberately absent. */
export function reduceCodexRuntimeEvent(
    previous: CodexRuntimeState | null | undefined,
    event: Record<string, unknown>,
): CodexRuntimeState | null {
    const p = event.protocol as Record<string, unknown> | undefined;
    if (!p || typeof p.epoch !== 'string' || typeof p.seq !== 'number') return previous ?? null;
    const at = typeof p.at === 'number' ? p.at : typeof p.epochStartedAt === 'number' ? p.epochStartedAt : 0;
    if (event.type === 'codex_runtime_started') {
        const epochStartedAt = typeof p.epochStartedAt === 'number' ? p.epochStartedAt : at;
        if (previous && (previous.epoch === p.epoch || epochStartedAt <= previous.epochStartedAt)) return previous;
        return {
            epoch: p.epoch, epochStartedAt, seq: p.seq, updatedAt: at,
            threadId: typeof p.threadId === 'string' ? p.threadId : null, turnId: null, startId: null,
            runtime: 'loading', turn: 'none', activity: null, interrupt: 'none', pendingRequests: {},
        };
    }
    if (!previous || p.epoch !== previous.epoch || p.seq <= previous.seq) return previous ?? null;
    const threadId = typeof p.threadId === 'string' ? p.threadId : null;
    const turnId = typeof p.turnId === 'string' ? p.turnId : null;
    // A thread change is an explicit start/read/resume snapshot, never a delayed item.
    if (threadId && previous.threadId && threadId !== previous.threadId
        && !(event.type === 'codex_thread_status' && event.source === 'snapshot')) return previous;
    if (turnId && previous.turnId && turnId !== previous.turnId && event.type !== 'task_started') return previous;
    const next: CodexRuntimeState = { ...previous, seq: p.seq, updatedAt: at, threadId: threadId ?? previous.threadId };
    switch (event.type) {
        case 'codex_turn_starting':
            if (typeof event.startId !== 'string' || isCodexTurnRunning(previous)) return previous;
            return { ...next, turnId: null, startId: event.startId, turn: 'starting', runtime: 'active', activity: { phase: 'starting' }, interrupt: 'none', pendingRequests: {} };
        case 'codex_turn_start_failed':
            if (previous.turn !== 'starting' || event.startId !== previous.startId) return previous;
            return { ...next, startId: null, turn: 'failed', runtime: 'idle', activity: null, pendingRequests: {} };
        case 'task_started':
            if (!turnId || turnId === previous.turnId) return previous;
            return { ...next, turnId, startId: null, turn: 'running', runtime: 'active', activity: { phase: 'starting' }, interrupt: 'none', pendingRequests: {} };
        case 'task_complete':
        case 'turn_aborted': {
            if (!turnId || turnId !== previous.turnId || !isCodexTurnRunning(previous)) return previous;
            const failed = event.status === 'failed' || event.error != null;
            const wasInterrupted = event.type === 'turn_aborted' || previous.turn === 'interruptRequested';
            return {
                ...next, runtime: 'idle', turn: failed ? 'failed' : event.type === 'turn_aborted' ? 'interrupted' : 'completed',
                activity: null, interrupt: 'none', pendingRequests: {},
                ...(wasInterrupted ? {
                    lastInterrupt: {
                        turnId,
                        status: failed || event.type !== 'turn_aborted' ? 'failed' as const : 'interrupted' as const,
                        at,
                    },
                } : {}),
            };
        }
        case 'codex_thread_status': {
            const status = event.status as { type?: string } | string | null;
            const value = typeof status === 'string' ? status : status?.type;
            if (!['notLoaded', 'idle', 'active', 'systemError'].includes(value ?? '')) return previous;
            // idle can precede turn/completed. It never ends a running turn.
            const runtime = value === 'idle' && isCodexTurnRunning(previous) ? 'active' : value as CodexRuntimeState['runtime'];
            if (threadId !== null && threadId !== previous.threadId) {
                if (isCodexTurnRunning(previous)) return previous;
                return { ...next, runtime, turn: 'none', turnId: null, activity: null, pendingRequests: {}, interrupt: 'none' };
            }
            return { ...next, runtime };
        }
        case 'codex_interrupt': {
            if (!turnId || turnId !== previous.turnId || !isCodexTurnRunning(previous)) return previous;
            if (event.status === 'requested' || event.status === 'acknowledged') {
                return { ...next, turn: 'interruptRequested', interrupt: event.status };
            }
            if (event.status === 'failed') return {
                ...next,
                turn: 'running',
                interrupt: 'failed',
                lastInterrupt: { turnId, status: 'failed', at },
            };
            return previous;
        }
        case 'codex_command_cleanup': {
            if (!turnId || turnId !== previous.turnId || !isCodexTurnRunning(previous)) return previous;
            if (event.status === 'pending') {
                return { ...next, runtime: 'active', turn: 'interruptRequested', interrupt: 'acknowledged', activity: { phase: 'stoppingCommand' } };
            }
            if (event.status === 'failed') {
                return { ...next, runtime: 'active', turn: 'interruptRequested', interrupt: 'failed', activity: { phase: 'stoppingCommand' } };
            }
            // Cleanup confirmation is followed by the original authoritative Turn terminal.
            if (event.status === 'confirmed') return { ...next, interrupt: 'acknowledged' };
            return previous;
        }
        case 'codex_runtime_error':
            return { ...next, runtime: 'systemError', interrupt: previous.turn === 'interruptRequested' ? 'failed' : previous.interrupt,
                ...(['processExited', 'disconnected', 'processError'].includes(String(event.reason)) ? { pendingRequests: {} } : {}),
            };
        case 'codex_request': {
            if (event.status === 'pending' && turnId && !isCodexTurnRunning(previous)) return previous;
            const requestId = p.requestId ?? event.requestId;
            if (typeof requestId !== 'string' && typeof requestId !== 'number') return previous;
            const pendingRequests = { ...previous.pendingRequests };
            if (event.status === 'resolved') delete pendingRequests[String(requestId)];
            else if (event.status === 'pending' && ['approval', 'userInput', 'elicitation'].includes(String(event.kind))) {
                pendingRequests[String(requestId)] = {
                    kind: event.kind as 'approval' | 'userInput' | 'elicitation',
                    ...(turnId ? { turnId } : {}),
                    ...(typeof p.itemId === 'string' ? { itemId: p.itemId } : {}),
                };
            } else return previous;
            return { ...next, pendingRequests };
        }
        case 'codex_activity':
        case 'agent_message_delta':
        case 'agent_reasoning_delta':
        case 'agent_reasoning_section_break': {
            if (!isCodexTurnRunning(previous)) return previous;
            const phase = event.type === 'codex_activity' ? event.phase : event.type === 'agent_message_delta' ? 'outputting' : 'reasoning';
            if (typeof phase !== 'string') return previous;
            const itemType = typeof event.itemType === 'string' ? event.itemType : undefined;
            const itemId = typeof p.itemId === 'string' ? p.itemId : undefined;
            if (previous.activity?.phase === phase
                && previous.activity?.itemType === itemType
                && previous.activity?.itemId === itemId) return previous;
            return { ...next, activity: {
                phase,
                ...(itemType ? { itemType } : {}),
                ...(itemId ? { itemId } : {}),
            } };
        }
        default: return previous;
    }
}
