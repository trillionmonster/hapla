import type { SessionViewState } from './sessionResources';

export const INITIAL_HISTORY_PAGE_SIZE = 80;
export const CATCHUP_HISTORY_PAGE_SIZE = 100;
export const LATEST_HISTORY_CURSOR = 2147483647;
export type ConversationHistoryCursor = { sessionId: string; before: number };

/** A read-only scan advances over raw events, including events hidden by Normal mode. */
export function advanceConversationHistoryCursor(
    sessionIds: readonly string[],
    cursor: ConversationHistoryCursor,
    sequences: readonly number[],
    hasMore: boolean,
): ConversationHistoryCursor | null {
    const index = sessionIds.indexOf(cursor.sessionId);
    if (index < 0 || !Number.isSafeInteger(cursor.before) || cursor.before <= 0) {
        throw new DOMException('History view changed', 'AbortError');
    }
    if (sequences.some(seq => !Number.isSafeInteger(seq) || seq <= 0)) throw new Error('历史记录返回了无效游标，请重试');
    const before = sequences.reduce((oldest, seq) => Math.min(oldest, seq), cursor.before);
    if (hasMore && before >= cursor.before) throw new Error('历史记录游标没有前进，请重试');
    if (sequences.some(seq => seq >= cursor.before)) throw new Error('历史记录超出了请求的分页范围，请重试');
    if (hasMore) return { sessionId: cursor.sessionId, before };
    return index + 1 < sessionIds.length ? { sessionId: sessionIds[index + 1], before: LATEST_HISTORY_CURSOR } : null;
}

/** Transport selection must not hide questions saved in another generation. */
export function conversationHistoryOrder<T extends { id: string; createdAt: number; lastUserMessageAt?: number | null }>(_currentSessionId: string, sessions: T[]): T[] {
    return [...sessions].sort((left, right) => {
        const question = (session: T) => Number.isFinite(session.lastUserMessageAt) && session.lastUserMessageAt! > 0 ? session.lastUserMessageAt! : 0;
        return question(right) - question(left) || right.createdAt - left.createdAt
            || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
    });
}

export const MAX_INITIAL_HISTORY_RUNTIMES = 8;

/** One bounded tail window may span several short or failed runtimes. */
export async function loadConversationHistoryWindow(
    sessionIds: readonly string[],
    load: (sessionId: string) => Promise<{ count: number; hasOlder: boolean }>,
    isCurrent: () => boolean,
): Promise<string[]> {
    const loaded: string[] = [];
    let count = 0;
    for (const id of sessionIds.slice(0, MAX_INITIAL_HISTORY_RUNTIMES)) {
        if (!isCurrent()) break;
        const page = await load(id);
        if (!isCurrent()) break;
        loaded.push(id);
        count += page.count;
        // Do not skip an unconsumed page in a long runtime. Normal mode's
        // viewport filler continues over hidden/tool events on demand.
        if (page.hasOlder || count >= INITIAL_HISTORY_PAGE_SIZE) break;
    }
    return loaded;
}

export function historyPagePath(sessionId: string, cursor: { before?: number; after?: number }): string {
    const forward = cursor.after !== undefined;
    return `/v3/sessions/${encodeURIComponent(sessionId)}/messages?${forward ? 'after_seq' : 'before_seq'}=${forward ? cursor.after : cursor.before ?? LATEST_HISTORY_CURSOR}&limit=${forward ? CATCHUP_HISTORY_PAGE_SIZE : INITIAL_HISTORY_PAGE_SIZE}`;
}

export function initialHistorySession(sessionIds: string[], views: Record<string, SessionViewState>, viewSessionId = sessionIds[0]): string | undefined {
    const anchor = views[viewSessionId]?.anchor;
    const source = anchor?.sourceSessionId ?? viewSessionId;
    return anchor && anchor.offset > 0 && sessionIds.includes(source) ? source : sessionIds[0];
}

export function olderHistorySession(
    sessionIds: string[], pages: Record<string, { hasOlder?: boolean } | undefined>,
): string | undefined {
    const index = sessionIds.reduce((last, id, index) => pages[id] !== undefined ? index : last, -1);
    if (index < 0) return sessionIds[0];
    return pages[sessionIds[index]]?.hasOlder ? sessionIds[index] : sessionIds[index + 1];
}
