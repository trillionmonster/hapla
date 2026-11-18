type QuestionOrderSession = { id: string; createdAt?: number; lastUserMessageAt?: number | null; questionFallbackCreatedAt?: number; questionOrderId?: string; conversationId?: string | null };

/** Only persisted user messages move a conversation. Runtime heartbeats,
 * assistant output, title changes and reconnects do not affect its position. */
export function sessionQuestionAt(session: Omit<QuestionOrderSession, 'id'>): number {
    return typeof session.lastUserMessageAt === 'number' && Number.isFinite(session.lastUserMessageAt) && session.lastUserMessageAt >= 0
        ? session.lastUserMessageAt
        : 0;
}

export function compareSessionQuestions(left: QuestionOrderSession, right: QuestionOrderSession): number {
    const leftKey = left.questionOrderId ?? left.conversationId ?? left.id;
    const rightKey = right.questionOrderId ?? right.conversationId ?? right.id;
    return sessionQuestionAt(right) - sessionQuestionAt(left)
        || (!sessionQuestionAt(left) && !sessionQuestionAt(right)
            ? (right.questionFallbackCreatedAt ?? right.createdAt ?? 0) - (left.questionFallbackCreatedAt ?? left.createdAt ?? 0) : 0)
        || (leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0);
}

export function visibleSessionsByQuestion<T extends QuestionOrderSession>(group: { onlineSessions: T[]; offlineSessions: T[] }, expanded: boolean): T[] {
    return [...group.onlineSessions, ...(expanded ? group.offlineSessions : [])].sort(compareSessionQuestions);
}

export function mergeSessionQuestionState(
    existing: { lastUserMessageAt?: number | null; lastUserMessageIndexedSeq?: number } | undefined,
    incoming: { lastUserMessageAt?: number | null; lastUserMessageIndexedSeq?: number },
): { lastUserMessageAt: number | null; lastUserMessageIndexedSeq: number } {
    const times = [existing?.lastUserMessageAt, incoming.lastUserMessageAt]
        .filter((value): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0);
    const sequences = [existing?.lastUserMessageIndexedSeq, incoming.lastUserMessageIndexedSeq]
        .filter((value): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0);
    return { lastUserMessageAt: times.length ? Math.max(...times) : null, lastUserMessageIndexedSeq: Math.max(0, ...sequences) };
}
