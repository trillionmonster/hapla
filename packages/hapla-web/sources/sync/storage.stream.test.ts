import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./sync', () => ({ sync: {} }));
vi.mock('./projectManager', () => ({ projectManager: { updateSessions: vi.fn() } }));
vi.mock('@/components/tools/knownTools', () => ({ isMutableTool: () => false }));
vi.mock('@/utils/sessionUtils', () => ({ getSessionName: () => 'Session', getSessionSubtitle: () => '', getSessionAvatarId: () => 'avatar' }));
vi.mock('./persistence', () => ({
    loadSessionCodexPreferences: () => ({}), saveSessionCodexPreferences: vi.fn(),
    loadSettings: () => ({ settings: {}, version: 0 }), loadLocalSettings: () => ({}), loadProfile: () => ({}),
    loadSessionDrafts: () => ({}), loadSessionPermissionModes: () => ({}), loadSessionModelModes: () => ({}), loadSessionEffortLevels: () => ({}),
    saveSettings: vi.fn(), saveLocalSettings: vi.fn(), saveProfile: vi.fn(), saveSessionDrafts: vi.fn(),
    saveSessionPermissionModes: vi.fn(), saveSessionModelModes: vi.fn(), saveSessionEffortLevels: vi.fn(),
}));

import { storage } from './storage';
import { normalizeRawMessage, type NormalizedMessage } from './typesRaw';
import type { Session } from './storageTypes';
import type { ToolCallMessage } from './typesMessage';
import { reduceCodexRuntimeEvent } from '@hapla/wire';

const final: NormalizedMessage = {
    id: 'persisted', localId: null, seq: 1, createdAt: 200, role: 'agent', isSidechain: false,
    content: [{ type: 'text', text: 'completed answer', uuid: 'item', parentUUID: null }],
    meta: { streamId: 'item' },
};

beforeEach(() => storage.setState(storage.getInitialState(), true));

function protocolMessage(id: string, turn: string, branchId: string, ev: Record<string, unknown>, time = 100, subagent?: string): NormalizedMessage {
    const result = normalizeRawMessage(id, null, time, {
        role: 'session', content: { id, time, role: 'agent', turn, ev, ...(subagent ? { subagent } : {}) }, meta: { branchId },
    } as unknown as Parameters<typeof normalizeRawMessage>[3]);
    if (!result) throw new Error('Expected a valid session protocol message');
    return result;
}

const toolStart = (call: string, turn: string, branchId: string) => protocolMessage(`start-${call}`, turn, branchId, {
    t: 'tool-call-start', call, name: 'CodexBash', title: 'Run command', description: '', args: { command: call },
});

describe('storage stream transactions', () => {
    it('never publishes an empty or duplicate row during turn-end, disconnect, and durable handoff', () => {
        storage.getState().applySessionStream('session', { id: 'item', turnId: 'turn', text: 'answer', updatedAt: 100 });
        const snapshots: MessageSnapshot[] = [];
        type MessageSnapshot = { id: string; text?: string }[];
        const unsubscribe = storage.subscribe((state) => snapshots.push(state.sessionMessages.session.messages.map((message) => ({
            id: message.id, ...('text' in message ? { text: message.text } : {}),
        }))));
        const initialId = storage.getState().sessionMessages.session.messages[0].id;
        storage.getState().applyMessages('session', [{
            id: 'end', localId: null, createdAt: 150, role: 'event', isSidechain: false, content: { type: 'ready' },
        }]);
        storage.getState().setSocketStatus('disconnected');
        storage.getState().setSocketStatus('connected');
        storage.getState().applyMessages('session', [final]);
        storage.getState().applySessionStream('session', { id: 'item', turnId: 'turn', text: 'late frame', updatedAt: 300 });
        unsubscribe();
        expect(snapshots.length).toBeGreaterThan(0);
        expect(snapshots.every((messages) => messages.length === 1 && messages[0].id === initialId)).toBe(true);
        expect(snapshots.at(-1)).toEqual([{ id: initialId, text: 'completed answer' }]);
    });

    it('preserves event history and pagination state across agent-state refreshes', () => {
        const session = {
            id: 'session', createdAt: 0, updatedAt: 0, seq: 0, active: true, activeAt: 0,
            thinking: false, thinkingAt: 0, metadataVersion: 1, metadata: null,
            agentStateVersion: 1, agentState: {},
        } as Session;
        storage.getState().applySessions([session]);
        storage.getState().applyMessages('session', [final]);
        storage.getState().applyMessagePageState('session', { hasOlder: true, hasNewer: true });
        storage.getState().applySessions([{ ...session, agentStateVersion: 2 }]);
        expect(storage.getState().sessionMessages.session).toMatchObject({
            rawMessagesMap: { persisted: final }, hasOlder: true, hasNewer: true, cachedEventCount: 1,
        });
    });

    it('rejects stale metadata and agent-state versions after a newer state has been applied', () => {
        const newer = {
            id: 'session', createdAt: 0, updatedAt: 0, seq: 0, active: true, activeAt: 0,
            thinking: false, thinkingAt: 0, metadataVersion: 2, metadata: { activeCodexBranchId: 'new' },
            agentStateVersion: 2, agentState: { controlledByUser: true },
        } as Session;
        storage.getState().applySessions([newer]);
        storage.getState().applySessions([{ ...newer, metadataVersion: 1, metadata: null, agentStateVersion: 1, agentState: {} }]);
        expect(storage.getState().sessions.session).toMatchObject({
            metadataVersion: 2, metadata: { activeCodexBranchId: 'new' }, agentStateVersion: 2, agentState: { controlledByUser: true },
        });
    });

    it('uses authoritative Codex state and pending requests in session list rows despite an idle heartbeat', () => {
        const initial = reduceCodexRuntimeEvent(null, { type: 'codex_runtime_started', protocol: { epoch: 'one', epochStartedAt: 1, seq: 1 } });
        const running = reduceCodexRuntimeEvent(initial, { type: 'task_started', protocol: { epoch: 'one', seq: 2, turnId: 'turn' } })!;
        const session = {
            id: 'session', createdAt: 0, updatedAt: 0, seq: 0, active: true, activeAt: 0,
            thinking: false, thinkingAt: 0, metadataVersion: 1, metadata: null,
            agentStateVersion: 1, agentState: { codexRuntime: running },
        } as Session;
        const rowStates = () => storage.getState().sessionListViewData?.flatMap((item) => (
            item.group.onlineSessions.map((row) => row.state)
                .concat(item.group.offlineSessions.map((row) => row.state))
        ));
        storage.getState().applySessions([session]);
        expect(rowStates()).toContain('thinking');
        storage.getState().applySessions([{ ...session, agentStateVersion: 2, agentState: {
            codexRuntime: running, requests: { request: { tool: 'AskUserQuestion', arguments: {} } },
        } }]);
        expect(rowStates()).toContain('permission_required');
    });

    it.each([['cancelled', 'interrupted'], ['failed', 'failed']] as const)(
        'settles only the exact turn and branch on %s, preserving displayed output without inventing an exit code', (status, expectedStatus) => {
            storage.getState().applyMessages('session', [
                toolStart('old-call', 'old-turn', 'branch-a'),
                toolStart('new-call', 'new-turn', 'branch-a'),
                toolStart('other-branch-call', 'old-turn', 'branch-b'),
            ]);
            storage.getState().applySessionStream('session', {
                id: 'old-call', callId: 'old-call', turnId: 'old-turn', branchId: 'branch-a', kind: 'tool-output',
                text: 'output before interruption', updatedAt: 120, seq: 1,
            });
            storage.getState().applyMessages('session', [protocolMessage('turn-end', 'old-turn', 'branch-a', { t: 'turn-end', status }, 150)]);
            const byCommand = (command: string) => storage.getState().sessionMessages.session.messages.find((message): message is ToolCallMessage => (
                message.kind === 'tool-call' && message.tool.input.command === command
            ));
            expect(byCommand('old-call')).toMatchObject({ tool: {
                state: 'error', completedByTurn: true, result: { status: expectedStatus, output: 'output before interruption' },
            } });
            expect(byCommand('old-call')?.kind === 'tool-call' && byCommand('old-call')?.tool.result.exitCode).toBeUndefined();
            expect(byCommand('new-call')).toMatchObject({ tool: { state: 'running' } });
            expect(byCommand('other-branch-call')).toMatchObject({ tool: { state: 'running' } });
            storage.getState().applySessionStream('session', {
                id: 'old-call', callId: 'old-call', turnId: 'old-turn', branchId: 'branch-a', kind: 'tool-output',
                text: 'late output', updatedAt: 200, seq: 2,
            });
            expect(byCommand('old-call')).toMatchObject({ tool: { result: { output: 'output before interruption' } } });
            storage.getState().applyMessages('session', [protocolMessage('actual-item-end', 'old-turn', 'branch-a', {
                t: 'tool-call-end', call: 'old-call', isError: true, result: { output: 'durable output', status: expectedStatus, exitCode: 130 },
            }, 220)]);
            expect(byCommand('old-call')).toMatchObject({ tool: { result: { output: 'durable output', exitCode: 130 } } });
            expect(byCommand('old-call')?.kind === 'tool-call' && byCommand('old-call')?.tool.completedByTurn).toBeUndefined();
        },
    );

    it('keeps late tool starts stopped after the matching turn-end has already committed', () => {
        storage.getState().applyMessages('session', [protocolMessage('cancelled', 'old-turn', 'branch-a', { t: 'turn-end', status: 'cancelled' }, 150)]);
        storage.getState().applyMessages('session', [toolStart('late-call', 'old-turn', 'branch-a')]);
        expect(storage.getState().sessionMessages.session.messages[0]).toMatchObject({
            kind: 'tool-call', tool: { state: 'error', result: { status: 'interrupted' } },
        });
    });

    it.each([false, true])('replaces a synthesized command completion with the actual item result (sidechain=%s)', (sidechain) => {
        const parent = protocolMessage('parent-msg', 'parent-turn', 'branch-a', {
            t: 'tool-call-start', call: 'parent-tool', name: 'Task', title: 'Delegate', description: '', args: { prompt: 'Run a command' },
        });
        const child = (id: string, ev: Record<string, unknown>, time: number) => protocolMessage(
            id, 'child-turn', 'branch-a', ev, time, sidechain ? 'parent-tool' : undefined,
        );
        storage.getState().applyMessages('session', [
            ...(sidechain ? [parent] : []),
            child('child-start', { t: 'tool-call-start', call: 'child-call', name: 'CodexBash', title: '', description: '', args: { command: 'sleep 10' } }, 110),
        ]);
        const command = (): ToolCallMessage => {
            const messages = storage.getState().sessionMessages.session.messages;
            expect(messages).toHaveLength(1);
            const root = messages[0] as ToolCallMessage;
            if (sidechain) {
                expect(root.tool.state).toBe('running');
                expect(root.children).toHaveLength(1);
                return root.children[0] as ToolCallMessage;
            }
            return root;
        };
        storage.getState().applyMessages('session', [child('synthetic-end', {
            t: 'tool-call-end', call: 'child-call', isError: true,
            result: { completedByTurn: true, status: 'interrupted', output: 'partial output', exitCode: null },
        }, 120)]);
        expect(command().tool).toMatchObject({ state: 'error', completedByTurn: true });
        storage.getState().applyMessages('session', [protocolMessage('turn-end', 'child-turn', 'branch-a', { t: 'turn-end', status: 'cancelled' }, 130)]);
        storage.getState().applyMessages('session', [child('actual-end', {
            t: 'tool-call-end', call: 'child-call', isError: true,
            result: { status: 'interrupted', output: 'full authoritative output', exitCode: 130, durationMs: 250 },
        }, 140)]);
        expect(command().tool).toMatchObject({ state: 'error', result: { output: 'full authoritative output', exitCode: 130, durationMs: 250 } });
        expect(command().tool.completedByTurn).toBeUndefined();
        storage.getState().applyMessages('session', [child('late-synthetic-end', {
            t: 'tool-call-end', call: 'child-call', isError: true,
            result: { completedByTurn: true, status: 'interrupted', output: 'old partial output' },
        }, 150)]);
        expect(command().tool.result.output).toBe('full authoritative output');
    });

    it('updates the owning card when turn-end settles a sidechain command without duplicating the child at the root', () => {
        storage.getState().applyMessages('session', [
            protocolMessage('parent-msg', 'parent-turn', 'branch-a', {
                t: 'tool-call-start', call: 'parent-tool', name: 'Task', title: '', description: '', args: { prompt: 'Run a command' },
            }),
            protocolMessage('child-start', 'child-turn', 'branch-a', {
                t: 'tool-call-start', call: 'child-call', name: 'CodexBash', title: '', description: '', args: { command: 'sleep 10' },
            }, 110, 'parent-tool'),
        ]);
        storage.getState().applyMessages('session', [protocolMessage('turn-end', 'child-turn', 'branch-a', { t: 'turn-end', status: 'cancelled' }, 130)]);
        const messages = storage.getState().sessionMessages.session.messages;
        expect(messages).toHaveLength(1);
        expect(messages[0]).toMatchObject({ kind: 'tool-call', tool: { state: 'running' }, children: [{
            kind: 'tool-call', tool: { state: 'error', completedByTurn: true, result: { status: 'interrupted' } },
        }] });
    });
});


it('projects live output into only its scoped sidechain child and preserves it when the exact child turn is aborted', () => {
    storage.getState().applyMessages('session', [
        protocolMessage('parent', 'parent-turn', 'branch', { t: 'tool-call-start', call: 'parent', name: 'Task', title: '', description: '', args: {} }),
        protocolMessage('child', 'child-turn', 'branch', { t: 'tool-call-start', call: 'child', name: 'CodexBash', title: '', description: '', args: { command: 'child command' } }, 110, 'parent'),
    ]);
    storage.getState().applySessionStream('session', { id: 'child', callId: 'child', kind: 'tool-output', branchId: 'branch', turnId: 'wrong-turn', text: 'wrong output', seq: 1, updatedAt: 111 });
    let parent = storage.getState().sessionMessages.session.messages[0] as ToolCallMessage;
    expect((parent.children[0] as ToolCallMessage).tool.result).toBeUndefined();
    storage.getState().applySessionStream('session', { id: 'child', callId: 'child', kind: 'tool-output', branchId: 'branch', turnId: 'child-turn', text: 'live child output', seq: 2, updatedAt: 112 });
    parent = storage.getState().sessionMessages.session.messages[0] as ToolCallMessage;
    expect((parent.children[0] as ToolCallMessage).tool.result.output).toBe('live child output');
    expect(parent.tool.result).toBeUndefined();
    storage.getState().applyMessages('session', [protocolMessage('aborted', 'child-turn', 'branch', { t: 'turn-end', status: 'cancelled' }, 120)]);
    parent = storage.getState().sessionMessages.session.messages[0] as ToolCallMessage;
    expect(storage.getState().sessionMessages.session.messages).toHaveLength(1);
    expect((parent.children[0] as ToolCallMessage).tool).toMatchObject({ state: 'error', result: { output: 'live child output', status: 'interrupted' } });
    expect(parent.tool.state).toBe('running');
});
