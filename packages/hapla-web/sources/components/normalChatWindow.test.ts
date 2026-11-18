import { describe, expect, it } from 'vitest';
import type { Message, ToolCallMessage } from '@/sync/typesMessage';
import { estimateRetainedBytes } from '@/sync/sessionResources';
import { MAX_ACTIVE_MESSAGE_EVENTS, MAX_MESSAGE_WINDOW_BYTES } from '@/sync/messageWindow';
import { mergeNormalChatWindow } from './normalChatWindow';
import type { WebChatRow } from './webChatRows';

function textRow(index: number, text = `Message ${index}`): WebChatRow {
    return {
        key: `row-${index}`, sourceSessionId: 'session', rawId: `raw-${index}`, seq: index,
        message: { kind: 'agent-text', id: `message-${index}`, localId: null, createdAt: index, text },
    };
}

function toolRow(index: number, pending = false): WebChatRow {
    return {
        key: `tool-${index}`, sourceSessionId: 'session', rawId: `raw-tool-${index}`, seq: index,
        message: {
            kind: 'tool-call', id: `tool-message-${index}`, localId: null, createdAt: index, children: [],
            tool: { name: 'Bash', input: { command: 'true' }, state: 'completed', createdAt: index,
                startedAt: index, completedAt: index + 1, description: null,
                permission: { id: `permission-${index}`, status: pending ? 'pending' : 'approved' } },
        },
    };
}

const keys = (rows: WebChatRow[]) => rows.map(row => row.key);

describe('Normal conversation projection window', () => {
    it('keeps visible conversation across more than 600 hidden protocol rows', () => {
        const context = [textRow(1), textRow(2)];
        const incoming = [...Array.from({ length: 900 }, (_, index) => toolRow(index + 3)), textRow(1000)];
        const result = mergeNormalChatWindow(context, incoming);
        expect(keys(result.rows)).toEqual(['row-1', 'row-2', 'row-1000']);
        expect(result.trimmed).toBe(false);
        const next = mergeNormalChatWindow(result.rows, [textRow(1001)]);
        expect(keys(next.rows)).toEqual(['row-1', 'row-2', 'row-1000', 'row-1001']);
    });

    it('updates stable identities and removes a row that becomes invisible', () => {
        const original = textRow(1);
        const updated = textRow(1, 'Updated answer');
        expect(mergeNormalChatWindow([original], [updated]).rows).toEqual([updated]);
        expect((original.message as { text: string }).text).toBe('Message 1');
        expect(mergeNormalChatWindow([original], [textRow(1, '  ')]).rows).toEqual([]);
        const thinking = { ...updated, message: { ...updated.message, isThinking: true } as Message };
        expect(mergeNormalChatWindow([updated], [thinking]).rows).toEqual([]);
    });

    it('preserves distinct text blocks sharing a raw event and identical text', () => {
        const first = { ...textRow(1, 'Same text'), rawId: 'shared-raw', seq: 5 };
        const second = { ...textRow(2, 'Same text'), rawId: 'shared-raw', seq: 5, message: { ...textRow(2, 'Same text').message, createdAt: 1 } };
        const updatedSecond = { ...second, message: { ...second.message, text: 'Updated second block' } as Message };
        const result = mergeNormalChatWindow([first, second], [updatedSecond]);
        expect(keys(result.rows)).toEqual(['row-1', 'row-2']);
        expect(result.rows[1]).toBe(updatedSecond);
    });

    it('only shows tool and permission cards that remain in the current raw projection', () => {
        const retained = [textRow(1), toolRow(2, true)];
        expect(keys(mergeNormalChatWindow(retained, [textRow(3)]).rows)).toEqual(['row-1', 'row-3']);
        expect(keys(mergeNormalChatWindow(retained, [toolRow(2, true)]).rows)).toEqual(['row-1', 'tool-2']);
        expect(keys(mergeNormalChatWindow(retained, [toolRow(2, false)]).rows)).toEqual(['row-1']);
    });

    it('retains file artifacts after the raw window advances, while dropping stale approval tools', () => {
        const file = toolRow(2);
        (file.message as ToolCallMessage).tool = { ...(file.message as ToolCallMessage).tool, name: 'file', input: { ref: '/work/report.html' } };
        const result = mergeNormalChatWindow([textRow(1), file, toolRow(3, true)], [textRow(4)]);
        expect(keys(result.rows)).toEqual(['row-1', 'tool-2', 'row-4']);
    });

    it('orders by creation time and source-local sequence while preserving block order within one event', () => {
        const sameTime = (index: number, seq: number): WebChatRow => ({ ...textRow(index), seq, message: { ...textRow(index).message, createdAt: 10 } });
        const firstBlock = sameTime(3, 3);
        const secondBlock = sameTime(4, 3);
        const result = mergeNormalChatWindow([sameTime(2, 2)], [firstBlock, secondBlock, sameTime(1, 1), textRow(20)]);
        expect(keys(result.rows)).toEqual(['row-1', 'row-2', 'row-3', 'row-4', 'row-20']);
    });

    it.each(['oldest', 'newest'] as const)('keeps the requested %s edge under the row budget', (keep) => {
        const previous = [textRow(2), textRow(3)];
        const incoming = [textRow(1), textRow(4), textRow(5)];
        const result = mergeNormalChatWindow(previous, incoming, { keep, maxRows: 2 });
        expect(keys(result.rows)).toEqual(keep === 'oldest' ? ['row-1', 'row-2'] : ['row-4', 'row-5']);
        expect(result.trimmed).toBe(true);
    });

    it.each(['oldest', 'newest'] as const)('also enforces the byte budget while retaining the %s edge', (keep) => {
        const rows = [textRow(1, 'x'.repeat(100)), textRow(2, 'x'.repeat(100)), textRow(3, 'x'.repeat(100))];
        const maxBytes = estimateRetainedBytes([]) + estimateRetainedBytes(rows[0]) * 2;
        const result = mergeNormalChatWindow([], rows, { keep, maxBytes });
        expect(keys(result.rows)).toEqual(keep === 'oldest' ? ['row-1', 'row-2'] : ['row-2', 'row-3']);
        expect(estimateRetainedBytes(result.rows)).toBeLessThanOrEqual(maxBytes);
        expect(result.trimmed).toBe(true);
    });

    it('bounds a single oversized text with a visible marker and removes bulky ancillary data', () => {
        const original: WebChatRow = {
            ...textRow(1),
            message: { kind: 'user-text', id: 'user', localId: null, createdAt: 1,
                text: 'a'.repeat(20_000), displayText: '😀'.repeat(10_000), images: [{ mediaType: 'image/png', data: 'b'.repeat(20_000) }] },
        };
        const result = mergeNormalChatWindow([], [original], { keep: 'newest', maxBytes: 4096 });
        expect(result.rows).toHaveLength(1);
        expect(result.rows[0].key).toBe(original.key);
        expect(result.rows[0].message.kind).toBe('user-text');
        expect((result.rows[0].message as { text: string }).text).toMatch(/^😀.*\[消息过长，预览已截断\]$/s);
        expect(result.rows[0].message.meta?.cacheTruncated).toBe(true);
        expect('images' in result.rows[0].message).toBe(false);
        expect(estimateRetainedBytes(result.rows)).toBeLessThanOrEqual(4096);
        expect(result.trimmed).toBe(true);
        expect((original.message as { text: string }).text).toHaveLength(20_000);
    });

    it('does not bypass the byte limit or fabricate an approval for an oversized tool', () => {
        const tool = toolRow(1, true);
        (tool.message as ToolCallMessage).tool.input = { command: 'sensitive '.repeat(1000) };
        const result = mergeNormalChatWindow([], [tool], { keep: 'newest', maxBytes: 1024 });
        expect(result).toEqual({ rows: [], trimmed: true });
        expect(mergeNormalChatWindow([], [textRow(1)], { keep: 'newest', maxBytes: 1 })).toEqual({ rows: [], trimmed: true });
    });

    it('never raises the shared hard limits through caller budget overrides', () => {
        const rows = Array.from({ length: 650 }, (_, index) => textRow(index));
        const byRows = mergeNormalChatWindow([], rows, { keep: 'newest', maxRows: 1000 });
        expect(byRows.rows).toHaveLength(MAX_ACTIVE_MESSAGE_EVENTS);
        expect(byRows.trimmed).toBe(true);
        const byBytes = mergeNormalChatWindow([], [textRow(1, 'x'.repeat(3 * 1024 * 1024))], { keep: 'newest', maxBytes: 8 * 1024 * 1024 });
        expect(estimateRetainedBytes(byBytes.rows)).toBeLessThanOrEqual(MAX_MESSAGE_WINDOW_BYTES);
        expect(byBytes.trimmed).toBe(true);
    });

    it('handles an empty budget and rejects invalid budget values', () => {
        expect(mergeNormalChatWindow([], [textRow(1)], { keep: 'newest', maxRows: 0 })).toEqual({ rows: [], trimmed: true });
        for (const maxBytes of [-1, NaN, Infinity, 1.5]) {
            expect(() => mergeNormalChatWindow([], [], { keep: 'newest', maxBytes })).toThrow(RangeError);
        }
    });
});
