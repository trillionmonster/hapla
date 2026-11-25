import { beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
// @ts-expect-error installed renderer lacks declarations
import { act, create } from 'react-test-renderer';

const persisted = vi.hoisted(() => ({ drafts: {} as Record<string, string>, permission: {} as Record<string, string>, model: {} as Record<string, string>, effort: {} as Record<string, string> }));

vi.mock('./sync', () => ({ sync: {} }));
vi.mock('./projectManager', () => ({ projectManager: { updateSessions: vi.fn() } }));
vi.mock('@/components/tools/knownTools', () => ({ isMutableTool: () => false }));
vi.mock('@/utils/sessionUtils', () => ({ getSessionName: () => 'Session', getSessionSubtitle: () => '', getSessionAvatarId: () => 'avatar' }));
vi.mock('./persistence', () => ({
    loadSessionCodexPreferences: () => ({}), saveSessionCodexPreferences: vi.fn(),
    loadSettings: () => ({ settings: {}, version: 0 }), loadLocalSettings: () => ({}), loadProfile: () => ({}),
    loadSessionDrafts: () => ({ ...persisted.drafts }), loadSessionPermissionModes: () => ({ ...persisted.permission }), loadSessionModelModes: () => ({ ...persisted.model }), loadSessionEffortLevels: () => ({ ...persisted.effort }),
    saveSettings: vi.fn(), saveLocalSettings: vi.fn(), saveProfile: vi.fn(), saveSessionDrafts: (drafts: Record<string, string>) => { persisted.drafts = { ...drafts }; },
    saveSessionPermissionModes: vi.fn(), saveSessionModelModes: vi.fn(), saveSessionEffortLevels: vi.fn(),
}));

import { storage, messageSignature, useConversationMessages, useConversationSessionIds } from './storage';
import type { NormalizedMessage } from './typesRaw';
import type { Session } from './storageTypes';
import { estimateRetainedBytes, MAX_SESSION_CACHE_BYTES, sessionResources } from './sessionResources';
import { SessionScrollAnchorTracker } from './sessionScrollAnchor';
import { conversationHistoryOrder, loadConversationHistoryWindow } from './sessionHistory';
import { filterMessagesForActiveBranch } from '@/utils/sessionBranches';
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

beforeEach(() => { persisted.drafts = {}; storage.setState(storage.getInitialState(), true); });
const session = (id: string): Session => ({
    id, presence: 0, createdAt: 0, updatedAt: 0, seq: 100000, active: false, activeAt: 0, thinking: false, thinkingAt: 0,
    metadata: null, metadataVersion: 1, agentStateVersion: 1, agentState: {
        requests: { approval: { tool: 'Bash', arguments: { command: 'x'.repeat(50000) } } },
        completedRequests: { previous: { tool: 'Bash', arguments: {}, status: 'approved' } },
    },
} as Session);
const messages = (id: string, length = 80): NormalizedMessage[] => Array.from({ length }, (_, index) => ({
    id: `${id}-${index}`, seq: 100000 - length + index + 1, localId: null, createdAt: index,
    role: 'user', isSidechain: false, content: { type: 'text', text: `${id}-${index}:` + 'x'.repeat(16000) },
}));

describe('actual store session resource lifecycle', () => {
    it('keeps all three persisted retry questions and original context on original-route entry and re-entry', async () => {
        const metadata = { activeCodexBranchId: 'branch', codexBranches: [{ id: 'branch', threadId: 'branch', label: 'Original', createdAt: 1 }] } as Session['metadata'];
        const rows = [
            { ...session('original'), agentState: null, active: true, conversationId: 'conversation', metadata, createdAt: 1, lastUserMessageAt: 10, updatedAt: 10000 },
            ...[1, 2, 3].map(i => ({ ...session(`retry-${i}`), agentState: null, seq: 1, conversationId: 'conversation', metadata, createdAt: 100 + i, lastUserMessageAt: 100 + i, updatedAt: 100 + i })),
        ];
        storage.getState().applySessions(rows);
        let ids: string[] = [], conversation!: ReturnType<typeof useConversationMessages>;
        function Harness() { ids = useConversationSessionIds('original'); conversation = useConversationMessages('original'); return null; }
        let root: any;
        await act(async () => { root = create(React.createElement(Harness)); });
        const readLatest = async () => loadConversationHistoryWindow(conversationHistoryOrder('original', rows).map(row => row.id), async id => {
            const raw = id === 'original'
                ? messages(id).map(message => ({ ...message, role: 'user' as const, content: { type: 'text' as const, text: `context-${message.createdAt}` }, meta: { branchId: 'branch' } }))
                : [{ ...messages(id, 1)[0], role: 'user' as const, seq: 1, createdAt: Number(id.slice(-1)) + 100, content: { type: 'text' as const, text: `saved-question-${id}` }, meta: { branchId: 'branch' } }];
            storage.getState().touchSessionResources(id);
            storage.getState().applyMessages(id, raw);
            storage.getState().applyMessagesLoaded(id);
            storage.getState().applyMessagePageState(id, { hasOlder: id === 'original', cachedEventCount: raw.length });
            return { count: raw.length, hasOlder: id === 'original' };
        }, () => true);
        for (let entry = 0; entry < 2; entry++) {
            await act(async () => { await readLatest(); });
            expect(ids).toEqual(['retry-3', 'retry-2', 'retry-1', 'original']);
            expect(conversation.sessionIds).toEqual(ids);
            const visible = filterMessagesForActiveBranch(conversation.messages, metadata);
            expect(visible).toHaveLength(83);
            expect(visible.slice(0, 3).map(message => message.kind === 'user-text' ? message.text : '')).toEqual([
                'saved-question-retry-3', 'saved-question-retry-2', 'saved-question-retry-1',
            ]);
            expect(conversation.hasNewer).toBe(false);
            expect(conversation.hasOlder).toBe(true);
            // Leaving the view unloads plaintext. Re-entry must read the
            // acknowledged questions again from their owning runtimes.
            await act(async () => { for (const id of ids) storage.getState().unloadSessionResources(id); });
            expect(storage.getState().sessionMessages).toEqual({});
        }
        await act(async () => root.unmount());
    });

    it('keeps the newest combined edge until history was explicitly requested, then restores latest without losing questions', async () => {
        storage.getState().applySessions([
            { ...session('new'), agentState: null, conversationId: 'conversation', createdAt: 2 },
            { ...session('old'), agentState: null, conversationId: 'conversation', createdAt: 1 },
        ]);
        for (const id of ['new', 'old']) {
            storage.getState().touchSessionResources(id);
            storage.getState().applyMessages(id, messages(id, 400).map((message, index) => ({ ...message, role: 'user' as const, createdAt: (id === 'new' ? 1000 : 0) + index, content: { type: 'text', text: `${id}-${index}` } })));
        }
        let conversation!: ReturnType<typeof useConversationMessages>;
        function Harness() { conversation = useConversationMessages('new'); return null; }
        let root: any; await act(async () => { root = create(React.createElement(Harness)); });
        expect(conversation.messages).toHaveLength(600);
        expect(conversation.messages[0]).toMatchObject({ kind: 'user-text', text: 'new-399' });
        expect(conversation.messages.at(-1)).toMatchObject({ kind: 'user-text', text: 'old-200' });
        expect(conversation.hasNewer).toBe(false);
        expect(conversation.hasOlder).toBe(true);
        await act(async () => storage.getState().setSessionHistoryState('new', { historyDirection: 'oldest' }));
        expect(conversation.messages.at(-1)).toMatchObject({ kind: 'user-text', text: 'old-0' });
        expect(conversation.hasNewer).toBe(true);
        await act(async () => storage.getState().setSessionHistoryState('new', { historyDirection: 'newest' }));
        expect(conversation.messages[0]).toMatchObject({ kind: 'user-text', text: 'new-399' });
        expect(conversation.hasNewer).toBe(false);
        expect(Object.keys(storage.getState().sessionMessages)).toEqual(['new', 'old']);
        await act(async () => root.unmount());
    });
    it('saves the final visible cursor after scrolling, survives unload, and protects it during initial restoration', () => {
        storage.getState().applySessions([session('anchor')]);
        storage.getState().touchSessionResources('anchor');
        storage.getState().applyMessages('anchor', messages('anchor'));
        const save = (anchor: import('./sessionResources').SessionScrollAnchor) => storage.getState().saveSessionScrollAnchor('anchor', anchor);
        const tracker = new SessionScrollAnchorTracker(undefined, save);
        tracker.viewable({ sourceSessionId: 'anchor', messageId: 'anchor-79', seq: 100000 });
        tracker.scroll(5000);
        tracker.viewable({ sourceSessionId: 'anchor', messageId: 'anchor-76', seq: 99997 });
        tracker.flush();
        storage.getState().unloadSessionResources('anchor');
        const saved = storage.getState().sessionViewStates.anchor.anchor;
        expect(saved).toMatchObject({ sourceSessionId: 'anchor', seq: 99997, offset: 5000 });
        const restored = new SessionScrollAnchorTracker(saved, save);
        restored.scroll(0);
        restored.viewable({ sourceSessionId: 'anchor', messageId: 'anchor-79', seq: 100000 });
        restored.flush();
        expect(storage.getState().sessionViewStates.anchor.anchor).toEqual(saved);
        restored.restored();
        restored.scroll(0);
        expect(storage.getState().sessionViewStates.anchor.anchor?.offset).toBe(0);
    });
    it('releases body, reducer, streams, files, requests and Blobs across 50 sessions while preserving only cursors and metadata', () => {
        storage.getState().applySessions(Array.from({ length: 50 }, (_, index) => session(`s-${index}`)));
        const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
        for (let index = 0; index < 50; index++) {
            const id = `s-${index}`;
            const controller = new AbortController();
            sessionResources.register(id, () => controller.abort());
            sessionResources.trackObjectUrl(id, `blob:${id}`);
            storage.getState().touchSessionResources(id);
            storage.getState().applyMessages(id, messages(id));
            storage.getState().applyMessagesLoaded(id);
            storage.getState().applyMessagePageState(id, { hasOlder: true });
            storage.getState().applySessionStream(id, { id: 'stream', turnId: 'turn', text: 'preview', updatedAt: 1 });
            storage.getState().applyFileCache(id, '/file.txt', 'body', null, false);
            storage.getState().saveSessionScrollAnchor(id, { sourceSessionId: id, messageId: `${id}-20`, seq: 99941, offset: 800 });
            storage.getState().unloadSessionResources(id);
            expect(controller.signal.aborted).toBe(true);
            // Late socket events, page results and file reads must not revive released data.
            storage.getState().applyMessages(id, messages(id, 1));
            storage.getState().applySessionStream(id, { id: 'late', turnId: 'turn', text: 'late', updatedAt: 2 });
            storage.getState().applyMessagesLoaded(id);
            storage.getState().applyFileCache(id, '/late.txt', 'late body', null, false);
        }
        const state = storage.getState();
        expect(state.sessionMessages).toEqual({});
        expect(state.sessionStreams).toEqual({});
        expect(state.sessionFileCache).toEqual({});
        expect(state.sessionResourceAccess).toEqual({});
        expect(sessionResources.getStats()).toEqual({ sessions: 0, resources: 0 });
        expect(revoke).toHaveBeenCalledTimes(50);
        expect(state.sessionViewStates['s-49']).toMatchObject({ oldestSeq: 99921, newestSeq: 100000, wasLoaded: true, anchor: { seq: 99941, offset: 800 } });
        expect(state.sessions['s-49'].agentState?.requests?.approval.arguments).toEqual({});
        expect(state.sessions['s-49'].agentState?.completedRequests).toBeUndefined();
        storage.getState().touchSessionResources('s-49');
        storage.getState().applyMessages('s-49', messages('s-49'));
        expect(Object.keys(storage.getState().sessionMessages['s-49'].rawMessagesMap ?? {})).toHaveLength(80);
        revoke.mockRestore();
    });

    it('evicts the oldest session when the global retained byte budget is exhausted', () => {
        for (let index = 0; index < 10; index++) {
            const id = `hot-${index}`;
            storage.getState().touchSessionResources(id);
            storage.getState().applyMessages(id, messages(id));
        }
        const state = storage.getState();
        const retained = Object.keys(state.sessionMessages);
        const bytes = retained.reduce((sum, id) => sum + estimateRetainedBytes([state.sessionMessages[id], state.sessionStreams[id], state.sessionFileCache[id], state.sessionGitStatusFiles[id]]), 0);
        expect(bytes).toBeLessThanOrEqual(MAX_SESSION_CACHE_BYTES);
        expect(retained).toContain('hot-9');
        expect(retained).not.toContain('hot-0');
        expect(state.sessionViewStates['hot-0']).toMatchObject({ oldestSeq: 99921, newestSeq: 100000 });
    });

    it('deleting a session also releases registered resources and saved anchors', () => {
        storage.getState().applySessions([session('delete')]);
        storage.getState().saveSessionScrollAnchor('delete', { seq: 50, offset: 500 });
        const cleanup = vi.fn(); sessionResources.register('delete', cleanup);
        storage.getState().deleteSession('delete');
        expect(cleanup).toHaveBeenCalledTimes(1);
        expect(storage.getState().sessionViewStates.delete).toBeUndefined();
        expect(storage.getState().sessions.delete).toBeUndefined();
    });
});


it('preserves sleeping drafts persistently without pinning them in the session list or overwriting them from another session', () => {
    storage.getState().applySessions([session('one'), session('two')]);
    storage.getState().touchSessionResources('one');
    storage.getState().updateSessionDraft('one', 'unsent draft one');
    storage.getState().unloadSessionResources('one');
    expect(storage.getState().sessions.one.draft).toBeNull();
    expect(storage.getState().sessionsData?.filter((row) => typeof row !== 'string').every((row) => !row.draft)).toBe(true);
    storage.getState().touchSessionResources('two');
    storage.getState().updateSessionDraft('two', 'unsent draft two');
    expect(persisted.drafts).toEqual({ one: 'unsent draft one', two: 'unsent draft two' });
    storage.getState().touchSessionResources('one');
    expect(storage.getState().sessions.one.draft).toBe('unsent draft one');
});

it('restores saved choices for historical rows arriving after initial synchronization and keeps explicit default', () => {
    persisted.permission = { later: 'default' }; persisted.model = { later: 'custom-model' }; persisted.effort = { later: 'high' };
    storage.getState().applySessions([session('first')]);
    storage.getState().applySessions([session('later')]);
    expect(storage.getState().sessions.later).toMatchObject({ permissionMode: 'default', modelMode: 'custom-model', effortLevel: 'high' });
    storage.getState().updateSessionPermissionMode('later', 'default');
    storage.getState().applySessions([{ ...session('later'), metadataVersion: 2 }]);
    expect(storage.getState().sessions.later.permissionMode).toBe('default');
});
it('reprojects a later canonical configuration onto every replacement runtime without mutating prior state', () => {
    const child = { ...session('child'), conversationId: 'c', metadata: { conversationRootSessionId: 'root' } } as Session;
    const owner = { ...session('root'), conversationId: 'c', metadata: { executionConfiguration: { revision: 1, values: { effort: 'high' } } } } as Session;
    storage.getState().applySessions([child, owner]);
    const before = storage.getState().sessions.child;
    storage.getState().applySessions([{ ...owner, metadataVersion: 2, metadata: { executionConfiguration: { revision: 2, values: { effort: 'medium', permissionMode: 'read-only' } } } } as Session]);
    expect(before.effortLevel).toBe('high');
    expect(storage.getState().sessions.child).toMatchObject({ effortLevel: 'medium', permissionMode: 'read-only' });
});

it('merges a recovered submission across runtime rows by its durable input identity',()=>{
    const before={kind:'user-text',id:'old-row',createdAt:1,text:'question',meta:{codexInputId:'same'}} as any;
    const after={...before,id:'new-row',createdAt:2};
    expect(messageSignature(before)).toBe(messageSignature(after));
    expect(messageSignature({...after,meta:{codexInputId:'different'}})).not.toBe(messageSignature(before));
});
