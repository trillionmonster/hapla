import { describe, expect, it, vi } from 'vitest';
import type { ApiMessage } from './apiTypes';
import { isUserQuestionRecord, QUESTION_BACKFILL_CONCURRENCY, QUESTION_BACKFILL_PAGE_SIZE, QUESTION_BACKFILL_REQUEST_TIMEOUT_MS, SessionQuestionBackfill } from './sessionQuestionBackfill';
import { mergeSessionQuestionState } from './sessionQuestionOrder';

const user = { role: 'user', content: { type: 'text', text: 'A real question' } };
const agent = { role: 'agent', content: { type: 'output', data: { type: 'assistant' } } };
const message = (seq: number): ApiMessage => ({ id: `message-${seq}`, seq, localId: null, content: { t: 'encrypted', c: 'opaque-ciphertext' }, createdAt: seq * 1000, updatedAt: seq * 1000 });
const defer = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; };

describe('actual question recognition without rendering historical content', () => {
    it.each([
        user,
        { role: 'user', content: { type: 'multimodal', parts: [{ type: 'image', source: { data: 'opaque' } }] } },
        { role: 'session', content: { type: 'session', data: { role: 'user', ev: { t: 'text', text: 'question' } } } },
        { role: 'session', content: { role: 'user', ev: { t: 'text', text: 'question' } } },
        { role: 'user', id: 'legacy', time: 123, ev: { t: 'text', text: 'question' } },
        { role: 'agent', content: { type: 'output', data: { type: 'user', message: { content: 'CLI question' } } } },
        { role: 'agent', content: { type: 'output', data: { type: 'user', uuid: 'claude-question', parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'text', text: '请描述这张图' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'opaque' } }] } } } },
        { role: 'agent', content: { type: 'output', data: { type: 'user', message: { role: 'user', content: [{ type: 'image', source: { type: 'url', url: 'https://example.com/image.png' } }] } } } },
    ])('recognizes a supported user question: %j', record => expect(isUserQuestionRecord(record)).toBe(true));

    it.each([
        agent, null, {}, { role: 'user', content: { type: 'tool-result', text: 'tool output' } },
        { role: 'session', content: { role: 'agent', ev: { t: 'text', text: 'answer' } } },
        { role: 'session', content: { role: 'user', subagent: 'worker', ev: { t: 'text', text: 'delegated prompt' } } },
        { role: 'agent', content: { type: 'output', data: { type: 'user', message: { content: [{ type: 'tool_result', content: 'output' }] } } } },
        { role: 'agent', content: { type: 'output', data: { type: 'user', isSidechain: true, message: { content: 'subagent prompt' } } } },
        { role: 'agent', content: { type: 'output', data: { type: 'user', isCompactSummary: true, message: { content: 'summary replay' } } } },
        { ...user, meta: { isReplay: true } },
        { ...user, meta: { messageRole: 'agent' } },
        { ...user, meta: { messageRole: 'system' } },
        { role: 'agent', content: { type: 'output', data: { type: 'user', isSynthetic: true, message: { content: 'synthetic prompt' } } } },
        { role: 'agent', content: { type: 'output', data: { type: 'user', message: { content: 'This session is being continued from a previous conversation that ran out of context.' } } } },
        { role: 'agent', content: { type: 'output', data: { type: 'user', toolUseResult: { result: 'done' }, message: { content: [{ type: 'text', text: 'tool output' }] } } } },
        { role: 'agent', content: { type: 'output', data: { type: 'user', message: { content: [{ type: 'text', text: 'tool output' }, { type: 'tool_result', tool_use_id: 'tool-1', content: 'result' }] } } } },
        { role: 'agent', content: { type: 'output', data: { type: 'user', message: { content: [{ type: 'text', text: 'tool output' }, { type: 'tool-result', content: 'result' }] } } } },
    ])('ignores agent, tool, subagent and replay records: %j', record => expect(isUserQuestionRecord(record)).toBe(false));
});

describe('bounded background last-question indexing', () => {
    it('scans newest first across bounded pages and persists the original message ID without publishing any UI messages', async () => {
        const fetchPage = vi.fn(async (_id, before, limit) => ({ messages: Array.from({ length: Math.min(limit, before - 1) }, (_, index) => message(before - 1 - index)), hasMore: before > limit + 1 }));
        const decrypt = vi.fn(async (_id, record) => record.seq === 8 ? user : agent);
        const save = vi.fn(async () => undefined);
        const indexer = new SessionQuestionBackfill({ fetchPage, decrypt, save, isCurrent: () => true });
        indexer.enqueue([{ id: 'offline-session', seq: 45, indexedThroughSeq: 0 }]);
        await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(1));
        expect(fetchPage.mock.calls.map(call => call.slice(0, 3))).toEqual([
            ['offline-session', 46, QUESTION_BACKFILL_PAGE_SIZE], ['offline-session', 26, QUESTION_BACKFILL_PAGE_SIZE],
        ]);
        expect(decrypt.mock.calls.map(([, record]) => record.seq)).toEqual(Array.from({ length: 38 }, (_, index) => 45 - index));
        expect(save).toHaveBeenCalledWith('offline-session', { messageId: 'message-8', scannedThroughSeq: 45 }, expect.any(AbortSignal));
        expect(indexer.getStats()).toEqual({ queued: 0, running: 0 });
    });

    it('fetches/decrypts at most two session pages concurrently, regardless of the number of collapsed folders', async () => {
        const pending = new Map<string, ReturnType<typeof defer<{ messages: ApiMessage[]; hasMore: boolean }>>>();
        const fetchPage = vi.fn((id: string) => { const held = defer<{ messages: ApiMessage[]; hasMore: boolean }>(); pending.set(id, held); return held.promise; });
        const save = vi.fn(async () => undefined);
        const indexer = new SessionQuestionBackfill({ fetchPage, save, decrypt: async () => user, isCurrent: () => true });
        indexer.enqueue(Array.from({ length: 30 }, (_, index) => ({ id: `offline-${index}`, seq: 1, indexedThroughSeq: 0 })));
        expect(fetchPage).toHaveBeenCalledTimes(QUESTION_BACKFILL_CONCURRENCY);
        expect(indexer.getStats()).toEqual({ queued: 28, running: 2 });
        pending.get('offline-0')!.resolve({ messages: [message(1)], hasMore: false });
        await vi.waitFor(() => expect(fetchPage).toHaveBeenCalledTimes(3));
        expect(indexer.getStats()).toEqual({ queued: 27, running: 2 });
        indexer.stop();
        for (const held of pending.values()) held.resolve({ messages: [], hasMore: false });
        await vi.waitFor(() => expect(indexer.getStats()).toEqual({ queued: 0, running: 0 }));
    });

    it('marks an all-agent/empty history scanned and avoids rescanning it during heartbeat refreshes', async () => {
        const fetchPage = vi.fn(async () => ({ messages: [message(3), message(2), message(1)], hasMore: false }));
        const save = vi.fn(async () => undefined);
        const indexer = new SessionQuestionBackfill({ fetchPage, save, decrypt: async () => agent, isCurrent: () => true });
        indexer.enqueue([{ id: 'session', seq: 3, indexedThroughSeq: 0 }]);
        await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(1));
        expect(save).toHaveBeenCalledWith('session', { messageId: null, scannedThroughSeq: 3 }, expect.any(AbortSignal));
        indexer.enqueue([{ id: 'session', seq: 3, indexedThroughSeq: 0 }]);
        indexer.enqueue([{ id: 'session', seq: 3, indexedThroughSeq: 3 }]);
        expect(fetchPage).toHaveBeenCalledTimes(1);
    });

    it('stops at the previous persisted watermark when only new agent records need indexing', async () => {
        const decrypt = vi.fn(async () => agent);
        const save = vi.fn(async () => undefined);
        const indexer = new SessionQuestionBackfill({ fetchPage: async () => ({ messages: [message(25), message(24), message(23)], hasMore: true }), save, decrypt, isCurrent: () => true });
        indexer.enqueue([{ id: 'session', seq: 25, indexedThroughSeq: 24 }]);
        await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(1));
        expect(decrypt).toHaveBeenCalledTimes(1);
        expect(save).toHaveBeenCalledWith('session', { messageId: null, scannedThroughSeq: 25 }, expect.any(AbortSignal));
    });

    it('never persists a guessed timestamp or an unreadable/decryption-failed history', async () => {
        const decrypt = vi.fn(async () => null);
        const save = vi.fn(async () => undefined);
        const fetchPage = vi.fn(async () => ({ messages: [message(1)], hasMore: false }));
        const indexer = new SessionQuestionBackfill({ fetchPage, save, decrypt, isCurrent: () => true });
        indexer.enqueue([{ id: 'session', seq: 1 }]);
        await vi.waitFor(() => expect(indexer.getStats().running).toBe(0));
        expect(save).not.toHaveBeenCalled();
        indexer.enqueue([{ id: 'session', seq: 1 }]);
        expect(fetchPage).toHaveBeenCalledTimes(1);
    });

    it('aborts history reads on account changes and does not apply their late results', async () => {
        const held = defer<{ messages: ApiMessage[]; hasMore: boolean }>();
        const save = vi.fn(async () => undefined);
        const decrypt = vi.fn(async () => user);
        const fetchPage = vi.fn((_id, _before, _limit, _signal: AbortSignal) => held.promise);
        const indexer = new SessionQuestionBackfill({ fetchPage, save, decrypt, isCurrent: () => true });
        indexer.enqueue([{ id: 'old-account-session', seq: 1 }]);
        indexer.stop();
        expect(fetchPage.mock.calls[0][3].aborted).toBe(true);
        held.resolve({ messages: [message(1)], hasMore: false });
        await vi.waitFor(() => expect(indexer.getStats().running).toBe(0));
        expect(decrypt).not.toHaveBeenCalled();
        expect(save).not.toHaveBeenCalled();
    });

    it('aborts stalled network requests after 15 seconds so one broken history cannot block every other folder', async () => {
        vi.useFakeTimers();
        const fetchPage = vi.fn((_id, _before, _limit, _signal: AbortSignal) => new Promise<{ messages: ApiMessage[]; hasMore: boolean }>(() => undefined));
        const indexer = new SessionQuestionBackfill({ fetchPage, save: async () => undefined, decrypt: async () => user, isCurrent: () => true });
        try {
            indexer.enqueue(Array.from({ length: 4 }, (_, i) => ({ id: `session-${i}`, seq: 1 })));
            expect(fetchPage).toHaveBeenCalledTimes(2);
            await vi.advanceTimersByTimeAsync(QUESTION_BACKFILL_REQUEST_TIMEOUT_MS);
            expect(fetchPage.mock.calls[0][3].aborted).toBe(true);
            expect(fetchPage.mock.calls[1][3].aborted).toBe(true);
            expect(fetchPage).toHaveBeenCalledTimes(4);
        } finally { indexer.stop(); await vi.advanceTimersByTimeAsync(0); vi.useRealTimers(); }
    });

    it.each(['oversize', 'stalled'])('rejects a %s history page instead of building an unbounded message cache', async problem => {
        const save = vi.fn(async () => undefined);
        const indexer = new SessionQuestionBackfill({
            fetchPage: async () => ({ messages: problem === 'oversize' ? Array.from({ length: 21 }, (_, i) => message(21-i)) : [], hasMore: true }),
            decrypt: async () => agent, save, isCurrent: () => true,
        });
        indexer.enqueue([{ id: 'session', seq: 21 }]);
        await vi.waitFor(() => expect(indexer.getStats().running).toBe(0));
        expect(save).not.toHaveBeenCalled();
    });
});

describe('persisted question clocks across stale refresh responses', () => {
    it('does not roll back the last question or scan watermark when an older response finishes later', () => {
        expect(mergeSessionQuestionState({ lastUserMessageAt: 200, lastUserMessageIndexedSeq: 20 }, { lastUserMessageAt: 100, lastUserMessageIndexedSeq: 10 }))
            .toEqual({ lastUserMessageAt: 200, lastUserMessageIndexedSeq: 20 });
        expect(mergeSessionQuestionState({ lastUserMessageAt: 200, lastUserMessageIndexedSeq: 20 }, { lastUserMessageAt: null }))
            .toEqual({ lastUserMessageAt: 200, lastUserMessageIndexedSeq: 20 });
    });
});
