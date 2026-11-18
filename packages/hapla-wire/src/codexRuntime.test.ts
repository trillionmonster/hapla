import { describe, expect, it } from 'vitest';
import { reduceCodexRuntimeEvent, type CodexRuntimeState } from './codexRuntime';

function event(type: string, seq: number, fields: Record<string, unknown> = {}, correlation: Record<string, unknown> = {}) {
    return { type, ...fields, protocol: { epoch: 'one', epochStartedAt: 10, at: 20 + seq, seq, threadId: 'thread', turnId: 'turn', ...correlation } };
}
function running(): CodexRuntimeState {
    const initial = reduceCodexRuntimeEvent(null, event('codex_runtime_started', 1));
    return reduceCodexRuntimeEvent(initial, event('task_started', 2))!;
}

describe('Codex authoritative runtime state', () => {
    it('keeps command cleanup busy and retryable until exact Turn authority is released', () => {
        let state = reduceCodexRuntimeEvent(running(), event('codex_command_cleanup', 3, { status: 'pending' }))!;
        expect(state).toMatchObject({ turn: 'interruptRequested', runtime: 'active', activity: { phase: 'stoppingCommand' } });
        state = reduceCodexRuntimeEvent(state, event('codex_thread_status', 4, { status: { type: 'idle' } }))!;
        expect(state.runtime).toBe('active');
        state = reduceCodexRuntimeEvent(state, event('codex_command_cleanup', 5, { status: 'failed' }))!;
        expect(state).toMatchObject({ turn: 'interruptRequested', interrupt: 'failed' });
        expect(reduceCodexRuntimeEvent(state, event('codex_command_cleanup', 6, { status: 'confirmed' }, { turnId: 'old' }))).toBe(state);
        state = reduceCodexRuntimeEvent(state, event('codex_command_cleanup', 7, { status: 'confirmed' }))!;
        expect(state.turn).toBe('interruptRequested');
        expect(reduceCodexRuntimeEvent(state, event('turn_aborted', 8, { status: 'interrupted' }))?.turn).toBe('interrupted');
    });
    it('marks a pending start busy and scopes failed starts to their request', () => {
        const initial = reduceCodexRuntimeEvent(null, event('codex_runtime_started', 1));
        const starting = reduceCodexRuntimeEvent(initial, event('codex_turn_starting', 2, { startId: 'start-1' }, { turnId: undefined }))!;
        expect(starting.turn).toBe('starting');
        expect(starting.turnId).toBeNull();
        expect(reduceCodexRuntimeEvent(starting, event('codex_turn_start_failed', 3, { startId: 'old' }, { turnId: undefined }))).toBe(starting);
        expect(reduceCodexRuntimeEvent(starting, event('codex_turn_start_failed', 4, { startId: 'start-1' }, { turnId: undefined }))?.turn).toBe('failed');
        expect(reduceCodexRuntimeEvent(starting, event('task_started', 4))?.turn).toBe('running');
    });

    it('cancels unanswerable requests after the process exits without claiming turn completion', () => {
        const pending = reduceCodexRuntimeEvent(running(), event('codex_request', 3, { status: 'pending', kind: 'approval' }, { requestId: 1 }))!;
        const state = reduceCodexRuntimeEvent(pending, event('codex_runtime_error', 4, { reason: 'processExited' }))!;
        expect(state.runtime).toBe('systemError');
        expect(state.turn).toBe('running');
        expect(state.pendingRequests).toEqual({});
    });
    it('never treats idle, heartbeats or interrupt acknowledgement as completion', () => {
        let state = running();
        state = reduceCodexRuntimeEvent(state, event('codex_thread_status', 3, { status: { type: 'idle' } }))!;
        expect(state.turn).toBe('running');
        expect(state.runtime).toBe('active');
        state = reduceCodexRuntimeEvent(state, event('codex_interrupt', 4, { status: 'requested' }))!;
        state = reduceCodexRuntimeEvent(state, event('codex_interrupt', 5, { status: 'acknowledged' }))!;
        expect(state.turn).toBe('interruptRequested');
        expect(reduceCodexRuntimeEvent(state, event('heartbeat', 6, { thinking: false }))).toBe(state);
        state = reduceCodexRuntimeEvent(state, event('turn_aborted', 7, { status: 'interrupted' }))!;
        expect(state.turn).toBe('interrupted');
        expect(state.lastInterrupt).toEqual({ turnId: 'turn', status: 'interrupted', at: 27 });
    });

    it('rejects duplicates, old epochs and completion for another turn', () => {
        const state = running();
        expect(reduceCodexRuntimeEvent(state, event('task_complete', 2))).toBe(state);
        expect(reduceCodexRuntimeEvent(state, event('task_complete', 3, {}, { epoch: 'old' }))).toBe(state);
        expect(reduceCodexRuntimeEvent(state, event('task_complete', 3, {}, { turnId: 'old' }))).toBe(state);
        expect(reduceCodexRuntimeEvent(state, event('codex_runtime_started', 10, {}, { epoch: 'old', epochStartedAt: 1 }))).toBe(state);
    });

    it('preserves running state on interruption failure and runtime error', () => {
        const state = reduceCodexRuntimeEvent(running(), event('codex_interrupt', 3, { status: 'failed' }))!;
        expect(state.turn).toBe('running');
        expect(state.interrupt).toBe('failed');
        expect(state.lastInterrupt).toEqual({ turnId: 'turn', status: 'failed', at: 23 });
        expect(reduceCodexRuntimeEvent(state, event('codex_runtime_error', 4))?.turn).toBe('running');
    });

    it('retains the most recent interrupt result when a later turn starts', () => {
        let state = reduceCodexRuntimeEvent(running(), event('codex_interrupt', 3, { status: 'requested' }))!;
        state = reduceCodexRuntimeEvent(state, event('turn_aborted', 4, { status: 'interrupted' }))!;
        state = reduceCodexRuntimeEvent(state, event('task_started', 5, {}, { turnId: 'turn-two' }))!;
        expect(state.lastInterrupt).toEqual({ turnId: 'turn', status: 'interrupted', at: 24 });
    });

    it('does not claim success when a requested interrupt loses the completion race', () => {
        let state = reduceCodexRuntimeEvent(running(), event('codex_interrupt', 3, { status: 'acknowledged' }))!;
        state = reduceCodexRuntimeEvent(state, event('task_complete', 4, { status: 'completed' }))!;
        expect(state.turn).toBe('completed');
        expect(state.lastInterrupt).toEqual({ turnId: 'turn', status: 'failed', at: 24 });
    });

    it('keeps the active item identity in activity diagnostics', () => {
        const state = reduceCodexRuntimeEvent(running(), event('codex_activity', 3, {
            phase: 'executing',
            itemType: 'commandExecution',
        }, { itemId: 'item-7' }))!;
        expect(state.activity).toEqual({ phase: 'executing', itemType: 'commandExecution', itemId: 'item-7' });
    });

    it('tracks requests until authoritative resolution and clears on terminal turn', () => {
        const state = reduceCodexRuntimeEvent(running(), event('codex_request', 3, { status: 'pending', kind: 'userInput' }, { requestId: 42 }))!;
        expect(state.pendingRequests['42'].kind).toBe('userInput');
        expect(reduceCodexRuntimeEvent(state, event('codex_request', 4, { status: 'resolved' }, { requestId: 42 }))?.pendingRequests).toEqual({});
        expect(reduceCodexRuntimeEvent(state, event('task_complete', 4))?.pendingRequests).toEqual({});
    });

    it('does not let late activity resurrect a terminal turn', () => {
        const state = reduceCodexRuntimeEvent(running(), event('task_complete', 3))!;
        expect(reduceCodexRuntimeEvent(state, event('agent_message_delta', 4))).toBe(state);
        expect(reduceCodexRuntimeEvent(state, event('codex_request', 4,
            { status: 'pending', kind: 'userInput' }, { requestId: 42 }))).toBe(state);
        const next = reduceCodexRuntimeEvent(state, event('task_started', 5, {}, { turnId: 'next' }))!;
        expect(reduceCodexRuntimeEvent(next, event('turn_aborted', 6))).toBe(next);
    });

    it('changes branch only from an explicit snapshot, never a delayed idle notification', () => {
        const complete = reduceCodexRuntimeEvent(running(), event('task_complete', 3))!;
        const selected = reduceCodexRuntimeEvent(complete, event('codex_thread_status', 4,
            { source: 'snapshot', status: { type: 'idle' } }, { threadId: 'branch', turnId: undefined }))!;
        expect(selected.threadId).toBe('branch');
        expect(reduceCodexRuntimeEvent(selected, event('codex_thread_status', 5, { status: { type: 'idle' } }, { turnId: undefined }))).toBe(selected);
        expect(reduceCodexRuntimeEvent(selected, event('task_started', 6, {}, { threadId: 'branch', turnId: 'next' }))?.turn).toBe('running');
    });
});
