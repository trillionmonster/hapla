import type { NormalizedMessage } from './typesRaw';
import { estimateRetainedBytes } from './sessionResources';

export const MAX_ACTIVE_MESSAGE_EVENTS = 600;
export const MAX_MESSAGE_WINDOW_BYTES = 4 * 1024 * 1024;
export const MAX_SINGLE_MESSAGE_BYTES = 2 * 1024 * 1024;

function boundMessagePreview(message: NormalizedMessage): NormalizedMessage {
    if (estimateRetainedBytes(message) <= MAX_SINGLE_MESSAGE_BYTES) return message;
    let remainingChars = 700_000;
    let remainingNodes = 2048;
    const bound = (value: unknown): unknown => {
        if (typeof value === 'string') {
            const length = Math.min(value.length, Math.max(0, remainingChars));
            remainingChars -= length;
            return length === value.length ? value : value.slice(0, length) + '\n[预览已截断]';
        }
        if (!value || typeof value !== 'object') return value;
        if (remainingNodes-- <= 0) return Array.isArray(value) ? [] : {};
        if (Array.isArray(value)) return value.slice(0, Math.max(0, remainingNodes)).map(bound);
        return Object.fromEntries(Object.entries(value).slice(0, Math.max(0, remainingNodes)).map(([key, entry]) => [key, bound(entry)]));
    };
    return { ...message, content: bound(message.content) as NormalizedMessage['content'], meta: { ...message.meta, cacheTruncated: true } } as NormalizedMessage;
}

export function mergeMessageWindow(
    existing: Record<string, NormalizedMessage>,
    incoming: NormalizedMessage[],
    options: { replace?: boolean; keep?: 'newest' | 'oldest' } = {},
): { messages: NormalizedMessage[]; map: Record<string, NormalizedMessage>; trimmed: boolean; bytes: number } {
    const map = options.replace ? {} as Record<string, NormalizedMessage> : { ...existing };
    incoming.forEach((message) => { map[message.id] = boundMessagePreview(message); });
    let messages = Object.values(map).sort((left, right) => (
        typeof left.seq === 'number' && typeof right.seq === 'number'
            ? left.seq - right.seq || left.id.localeCompare(right.id)
            : left.createdAt - right.createdAt || left.id.localeCompare(right.id)
    ));
    let trimmed = messages.length > MAX_ACTIVE_MESSAGE_EVENTS;
    if (trimmed) {
        messages = options.keep === 'oldest'
            ? messages.slice(0, MAX_ACTIVE_MESSAGE_EVENTS)
            : messages.slice(-MAX_ACTIVE_MESSAGE_EVENTS);
    }
    let bytes = 0;
    const selected: NormalizedMessage[] = [];
    for (const message of options.keep === 'oldest' ? messages : [...messages].reverse()) {
        const size = estimateRetainedBytes(message);
        if (selected.length > 0 && bytes + size > MAX_MESSAGE_WINDOW_BYTES) { trimmed = true; break; }
        selected.push(message);
        bytes += size;
    }
    messages = options.keep === 'oldest' ? selected : selected.reverse();
    return {
        messages,
        map: Object.fromEntries(messages.map((message) => [message.id, message])),
        trimmed,
        bytes,
    };
}
