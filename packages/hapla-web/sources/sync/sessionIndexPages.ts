export const SESSION_INDEX_PAGE_SIZE = 50;

/** Keep the transport's stable ID cursor; sort only after records reach the
 * shared folder model. A busy runtime must not crowd older folders out. */
export async function forEachSessionIndexPage<T>(
    fetchPage: (cursor: string | null, limit: number) => Promise<{ sessions: T[]; hasNext: boolean; nextCursor: string | null }>,
    consume: (sessions: T[]) => Promise<void>,
): Promise<void> {
    let cursor: string | null = null;
    const seen = new Set<string>();
    while (true) {
        const page = await fetchPage(cursor, SESSION_INDEX_PAGE_SIZE);
        if (!Array.isArray(page.sessions) || page.sessions.length > SESSION_INDEX_PAGE_SIZE) throw new Error('会话索引分页无效，请重试');
        await consume(page.sessions);
        if (!page.hasNext) return;
        if (!page.nextCursor || seen.has(page.nextCursor) || page.sessions.length === 0) throw new Error('会话索引游标没有前进，请重试');
        seen.add(page.nextCursor);
        cursor = page.nextCursor;
    }
}
