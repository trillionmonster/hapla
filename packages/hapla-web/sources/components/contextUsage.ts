export type ContextUsage = { usedTokens: number; contextWindow: number | null; model?: string; threadId?: string };
export function contextRemaining(usedTokens: number, contextWindow?: number | null): number | null {
    if (!Number.isFinite(usedTokens) || usedTokens < 0 || typeof contextWindow !== 'number' || !Number.isFinite(contextWindow) || contextWindow <= 0) return null;
    return Math.max(0, Math.min(100, 100 * (1 - usedTokens / contextWindow)));
}

export function activeContextUsage(usage: ContextUsage | null | undefined, model?: string, threadId?: string): ContextUsage | null {
    if (!usage || (usage.model && model && model !== 'default' && usage.model !== model) || (usage.threadId && threadId && usage.threadId !== threadId)) return null;
    return usage;
}
