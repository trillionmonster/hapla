import { describe, expect, it, vi } from 'vitest';
import { advanceConversationHistoryCursor, conversationHistoryOrder, historyPagePath, initialHistorySession, loadConversationHistoryWindow, LATEST_HISTORY_CURSOR, MAX_INITIAL_HISTORY_RUNTIMES, olderHistorySession } from './sessionHistory';

describe('bounded conversation history selection', () => {
    it('reads the newest saved question even when the route selects the original active transport', () => {
        const rows = [{ id: 'original', createdAt: 1, lastUserMessageAt: 10, updatedAt: 10000 },
            { id: 'retry', createdAt: 2, lastUserMessageAt: 20, updatedAt: 20 },
            { id: 'empty-retry', createdAt: 30, lastUserMessageAt: null, updatedAt: 30 }];
        const ids = conversationHistoryOrder('original', rows).map(item => item.id);
        expect(ids).toEqual(['retry', 'original', 'empty-retry']);
        expect(initialHistorySession(ids, {}, 'original')).toBe('retry');
        expect(olderHistorySession(ids, { retry: { hasOlder: false } })).toBe('original');
        expect(conversationHistoryOrder('retry', rows).map(item => item.id)).toEqual(ids);
        expect(conversationHistoryOrder('original', rows.map(row => ({ ...row, updatedAt: 50000 }))).map(item => item.id)).toEqual(ids);
    });

    it('uses immutable creation time and ID for equal or unknown question clocks', () => {
        expect(conversationHistoryOrder('old', [{ id: 'z', createdAt: 2 }, { id: 'old', createdAt: 1 }, { id: 'a', createdAt: 2 }]).map(row => row.id))
            .toEqual(['a', 'z', 'old']);
    });

    it('restores the route-owned scroll anchor even when another runtime owns the latest page', () => {
        const ids = ['retry', 'original'];
        const views = { original: { anchor: { sourceSessionId: 'original', offset: 500, seq: 100 } }, retry: { anchor: { offset: 0 } } };
        expect(initialHistorySession(ids, views, 'original')).toBe('original');
        expect(initialHistorySession(ids, views, 'retry')).toBe('retry');
        expect(initialHistorySession(ids, { original: { anchor: { sourceSessionId: 'other', offset: 500 } } }, 'original')).toBe('retry');
    });

    it('loads a saved older generation directly and pages with bounded cursors', () => {
        const ids = conversationHistoryOrder('resumed', [{ id: 'original', createdAt: 1 }, { id: 'resumed', createdAt: 3 }, { id: 'middle', createdAt: 2 }]).map(item => item.id);
        expect(ids).toEqual(['resumed', 'middle', 'original']);
        expect(initialHistorySession(ids, { resumed: { anchor: { sourceSessionId: 'original', seq: 50000, offset: 500 } } })).toBe('original');
        expect(historyPagePath('original', { before: 50041 })).toBe('/v3/sessions/original/messages?before_seq=50041&limit=80');
        expect(historyPagePath('resumed', { after: 100 })).toBe('/v3/sessions/resumed/messages?after_seq=100&limit=100');
    });

    it('advances a read-only scan by raw sequence without requiring visible content', () => {
        expect(advanceConversationHistoryCursor(['new', 'old'], { sessionId: 'new', before: 1000 }, [999, 925, 940], true))
            .toEqual({ sessionId: 'new', before: 925 });
    });

    it('moves to the next older runtime when the current runtime is exhausted', () => {
        expect(advanceConversationHistoryCursor(['new', 'middle', 'old'], { sessionId: 'new', before: 100 }, [3, 2, 1], false))
            .toEqual({ sessionId: 'middle', before: LATEST_HISTORY_CURSOR });
        expect(advanceConversationHistoryCursor(['new', 'middle', 'old'], { sessionId: 'middle', before: LATEST_HISTORY_CURSOR }, [], false))
            .toEqual({ sessionId: 'old', before: LATEST_HISTORY_CURSOR });
        expect(advanceConversationHistoryCursor(['new', 'old'], { sessionId: 'old', before: 10 }, [1], false)).toBeNull();
    });

    it.each([{ sequences: [] }, { sequences: [100] }, { sequences: [101] }])('rejects a nonadvancing page with hasMore rather than scanning forever', ({ sequences }) => {
        expect(() => advanceConversationHistoryCursor(['new'], { sessionId: 'new', before: 100 }, sequences, true)).toThrow('游标没有前进');
    });

    it('rejects invalid and out-of-range server sequences', () => {
        for (const sequences of [[NaN], [0], [-1], [1.5], [Number.MAX_SAFE_INTEGER + 1]]) {
            expect(() => advanceConversationHistoryCursor(['new'], { sessionId: 'new', before: 100 }, sequences, true)).toThrow('无效游标');
        }
        expect(() => advanceConversationHistoryCursor(['new'], { sessionId: 'new', before: 100 }, [99, 100], true)).toThrow('分页范围');
    });

    it('aborts cursors belonging to another conversation or an invalid position', () => {
        for (const cursor of [{ sessionId: 'other', before: 10 }, { sessionId: 'new', before: 0 }, { sessionId: 'new', before: Infinity }]) {
            expect(() => advanceConversationHistoryCursor(['new'], cursor, [], false)).toThrow(expect.objectContaining({ name: 'AbortError' }));
        }
    });
});

describe('initial conversation tail across runtime boundaries', () => {
    it('fills three one-message failed retries with an original runtime page, without loading its full history', async () => {
        const load = vi.fn(async (id: string) => ({ count: id === 'original' ? 80 : 1, hasOlder: id === 'original' }));
        const ids = ['retry-3', 'retry-2', 'retry-1', 'original', 'older'];
        expect(await loadConversationHistoryWindow(ids, load, () => true)).toEqual(ids.slice(0, 4));
        expect(load.mock.calls.map(([id]) => id)).toEqual(ids.slice(0, 4));
        // Exactly 83 raw events, not 329 from the original runtime and not 1.
        expect((await Promise.all(load.mock.results.map(result => result.value))).reduce((sum, page) => sum + page.count, 0)).toBe(83);
    });

    it('stops at one full page or an unconsumed page with only hidden events', async () => {
        for (const page of [{ count: 80, hasOlder: false }, { count: 0, hasOlder: true }]) {
            const load = vi.fn(async () => page);
            expect(await loadConversationHistoryWindow(['new', 'old'], load, () => true)).toEqual(['new']);
            expect(load).toHaveBeenCalledTimes(1);
        }
    });

    it('caps empty runtime requests and cancels before reading another generation', async () => {
        const empty = vi.fn(async () => ({ count: 0, hasOlder: false }));
        await loadConversationHistoryWindow(Array.from({ length: 100 }, (_, i) => String(i)), empty, () => true);
        expect(empty).toHaveBeenCalledTimes(MAX_INITIAL_HISTORY_RUNTIMES);
        let current = true;
        const cancelled = vi.fn(async () => { current = false; return { count: 1, hasOlder: false }; });
        expect(await loadConversationHistoryWindow(['new', 'old'], cancelled, () => current)).toEqual([]);
        expect(cancelled).toHaveBeenCalledTimes(1);
    });

    it('propagates a failed page instead of silently skipping saved questions', async () => {
        const load = vi.fn(async () => { throw new Error('offline'); });
        await expect(loadConversationHistoryWindow(['new', 'old'], load, () => true)).rejects.toThrow('offline');
        expect(load).toHaveBeenCalledTimes(1);
    });
});
