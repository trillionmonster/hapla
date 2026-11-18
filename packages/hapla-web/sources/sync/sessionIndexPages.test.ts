import { describe, expect, it, vi } from 'vitest';
import { forEachSessionIndexPage, SESSION_INDEX_PAGE_SIZE } from './sessionIndexPages';
import { compareSessionQuestions } from './sessionQuestionOrder';

describe('complete stable session index pagination', () => {
    it('loads folders beyond the former 150-session cap and orders globally by questions after stable ID pagination', async () => {
        const all = Array.from({ length: 173 }, (_, index) => ({ id: `session-${String(999-index)}`, createdAt: index, lastUserMessageAt: index === 172 ? 9999 : index }));
        const read = vi.fn(async (cursor: string | null, limit: number) => {
            const start = cursor ? Number(cursor.slice(7)) : 0;
            const end = Math.min(all.length, start + limit);
            return { sessions: all.slice(start, end), hasNext: end < all.length, nextCursor: end < all.length ? `cursor-${end}` : null };
        });
        const retained: typeof all = [];
        await forEachSessionIndexPage(read, async sessions => { retained.push(...sessions); });
        expect(read.mock.calls).toEqual([[null, 50], ['cursor-50', 50], ['cursor-100', 50], ['cursor-150', 50]]);
        expect(retained).toHaveLength(173);
        expect(retained.sort(compareSessionQuestions)[0].id).toBe(all[172].id);
    });

    it('consumes one bounded metadata page before requesting the next', async () => {
        let release!: () => void;
        const hold = new Promise<void>(resolve => { release = resolve; });
        const read = vi.fn(async (cursor: string | null) => ({ sessions: [cursor ?? 'first'], hasNext: !cursor, nextCursor: cursor ? null : 'next' }));
        const operation = forEachSessionIndexPage(read, async sessions => { if (sessions[0] === 'first') await hold; });
        await Promise.resolve();
        expect(read).toHaveBeenCalledTimes(1);
        release(); await operation;
        expect(read).toHaveBeenCalledTimes(2);
    });

    it('rejects repeated cursors and an oversized page rather than accumulating an unbounded response', async () => {
        await expect(forEachSessionIndexPage(async () => ({ sessions: ['one'], hasNext: true, nextCursor: 'same' }), async () => undefined)).rejects.toThrow('游标没有前进');
        await expect(forEachSessionIndexPage(async () => ({ sessions: new Array(SESSION_INDEX_PAGE_SIZE + 1).fill('one'), hasNext: false, nextCursor: null }), async () => undefined)).rejects.toThrow('分页无效');
    });
});
