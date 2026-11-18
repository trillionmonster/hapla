import { describe, expect, it } from 'vitest';
import type { WebChatRow } from './webChatRows';
import { ArtifactTimelineIdentity, artifactAnchorKey, artifactAnchorRow, type ArtifactCollection } from './artifactTimeline';

const file = (id: number, path = `/work/clip-${id}.mp4`): WebChatRow => ({
    key: `row-${id}`, rawId: `raw-${id}`, sourceSessionId: 'session', seq: id,
    message: { kind: 'tool-call', id: `file-${id}`, localId: null, createdAt: id, children: [],
        meta: { turnId: 'turn', branchId: 'branch', artifact: { origin: 'automatic', batchId: 'batch', sourceId: 'command', path } },
        tool: { name: 'file', state: 'completed', input: { ref: path, name: path.split('/').pop(), size: id, mimeType: 'video/mp4' },
            createdAt: id, startedAt: id, completedAt: id, description: null } },
});
const text = (id: number, kind: 'user-text' | 'agent-text' = 'agent-text'): WebChatRow => ({
    key: `text-${id}`, rawId: `raw-text-${id}`, sourceSessionId: 'session', seq: id,
    message: { kind, id: `text-${id}`, localId: null, createdAt: id, text: 'A distinct conversation step' },
});
const group = (rows: WebChatRow[]): ArtifactCollection => {
    const entry = new ArtifactTimelineIdentity().reconcile(rows)[0];
    if (entry.kind !== 'artifacts') throw Error('Expected artifacts');
    return entry.collection;
};

describe('artifact timeline collections', () => {
    it('collects thirty automatic clips without moving surrounding step text', () => {
        const rows = [text(0), ...Array.from({ length: 30 }, (_, index) => file(index + 1)), text(32)];
        const entries = new ArtifactTimelineIdentity().reconcile(rows);
        expect(entries.map(entry => entry.kind)).toEqual(['message', 'artifacts', 'message']);
        expect(entries[0].key).toBe('text-0');
        expect(entries[2].key).toBe('text-32');
        expect(entries[1].kind === 'artifacts' && entries[1].collection.items.length).toBe(30);
    });

    it.each(['user-text', 'agent-text'] as const)('never crosses a %s boundary even when a producer reuses batchId', kind => {
        expect(new ArtifactTimelineIdentity().reconcile([file(1), text(2, kind), file(3)]).map(entry => entry.kind))
            .toEqual(['artifacts', 'message', 'artifacts']);
    });

    it('separates source runtime, branch, turn, batch, origin and producing step', () => {
        const first = file(1);
        const changes: Array<(row: WebChatRow) => WebChatRow> = [
            row => ({ ...row, sourceSessionId: 'other' }),
            row => ({ ...row, message: { ...row.message, meta: { ...row.message.meta, branchId: 'other' } } }),
            row => ({ ...row, message: { ...row.message, meta: { ...row.message.meta, turnId: 'other' } } }),
            ...[{ batchId: 'other' }, { sourceId: 'other' }, { origin: 'reference' as const }].map(change => (row: WebChatRow) =>
                ({ ...row, message: { ...row.message, meta: { ...row.message.meta, artifact: { ...row.message.meta!.artifact!, ...change } } } })),
        ];
        for (const change of changes) expect(new ArtifactTimelineIdentity().reconcile([first, change(file(2))])).toHaveLength(2);
    });

    it('keeps the first position and key but replaces an overwritten file with its latest URL and size', () => {
        const first = file(1, '/work/final.mp4'), other = file(2), latest = file(3, '/work/final.mp4');
        if (latest.message.kind !== 'tool-call') throw Error('File fixture expected');
        latest.message.tool.input.ref = '/files/new-upload.mp4';
        latest.message.tool.input.size = 999;
        const collection = group([first, other, latest]);
        expect(collection.items).toHaveLength(2);
        expect(collection.items[0]).toMatchObject({ key: first.key, row: latest, path: '/work/final.mp4' });
        expect(collection.items[0].message.kind === 'tool-call' && collection.items[0].message.tool.input).toMatchObject({ ref: '/files/new-upload.mp4', size: 999 });
        expect(collection.rows).toHaveLength(3);
    });

    it('keeps intentional references in another step instead of globally deduplicating paths', () => {
        const first = file(1, '/work/final.mp4'), later = file(3, '/work/final.mp4');
        const entries = new ArtifactTimelineIdentity().reconcile([first, text(2), later]);
        expect(entries.filter(entry => entry.kind === 'artifacts')).toHaveLength(2);
    });

    it('groups legacy file/media neighbors and flattens multiple media items without inventing provenance', () => {
        const one = file(1);
        one.message.meta = { turnId: 'turn', branchId: 'branch' };
        const media: WebChatRow = { ...file(2), message: { id: 'media', kind: 'agent-media', createdAt: 2, localId: null,
            meta: { turnId: 'turn', branchId: 'branch' }, media: [{ url: '/files/a.png', mediaType: 'image/png' }, { url: '/files/b.mp4', mediaType: 'video/mp4' }] } };
        const collection = group([one, media]);
        expect(collection.origin).toBe('legacy');
        expect(collection.items.map(item => item.kind)).toEqual(['video', 'image', 'video']);
        expect(collection.items[1].message.kind === 'agent-media' && collection.items[1].message.media).toHaveLength(1);
    });

    it('cleans a legacy signed file label without modifying the original request reference or message', () => {
        const signed = 'https://cdn.example.test/final%20cut.mp4?X-Amz-Signature=KEEP%2FEXACT+VALUE&expires=12';
        const row = file(1, signed);
        row.message.meta = { turnId: 'turn', branchId: 'branch' };
        if (row.message.kind !== 'tool-call') throw Error('File fixture expected');
        row.message.tool.input.name = 'final%20cut.mp4?X-Amz-Signature=KEEP%2FEXACT+VALUE&expires=12';
        const [item] = group([row]).items;
        expect(item.name).toBe('final cut.mp4');
        expect(item.path).toBe(signed);
        expect(item.message).toBe(row.message);
        expect(item.message.kind === 'tool-call' && item.message.tool.input.ref).toBe(signed);
        expect(row.message.tool.input.name).toContain('X-Amz-Signature');
    });

    it('cleans media collection labels but keeps different signed references distinct even when display names match', () => {
        const first = 'https://cdn.example.test/final%20cut.mp4?token=first%2Fvalue';
        const second = 'https://cdn.example.test/final%20cut.mp4?token=second+value';
        const row: WebChatRow = { ...file(1), message: { id: 'media', kind: 'agent-media', createdAt: 1, localId: null,
            meta: { turnId: 'turn', branchId: 'branch' },
            media: [{ url: first, name: first, mediaType: 'video/mp4' }, { url: second, mediaType: 'video/mp4' }] } };
        const items = group([row]).items;
        expect(items).toHaveLength(2);
        expect(items.map(item => item.name)).toEqual(['final cut.mp4', 'final cut.mp4']);
        expect(items.map(item => item.path)).toEqual([first, second]);
        expect(items.map(item => item.message.kind === 'agent-media' && item.message.media[0].url)).toEqual([first, second]);
    });

    it('preserves group DOM identity while appending, prepending and sliding the bounded raw window', () => {
        const identities = new ArtifactTimelineIdentity();
        const initial = identities.reconcile([file(2), file(3)]);
        const appended = identities.reconcile([file(1), file(2), file(3), file(4)]);
        expect(appended[0].key).toBe(initial[0].key);
        expect(artifactAnchorKey(appended, 'row-1')).toBe('row-2');
        const trimmed = identities.reconcile([file(3), file(4)]);
        expect(trimmed[0].key).toBe('row-2');
        expect(artifactAnchorRow(trimmed, 'row-2')?.key).toBe('row-3');
        expect(artifactAnchorKey(trimmed, 'row-4')).toBe('row-2');
    });

    it('maps deduplicated member anchors to the same collection header', () => {
        const entries = new ArtifactTimelineIdentity().reconcile([file(1, '/same'), file(2, '/same'), text(3)]);
        expect(artifactAnchorKey(entries, 'row-2')).toBe('row-1');
        expect(artifactAnchorRow(entries, 'row-2')?.rawId).toBe('raw-2');
        expect(artifactAnchorKey(entries, 'text-3')).toBe('text-3');
        expect(artifactAnchorKey(entries, 'missing')).toBeUndefined();
    });
});
