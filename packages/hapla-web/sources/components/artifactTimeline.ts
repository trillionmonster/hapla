import type { Message } from '@/sync/typesMessage';
import type { WebChatRow } from './webChatRows';
import { getMediaKind } from './media/mediaKind';
import { getMediaDisplayName } from './media/mediaDisplayName';

export const ARTIFACT_PAGE_SIZE = 6;
export const INLINE_ARTIFACT_LIMIT = 3;
export type ArtifactOrigin = 'automatic' | 'reference' | 'legacy';
export type ArtifactItem = { key: string; row: WebChatRow; message: Message; name: string; path: string; kind: 'image' | 'video' | 'audio' | 'document' };
export type ArtifactCollection = { key: string; scope: string; origin: ArtifactOrigin; rows: WebChatRow[]; items: ArtifactItem[] };
export type ArtifactTimelineEntry = { kind: 'message'; key: string; row: WebChatRow } | { kind: 'artifacts'; key: string; collection: ArtifactCollection };

/** File envelopes are durable user-facing artifacts, even though the legacy reducer calls them tools. */
export function isFileArtifactMessage(message: Message): boolean {
    return message.kind === 'tool-call' && message.tool.name === 'file';
}

export function isArtifactMessage(message: Message): boolean {
    return isFileArtifactMessage(message) || (message.kind === 'agent-media' && message.media.length > 0);
}

function itemsForRow(row: WebChatRow): ArtifactItem[] {
    const message = row.message;
    const values = message.kind === 'agent-media' ? message.media.map((media, index) => ({
        path: (message.media.length === 1 ? message.meta?.artifact?.path : undefined) ?? media.url, name: media.name,
        mime: media.mediaType, key: `${row.key}:media:${index}`,
        message: { ...message, media: [media] } as Message,
    })) : message.kind === 'tool-call' && message.tool.name === 'file' ? [{
        path: message.meta?.artifact?.path ?? message.tool.input?.ref,
        name: message.tool.input?.name, mime: message.tool.input?.mimeType,
        key: row.key, message,
    }] : [];
    return values.map(value => {
        const path = typeof value.path === 'string' ? value.path : '';
        const name = getMediaDisplayName(path, typeof value.name === 'string' ? value.name : undefined, '文件');
        const kind = getMediaKind(path, typeof value.mime === 'string' ? value.mime : undefined);
        return { row, message: value.message, key: value.key, name, path, kind: kind === 'unknown' ? 'document' : kind };
    });
}

function artifactScope(row: WebChatRow): string {
    const meta = row.message.meta;
    const artifact = meta?.artifact;
    return JSON.stringify([row.sourceSessionId, meta?.branchId ?? null, meta?.turnId ?? null,
        artifact?.origin ?? 'legacy', artifact?.batchId ?? null, artifact?.sourceId ?? null]);
}

/** Only adjacent artifacts can share a collection; text, questions and source boundaries are never crossed. */
export class ArtifactTimelineIdentity {
    private previous: ArtifactCollection[] = [];

    reconcile(rows: readonly WebChatRow[]): ArtifactTimelineEntry[] {
        const entries: ArtifactTimelineEntry[] = [];
        for (const row of rows) {
            if (!isArtifactMessage(row.message)) { entries.push({ kind: 'message', key: row.key, row }); continue; }
            const scope = artifactScope(row);
            const last = entries.at(-1);
            if (last?.kind === 'artifacts' && last.collection.scope === scope) {
                last.collection.rows.push(row);
                last.collection.items.push(...itemsForRow(row));
            } else {
                entries.push({ kind: 'artifacts', key: row.key, collection: {
                    key: row.key, scope, origin: row.message.meta?.artifact?.origin ?? 'legacy', rows: [row], items: itemsForRow(row),
                } });
            }
        }
        const used = new Set<string>();
        const next: ArtifactCollection[] = [];
        for (const entry of entries) {
            if (entry.kind !== 'artifacts') continue;
            const group = entry.collection;
            const members = new Set(group.rows.map(row => row.key));
            const previous = this.previous.find(candidate => candidate.scope === group.scope && !used.has(candidate.key)
                && candidate.rows.some(row => members.has(row.key)));
            if (previous) entry.key = group.key = previous.key;
            used.add(group.key);
            // Keep the first position/key but the newest file revision. All
            // raw row aliases remain valid scroll anchors, including replays.
            const seen = new Map<string, number>();
            const unique: ArtifactItem[] = [];
            for (const item of group.items) {
                const identity = item.path || item.key;
                const index = seen.get(identity);
                if (index === undefined) { seen.set(identity, unique.length); unique.push(item); }
                else unique[index] = { ...item, key: unique[index].key };
            }
            group.items = unique;
            next.push(group);
        }
        this.previous = next;
        return entries;
    }
}

/** Saved member cursors resolve to the collection header, including collapsed and deduplicated members. */
export function artifactAnchorKey(entries: readonly ArtifactTimelineEntry[], memberKey: string | undefined): string | undefined {
    if (!memberKey) return undefined;
    return entries.find(entry => entry.key === memberKey || (entry.kind === 'artifacts'
        && entry.collection.rows.some(row => row.key === memberKey)))?.key;
}

export function artifactAnchorRow(entries: readonly ArtifactTimelineEntry[], key: string | undefined): WebChatRow | undefined {
    if (!key) return undefined;
    const entry = entries.find(entry => entry.key === key || (entry.kind === 'artifacts'
        && entry.collection.rows.some(row => row.key === key)));
    return entry?.kind === 'message' ? entry.row : entry?.collection.rows.find(row => row.key === key) ?? entry?.collection.rows[0];
}
