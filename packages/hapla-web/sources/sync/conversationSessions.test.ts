import { describe, expect, it } from 'vitest';
import type { Session } from './storageTypes';
import { collapseRuntimeSessions, getConversationRuntimeIds } from './conversationSessions';

function runtime(input: {
    id: string;
    createdAt: number;
    updatedAt: number;
    summary?: { text: string; updatedAt: number };
    name?: string;
}): Session {
    return {
        id: input.id,
        seq: 0,
        createdAt: input.createdAt,
        updatedAt: input.updatedAt,
        active: input.id === 'new-runtime',
        activeAt: input.updatedAt,
        metadata: {
            path: '/workspace/repeated-project',
            host: 'machine',
            flavor: 'codex',
            codexThreadId: 'thread-1',
            name: input.name,
            summary: input.summary,
        },
        metadataVersion: 1,
        agentState: null,
        agentStateVersion: 0,
        thinking: false,
        thinkingAt: 0,
        presence: input.id === 'new-runtime' ? 'online' : input.updatedAt,
    };
}

describe('collapseRuntimeSessions', () => {
    it('keeps the newest runtime state and the conversation title from an older runtime', () => {
        const collapsed = collapseRuntimeSessions([
            runtime({
                id: 'old-runtime',
                createdAt: 10,
                updatedAt: 20,
                name: 'repeated-project',
                summary: { text: 'Design the media workspace', updatedAt: 18 },
            }),
            runtime({ id: 'new-runtime', createdAt: 30, updatedAt: 40, name: 'repeated-project' }),
        ]);

        expect(collapsed).toHaveLength(1);
        expect(collapsed[0].id).toBe('new-runtime');
        expect(collapsed[0].presence).toBe('online');
        expect(collapsed[0].metadata?.summary?.text).toBe('Design the media workspace');
    });

    it('uses the most recently updated summary across runtime records', () => {
        const collapsed = collapseRuntimeSessions([
            runtime({
                id: 'old-runtime',
                createdAt: 10,
                updatedAt: 20,
                summary: { text: 'Initial task', updatedAt: 100 },
            }),
            runtime({
                id: 'new-runtime',
                createdAt: 30,
                updatedAt: 40,
                summary: { text: 'Current task', updatedAt: 200 },
            }),
        ]);

        expect(collapsed[0].metadata?.summary?.text).toBe('Current task');
    });
});

describe('getConversationRuntimeIds', () => {
    it('treats durable conversation ids as authoritative', () => {
        const left = runtime({ id: 'left', createdAt: 10, updatedAt: 10 });
        const right = runtime({ id: 'right', createdAt: 20, updatedAt: 20 });
        left.conversationId = 'conversation-a';
        right.conversationId = 'conversation-b';

        expect(getConversationRuntimeIds([left, right], left.id)).toEqual(['left']);
    });

    it('returns every runtime represented by one collapsed conversation row', () => {
        const oldRuntime = runtime({ id: 'old-runtime', createdAt: 10, updatedAt: 20 });
        const newRuntime = runtime({ id: 'new-runtime', createdAt: 30, updatedAt: 40 });
        const unrelated = runtime({ id: 'unrelated', createdAt: 50, updatedAt: 60 });
        unrelated.metadata = { ...unrelated.metadata!, codexThreadId: 'thread-2' };

        expect(getConversationRuntimeIds([oldRuntime, newRuntime, unrelated], 'new-runtime').sort()).toEqual([
            'new-runtime',
            'old-runtime',
        ]);
    });

    it('follows continuation links transitively', () => {
        const root = runtime({ id: 'root', createdAt: 10, updatedAt: 10 });
        root.metadata = { ...root.metadata!, codexThreadId: undefined };
        const middle = runtime({ id: 'middle', createdAt: 20, updatedAt: 20 });
        middle.metadata = {
            ...middle.metadata!,
            codexThreadId: undefined,
            continuedFromSessionId: 'root',
        };
        const leaf = runtime({ id: 'leaf', createdAt: 30, updatedAt: 30 });
        leaf.metadata = {
            ...leaf.metadata!,
            codexThreadId: undefined,
            continuedFromSessionId: 'middle',
        };

        expect(getConversationRuntimeIds([root, middle, leaf], 'root').sort()).toEqual([
            'leaf',
            'middle',
            'root',
        ]);
    });

    it('falls back to the requested id before session data is available', () => {
        expect(getConversationRuntimeIds([], 'pending-session')).toEqual(['pending-session']);
    });

    it('finds three runtimes separated by more than the home-screen window', () => {
        const recent = runtime({ id: 'recent-runtime', createdAt: 300, updatedAt: 300 });
        recent.metadata = { ...recent.metadata!, codexThreadId: 'thread-across-pages' };
        const previousDay = runtime({ id: 'previous-day-runtime', createdAt: 150, updatedAt: 150 });
        previousDay.metadata = { ...previousDay.metadata!, codexThreadId: 'thread-across-pages' };
        const oldest = runtime({ id: 'oldest-runtime', createdAt: 1, updatedAt: 1 });
        oldest.metadata = { ...oldest.metadata!, codexThreadId: 'thread-across-pages' };
        const unrelated = Array.from({ length: 200 }, (_, index) => {
            const session = runtime({
                id: `unrelated-${index}`,
                createdAt: 299 - index,
                updatedAt: 299 - index,
            });
            session.metadata = { ...session.metadata!, codexThreadId: `other-${index}` };
            return session;
        });

        expect(getConversationRuntimeIds(
            [recent, ...unrelated, previousDay, oldest],
            recent.id,
        ).sort()).toEqual(['oldest-runtime', 'previous-day-runtime', 'recent-runtime']);
    });
});
