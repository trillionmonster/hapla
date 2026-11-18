import { describe, expect, it } from 'vitest';
import { MAX_ACTIVE_MESSAGE_EVENTS, MAX_MESSAGE_WINDOW_BYTES, MAX_SINGLE_MESSAGE_BYTES, mergeMessageWindow } from './messageWindow';
import type { NormalizedMessage } from './typesRaw';
import { estimateRetainedBytes } from './sessionResources';

function messages(count: number): NormalizedMessage[] {
    return Array.from({ length: count }, (_, index) => ({
        id: `message-${String(index).padStart(4, '0')}`,
        localId: null,
        createdAt: index,
        isSidechain: false,
        seq: index + 1,
        role: 'user' as const,
        content: { type: 'text' as const, text: `message ${index}` },
    }));
}

describe('mergeMessageWindow', () => {
    it('keeps only the newest 600 events from a 2000-event conversation', () => {
        const result = mergeMessageWindow({}, messages(2000));
        expect(result.trimmed).toBe(true);
        expect(result.messages).toHaveLength(MAX_ACTIVE_MESSAGE_EVENTS);
        expect(result.messages[0]?.seq).toBe(1401);
        expect(result.messages.at(-1)?.seq).toBe(2000);
    });

    it('keeps the older edge while paging into history', () => {
        const current = Object.fromEntries(messages(600).map((message) => [message.id, { ...message, seq: message.seq! + 80 }]));
        const older = messages(80).map((message, index) => ({ ...message, id: `older-${index}`, createdAt: index - 80, seq: index + 1 }));
        const result = mergeMessageWindow(current, older, { keep: 'oldest' });
        expect(result.messages).toHaveLength(MAX_ACTIVE_MESSAGE_EVENTS);
        expect(result.messages[0]?.id).toBe('older-0');
        expect(result.messages.at(-1)?.createdAt).toBe(519);
    });

    it('deduplicates updates by stable message id', () => {
        const original = messages(3);
        const result = mergeMessageWindow(
            Object.fromEntries(original.map((message) => [message.id, message])),
            [{ ...original[1]!, role: 'user', content: { type: 'text', text: 'updated' } }],
        );
        expect(result.messages).toHaveLength(3);
        expect(result.map['message-0001']?.content).toEqual({ type: 'text', text: 'updated' });
    });

    it('replays persisted events in authoritative sequence order even when timestamps tie or regress', () => {
        const events = messages(3).map((message, index) => ({ ...message, createdAt: 100 - index }));
        const result = mergeMessageWindow({}, events.reverse());
        expect(result.messages.map((message) => message.seq)).toEqual([1, 2, 3]);
    });
});


describe('message window byte limits', () => {
    it('keeps a contiguous newest or oldest byte window below the event cap', () => {
        const large = messages(100).map((message) => ({ ...message, role: 'user' as const, content: { type: 'text' as const, text: 'x'.repeat(60000) } }));
        const newest = mergeMessageWindow({}, large);
        const oldest = mergeMessageWindow({}, large, { keep: 'oldest' });
        expect(newest.bytes).toBeLessThanOrEqual(MAX_MESSAGE_WINDOW_BYTES);
        expect(oldest.bytes).toBeLessThanOrEqual(MAX_MESSAGE_WINDOW_BYTES);
        expect(newest.messages.at(-1)?.seq).toBe(100);
        expect(oldest.messages[0]?.seq).toBe(1);
        expect(newest.messages.length).toBeLessThan(40);
        expect(newest.trimmed).toBe(true);
    });

    it('bounds a single oversized preview without changing its cursor or message identity', () => {
        const original = { ...messages(1)[0], role: 'user' as const, content: { type: 'text' as const, text: 'x'.repeat(3000000) } };
        const message = mergeMessageWindow({}, [original]).messages[0];
        expect(estimateRetainedBytes(message)).toBeLessThan(MAX_SINGLE_MESSAGE_BYTES);
        expect(message).toMatchObject({ id: original.id, seq: original.seq, meta: { cacheTruncated: true } });
        expect((message.content as { text: string }).text).toContain('[预览已截断]');
        expect(original.content.text.length).toBe(3000000);
    });
});
