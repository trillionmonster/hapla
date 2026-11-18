import type { RawJSONLines } from '@/claude/types';

export type MessageUploadRole = 'user' | 'agent' | 'system';

/** Only classify authorship that is known before encryption. */
export function messageUploadRole(content: unknown): MessageUploadRole | undefined {
    if (!content || typeof content !== 'object') return undefined;
    const value = content as { role?: unknown; content?: { role?: unknown; subagent?: unknown } };
    if (value.role === 'agent' || value.role === 'system') return value.role;
    if (value.role === 'session') {
        if (value.content?.role === 'agent' || value.content?.role === 'system') return value.content.role;
        if (value.content?.role === 'user' && value.content.subagent) return 'system';
    }
    // A user-shaped provider record can be replayed history, a web prompt echo,
    // or compaction. It requires a separate live-human check before promotion.
    return undefined;
}

export function claudePromptUploadRole(message: RawJSONLines, clientStartedAt: number, liveLocalLog: boolean): MessageUploadRole | undefined {
    if (message.type !== 'user') return undefined;
    if (message.isSidechain || message.isMeta || message.isCompactSummary || message.isSynthetic) return 'system';
    const text = message.message.content;
    if (typeof text !== 'string' || !text.trim()) return undefined;
    if (/^This session is being continued from a previous conversation/i.test(text.trim())) return 'system';
    // SDK user messages echo a prompt already persisted by the web client. Its
    // synthetic conversion timestamp must not move the conversation again.
    if (!liveLocalLog) return 'system';
    const originalTime = typeof message.timestamp === 'string' ? Date.parse(message.timestamp) : NaN;
    if (!Number.isFinite(originalTime) || originalTime < clientStartedAt || originalTime > Date.now() + 60_000) return undefined;
    return 'user';
}
