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

import { AgentStateSchema } from './storageTypes';

beforeEach(() => storage.setState(storage.getInitialState(), true));
it('keeps scoped requests distinct and submitting until provider resolution passes through the real store reducer', () => {
    const key = (id: number) => JSON.stringify(['codex-request', 'epoch', 'number', id]);
    const request = (id: number) => ({ tool: 'AskUserQuestion', createdAt: id, arguments: { questions: [{ question: 'Pick', header: 'Pick', options: [], multiSelect: false }] }, protocol: { epoch: 'epoch', requestId: id, threadId: 'thread', turnId: 'turn', itemId: 'same-item' } });
    const first = request(1), second = request(2);
    const session: Session = {
        id: 'session', presence: 0, createdAt: 0, updatedAt: 0, seq: 1, active: true, activeAt: 1, thinking: false, thinkingAt: 0,
        metadataVersion: 1, metadata: null, agentStateVersion: 1, agentState: AgentStateSchema.parse({ requests: { [key(1)]: first, [key(2)]: second } }),
    };
    storage.getState().touchSessionResources('session');
    storage.getState().applySessions([session]);
    storage.getState().applyMessagesLoaded('session');
    const tools = () => storage.getState().sessionMessages.session.messages.filter((message): message is ToolCallMessage => message.kind === 'tool-call');
    expect(tools()).toHaveLength(2);
    storage.getState().applySessions([{ ...session, agentStateVersion: 2, agentState: AgentStateSchema.parse({ requests: { [key(1)]: { ...first, status: 'submitting', submittedAt: 2 }, [key(2)]: second } }) }]);
    expect(tools().find((message) => message.tool.permission?.id === key(1))?.tool).toMatchObject({ state: 'running', permission: { status: 'submitting', protocol: { requestId: 1, itemId: 'same-item' } } });
    storage.getState().applySessions([{ ...session, agentStateVersion: 3, agentState: AgentStateSchema.parse({ requests: { [key(2)]: second }, completedRequests: { [key(1)]: { ...first, status: 'approved', completedAt: 3, providerStatus: 'resolved' } } }) }]);
    expect(tools().find((message) => message.tool.permission?.id === key(1))?.tool).toMatchObject({ state: 'completed', permission: { status: 'approved', providerStatus: 'resolved' } });
    expect(tools().find((message) => message.tool.permission?.id === key(2))?.tool.permission?.status).toBe('pending');
    expect(tools()).toHaveLength(2);
});

it('preserves request expiry metadata and projects only an authoritative expired completion', () => {
    const id = JSON.stringify(['codex-request', 'epoch', 'number', 7]);
    const request = {
        tool: 'AskUserQuestion',
        createdAt: 10,
        arguments: {
            autoResolutionMs: 1_000,
            expiresAt: 1_010,
            questions: [{ id: 'choice', question: 'Pick', header: 'Pick', options: [], multiSelect: false }],
        },
        protocol: { epoch: 'epoch', requestId: 7, threadId: 'thread', turnId: 'turn', itemId: 'item' },
    };
    const session: Session = {
        id: 'session', presence: 0, createdAt: 0, updatedAt: 0, seq: 1, active: true, activeAt: 1, thinking: false, thinkingAt: 0,
        metadataVersion: 1, metadata: null, agentStateVersion: 1,
        agentState: AgentStateSchema.parse({ requests: { [id]: request } }),
    };
    storage.getState().touchSessionResources('session');
    storage.getState().applySessions([session]);
    storage.getState().applyMessagesLoaded('session');
    const question = () => storage.getState().sessionMessages.session.messages.find((message): message is ToolCallMessage => message.kind === 'tool-call');
    expect(question()?.tool).toMatchObject({
        state: 'running',
        input: { autoResolutionMs: 1_000, expiresAt: 1_010 },
        permission: { status: 'pending' },
    });

    storage.getState().applySessions([{
        ...session,
        agentStateVersion: 2,
        agentState: AgentStateSchema.parse({
            requests: { [id]: { ...request, status: 'submitting', submittedAt: 1_010 } },
        }),
    }]);
    expect(question()?.tool).toMatchObject({ state: 'running', permission: { status: 'submitting' } });

    storage.getState().applySessions([{
        ...session,
        agentStateVersion: 3,
        agentState: AgentStateSchema.parse({
            completedRequests: {
                [id]: { ...request, completedAt: 1_011, status: 'expired', reason: 'Request expired', providerStatus: 'resolved' },
            },
        }),
    }]);
    expect(question()?.tool).toMatchObject({
        state: 'error',
        input: { autoResolutionMs: 1_000, expiresAt: 1_010 },
        permission: { status: 'expired', providerStatus: 'resolved', reason: 'Request expired' },
    });
});

it('merges public reasoning summary stream and final into one canonical row while hidden thinking remains unmarked', () => {
    storage.getState().applySessionStream('session', { id: 'summary-item', turnId: 'turn', branchId: 'branch', kind: 'reasoning-summary', text: 'Visible partial summary', seq: 1, updatedAt: 1 });
    const initial = storage.getState().sessionMessages.session.messages[0];
    const message = normalizeRawMessage('wire-id', null, 2, { role: 'session', content: { id: 'summary-item', time: 2, role: 'agent', turn: 'turn', ev: { t: 'text', text: 'Visible completed summary', thinking: true, summary: true } }, meta: { branchId: 'branch' } } as any)!;
    storage.getState().applyMessages('session', [message]);
    storage.getState().applySessionStream('session', { id: 'summary-item', turnId: 'turn', branchId: 'branch', kind: 'reasoning-summary', text: 'late partial', seq: 2, updatedAt: 3 });
    expect(storage.getState().sessionMessages.session.messages).toEqual([expect.objectContaining({ id: initial.id, text: 'Visible completed summary', isThinking: true, meta: expect.objectContaining({ reasoningSummary: true }) })]);
    const hidden = normalizeRawMessage('hidden', null, 3, { role: 'session', content: { id: 'hidden', time: 3, role: 'agent', turn: 'turn', ev: { t: 'text', text: 'Hidden thinking', thinking: true } } } as any)!;
    expect(hidden.meta?.reasoningSummary).toBeUndefined();
});
