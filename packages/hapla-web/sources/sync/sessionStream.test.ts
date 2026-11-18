import { describe, expect, it } from 'vitest';
import { createReducer, reducer } from './reducer/reducer';
import { acceptSessionStream, commitSessionStreams, createSessionStreamState, projectSessionStreams, type SessionStream } from './sessionStream';
import type { NormalizedMessage } from './typesRaw';
import type { Message } from './typesMessage';

const frame = (overrides: Partial<SessionStream> = {}): SessionStream => ({
    id: 'item-1', turnId: 'turn-1', text: 'partial answer', updatedAt: 100, seq: 1, ...overrides,
});
const final = (overrides: Partial<NormalizedMessage> = {}): NormalizedMessage => ({
    id: 'durable-1', localId: null, createdAt: 110, role: 'agent', isSidechain: false,
    content: [{ type: 'text', text: 'complete answer', uuid: 'item-1', parentUUID: null }],
    meta: { streamId: 'item-1' }, ...overrides,
} as NormalizedMessage);

function harness() {
    const reducerState = createReducer();
    let streams = createSessionStreamState();
    let messages: Record<string, Message> = {};
    return {
        receive(stream: SessionStream) {
            streams = acceptSessionStream(streams, stream);
            messages = projectSessionStreams(messages, streams, reducerState.toolIdToMessageId);
            return Object.values(messages);
        },
        commit(events: NormalizedMessage[]) {
            const result = reducer(reducerState, events, null);
            result.messages.forEach((message) => { messages[message.id] = message; });
            streams = commitSessionStreams(streams, events);
            messages = projectSessionStreams(messages, streams, reducerState.toolIdToMessageId);
            return Object.values(messages);
        },
    };
}

describe('provisional message handoff', () => {
    it('preserves the same canonical row when a durable final replaces streaming text', () => {
        const state = harness();
        const provisional = state.receive(frame());
        const completed = state.commit([final()]);
        expect(completed).toHaveLength(1);
        expect(completed[0]).toMatchObject({ id: provisional[0].id, text: 'complete answer' });
        expect(completed[0]).not.toHaveProperty('provisional');
        expect(state.commit([final()])).toEqual(completed);
    });

    it('does not remove displayed output when a turn completes before persistence arrives', () => {
        const state = harness();
        const provisional = state.receive(frame());
        expect(state.commit([{
            id: 'turn-end', localId: null, createdAt: 120, role: 'event', isSidechain: false,
            content: { type: 'ready' },
        }])).toEqual(provisional);
        expect(state.commit([final()])).toHaveLength(1);
    });

    it('retains concurrent text items and retires only the matching durable item', () => {
        const state = harness();
        state.receive(frame());
        expect(state.receive(frame({ id: 'item-2', text: 'second answer' }))).toHaveLength(2);
        expect(state.commit([final()])).toHaveLength(2);
        const texts = state.commit([final()]).map((message) => message.kind === 'agent-text' && message.text);
        expect(texts).toEqual(expect.arrayContaining(['complete answer', 'second answer']));
    });

    it('rejects late decrypted frames and replayed frames after the item has committed', () => {
        const state = harness();
        state.receive(frame({ seq: 2, text: 'latest answer' }));
        expect(state.receive(frame())[0]).toMatchObject({ text: 'latest answer' });
        const completed = state.commit([final()]);
        expect(state.receive(frame({ seq: 3, updatedAt: 200 }))).toEqual(completed);
    });

    it('accepts an authoritative shorter final while keeping the canonical row', () => {
        const state = harness();
        const provisional = state.receive(frame({ text: 'a much longer provisional answer' }));
        const result = state.commit([final({ content: [{ type: 'text', text: 'short final', uuid: 'item-1', parentUUID: null }] })]);
        expect(result[0]).toMatchObject({ id: provisional[0].id, text: 'short final' });
    });

    it('isolates identical item ids on separate branches', () => {
        const state = harness();
        state.receive(frame({ branchId: 'branch-a' }));
        state.receive(frame({ branchId: 'branch-b' }));
        const result = state.commit([final({ meta: { streamId: 'item-1', branchId: 'branch-b' } })]);
        expect(result).toHaveLength(2);
        expect(new Set(result.map((message) => message.id)).size).toBe(2);
        expect(result.find((message) => message.meta?.branchId === 'branch-a')).toHaveProperty('provisional', true);
    });

    it('merges live shell output into the running tool and retains authoritative terminal output', () => {
        const state = harness();
        state.receive(frame({ kind: 'tool-output', callId: 'call-1', text: 'running output' }));
        const started = state.commit([final({ id: 'tool-start', meta: {}, content: [{
            type: 'tool-call', id: 'call-1', name: 'CodexBash', input: { command: 'echo hello' },
            description: null, uuid: 'call-1', parentUUID: null,
        }] })]);
        expect(started[0]).toMatchObject({ kind: 'tool-call', tool: { state: 'running', result: { output: 'running output' } } });
        const completed = state.commit([final({ id: 'tool-end', meta: {}, content: [{
            type: 'tool-result', tool_use_id: 'call-1', content: { output: 'final output', exitCode: 0 },
            is_error: false, uuid: 'call-end', parentUUID: null,
        }] })]);
        expect(completed[0]).toMatchObject({ tool: { state: 'completed', result: { output: 'final output', exitCode: 0 } } });
        expect(state.receive(frame({ kind: 'tool-output', callId: 'call-1', seq: 99 }))).toEqual(completed);
    });

    it('orders legacy snapshots by timestamp and prevents same-millisecond text rollback', () => {
        const state = harness();
        state.receive(frame({ seq: undefined, updatedAt: 200, text: 'newest answer' }));
        expect(state.receive(frame({ seq: undefined, updatedAt: 100 }))[0]).toMatchObject({ text: 'newest answer' });
        expect(state.receive(frame({ seq: undefined, updatedAt: 200, text: 'new' }))[0]).toMatchObject({ text: 'newest answer' });
    });

    it('does not apply tool output from another branch with an identical call id', () => {
        const state = harness();
        state.receive(frame({ kind: 'tool-output', callId: 'call-1', branchId: 'old', text: 'old branch output' }));
        const started = state.commit([final({ id: 'tool-start', meta: { branchId: 'new' }, content: [{
            type: 'tool-call', id: 'call-1', name: 'CodexBash', input: { command: 'echo hello' },
            description: null, uuid: 'call-1', parentUUID: null,
        }] })]);
        expect(started[0]).toMatchObject({ kind: 'tool-call', tool: { state: 'running' } });
        expect(started[0].kind === 'tool-call' && started[0].tool.result).toBeUndefined();
    });
});
