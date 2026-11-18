import { MAX_ACTIVE_MESSAGE_EVENTS, MAX_MESSAGE_WINDOW_BYTES } from '@/sync/messageWindow';
import { estimateRetainedBytes } from '@/sync/sessionResources';
import { isVisibleChatMessage, type WebChatRow } from './webChatRows';
import { isFileArtifactMessage } from './artifactTimeline';

export type NormalChatWindowOptions = {
    keep: 'oldest' | 'newest';
    /** Optional smaller budgets; callers cannot raise the shared hard limits. */
    maxRows?: number;
    maxBytes?: number;
};

const TRUNCATED = '\n\n[消息过长，预览已截断]';

function budget(value: number | undefined, maximum: number): number {
    if (value === undefined) return maximum;
    if (!Number.isSafeInteger(value) || value < 0) throw new RangeError('Chat window budgets must be non-negative safe integers');
    return Math.min(value, maximum);
}

/** Keep useful text without retaining oversized attachments, metadata or payloads. */
function compactTextRow(row: WebChatRow, available: number): WebChatRow | null {
    const message = row.message;
    if (message.kind !== 'user-text' && message.kind !== 'agent-text') return null;
    const minimal: WebChatRow = {
        key: row.key, sourceSessionId: row.sourceSessionId, rawId: row.rawId, seq: row.seq,
        message: {
            kind: message.kind, id: message.id, localId: message.localId, createdAt: message.createdAt,
            text: TRUNCATED,
            ...(message.kind === 'agent-text' ? { isThinking: message.isThinking } : {}),
            meta: {
                cacheTruncated: true,
                ...(message.meta?.reasoningSummary ? { reasoningSummary: true } : {}),
                ...(message.meta?.branchId ? { branchId: message.meta.branchId } : {}),
            },
        },
    };
    const overhead = estimateRetainedBytes(minimal);
    if (overhead > available) return null;
    const text = message.kind === 'user-text' ? message.displayText ?? message.text : message.text;
    let prefix = text.slice(0, Math.max(0, Math.floor((available - overhead) / 2)));
    // Do not leave half of an astral character at the truncation boundary.
    if (/[\uD800-\uDBFF]$/.test(prefix)) prefix = prefix.slice(0, -1);
    return { ...minimal, message: { ...minimal.message, text: prefix + TRUNCATED } as typeof message };
}

/**
 * Retain visible conversation context while the raw protocol window moves.
 * Keys must come from WebChatRowIdentity with the retained rows included: raw
 * IDs alone cannot distinguish multiple text blocks in one protocol event.
 * Historical tool/permission cards are never retained after leaving incoming.
 */
export function mergeNormalChatWindow(
    previous: readonly WebChatRow[],
    incoming: readonly WebChatRow[],
    options: NormalChatWindowOptions = { keep: 'newest' },
): { rows: WebChatRow[]; trimmed: boolean } {
    const maxRows = budget(options.maxRows, MAX_ACTIVE_MESSAGE_EVENTS);
    const maxBytes = budget(options.maxBytes, MAX_MESSAGE_WINDOW_BYTES);
    const merged = new Map<string, WebChatRow>();
    for (const row of previous) {
        if ((row.message.kind !== 'tool-call' || isFileArtifactMessage(row.message)) && isVisibleChatMessage(row.message, 'normal')) merged.set(row.key, row);
    }
    for (const row of incoming) {
        if (isVisibleChatMessage(row.message, 'normal')) merged.set(row.key, row);
        else merged.delete(row.key);
    }
    const ordered = [...merged.values()].map((row, index) => ({ row, index })).sort((left, right) => {
        const time = left.row.message.createdAt - right.row.message.createdAt;
        const source = left.row.sourceSessionId.localeCompare(right.row.sourceSessionId);
        const leftSeq = typeof left.row.seq === 'number' && Number.isFinite(left.row.seq) ? left.row.seq : Number.MAX_SAFE_INTEGER;
        const rightSeq = typeof right.row.seq === 'number' && Number.isFinite(right.row.seq) ? right.row.seq : Number.MAX_SAFE_INTEGER;
        return time || source || leftSeq - rightSeq || left.index - right.index;
    }).map(({ row }) => row);
    const candidates = options.keep === 'oldest' ? ordered : ordered.slice().reverse();
    const selected: WebChatRow[] = [];
    let bytes = estimateRetainedBytes(selected);
    let trimmed = false;
    for (const original of candidates) {
        if (selected.length >= maxRows) { trimmed = true; break; }
        let row = original;
        let size = estimateRetainedBytes(row);
        if (size + estimateRetainedBytes([]) > maxBytes) {
            // Never exempt the first row from the byte ceiling. Text gets an
            // explicit bounded preview; oversized non-text cards are omitted
            // with trimmed=true rather than fabricating an approval or media.
            trimmed = true;
            const compact = compactTextRow(row, Math.max(0, maxBytes - bytes));
            if (!compact) continue;
            row = compact;
            size = estimateRetainedBytes(row);
        }
        if (bytes + size > maxBytes) { trimmed = true; break; }
        selected.push(row);
        bytes += size;
    }
    return { rows: options.keep === 'oldest' ? selected : selected.reverse(), trimmed };
}
