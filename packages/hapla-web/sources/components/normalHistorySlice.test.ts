import { describe, expect, it } from 'vitest';
import { mergeNormalHistorySlice } from './normalHistorySlice';
import { MAX_MESSAGE_WINDOW_BYTES } from '@/sync/messageWindow';
import { estimateRetainedBytes } from '@/sync/sessionResources';
import type { NormalizedMessage } from '@/sync/typesRaw';

const message = (seq: number): NormalizedMessage => ({ id: `raw-${seq}`, seq, localId: null, createdAt: seq,
    isSidechain: false, role: 'user', content: { type: 'text', text: `Question ${seq}` } });

describe('read-only Normal history slice', () => {
    it('reconstructs successive older pages with original raw identities and sequences', () => {
        const recent = mergeNormalHistorySlice(null, { sessionId: 'session', messages: [message(3), message(4)] });
        const older = mergeNormalHistorySlice(recent, { sessionId: 'session', messages: [message(1), message(2)] });
        expect(older.rows.map((row) => row.seq).sort()).toEqual([1, 2, 3, 4]);
        expect(older.rows.every((row) => row.rawId === `raw-${row.seq}` && row.sourceSessionId === 'session')).toBe(true);
        expect(Object.keys(recent.raw)).toEqual(['raw-3', 'raw-4']);
    });

    it('does not turn historical tool calls into live approval cards', () => {
        const tool: NormalizedMessage = { ...message(2), role: 'agent', content: [{ type: 'tool-call', id: 'call',
            name: 'AskUserQuestion', input: { question: 'Old question' }, description: null, uuid: 'tool-uuid', parentUUID: null }] };
        const slice = mergeNormalHistorySlice(null, { sessionId: 'session', messages: [message(1), tool] });
        expect(slice.rows).toHaveLength(1);
        expect(slice.rows[0].message.kind).toBe('user-text');
    });

    it('keeps historical file artifacts and their turn/batch association without reviving approvals', () => {
        const file: NormalizedMessage = { ...message(2), role: 'agent', meta: { turnId: 'turn', artifact: { origin: 'automatic', batchId: 'batch' } },
            content: [{ type: 'tool-call', id: 'report', name: 'file', input: { ref: '/work/report.md', name: 'report.md', size: 123 },
                description: null, uuid: 'report', parentUUID: null }] };
        const slice = mergeNormalHistorySlice(null, { sessionId: 'session', messages: [message(1), file] });
        expect(slice.rows).toHaveLength(2);
        expect(slice.rows.find(row => row.message.kind === 'tool-call')?.message).toMatchObject({
            kind: 'tool-call', tool: { name: 'file', input: { ref: '/work/report.md' } }, meta: { turnId: 'turn', artifact: { batchId: 'batch' } },
        });
    });

    it('bounds scratch events and bytes independently of retained visible rows', () => {
        const events = Array.from({ length: 900 }, (_, i) => message(i));
        const count = mergeNormalHistorySlice(null, { sessionId: 'session', messages: events });
        expect(Object.keys(count.raw)).toHaveLength(600);
        const bytes = mergeNormalHistorySlice(null, { sessionId: 'session', messages: events.slice(0, 100).map((item) =>
            ({ ...item, role: 'user', content: { type: 'text', text: 'x'.repeat(60000) } })) });
        expect(estimateRetainedBytes(Object.values(bytes.raw))).toBeLessThanOrEqual(MAX_MESSAGE_WINDOW_BYTES + 32);
        expect(Object.keys(bytes.raw).length).toBeLessThan(100);
    });

    it('releases the previous runtime scratch when traversing a continuation boundary', () => {
        const recent = mergeNormalHistorySlice(null, { sessionId: 'recent', messages: [message(3)] });
        const older = mergeNormalHistorySlice(recent, { sessionId: 'older', messages: [message(1)] });
        expect(Object.keys(older.raw)).toEqual(['raw-1']);
        expect(older.rows.every((row) => row.sourceSessionId === 'older')).toBe(true);
    });
});
