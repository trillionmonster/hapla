import type { Message } from '@/sync/typesMessage';
import type { WorkspaceMode } from '@/hooks/useWorkspaceMode';
import { isConversationAgentEvent } from '@/utils/sessionEvents';
import { shouldShowToolInNormalMode } from './tools/toolVisibility';

/** Hidden protocol events must not become zero-height rows in the reading surface. */
export function isVisibleChatMessage(message: Message, mode: WorkspaceMode): boolean {
    if (message.kind === 'tool-call') return mode === 'coder' || shouldShowToolInNormalMode(message.tool);
    if (message.kind === 'agent-text') return !!message.text.trim() && (!message.isThinking || !!message.meta?.reasoningSummary);
    if (message.kind === 'agent-event') return isConversationAgentEvent(message.event);
    return true;
}

export type WebChatRow = {
    key: string;
    message: Message;
    sourceSessionId: string;
    rawId: string;
    seq?: number;
};

/** The reducer's permission object is mutable; a retained reading tree must not share it. */
export function snapshotChatMessage(message: Message): Message {
    if (message.kind !== 'tool-call') return message;
    return {
        ...message,
        tool: { ...message.tool, permission: message.tool.permission ? { ...message.tool.permission } : undefined },
        children: message.children.map(snapshotChatMessage),
    };
}

export function shouldHoldReadingWindow(anchorId: string | undefined, displayed: WebChatRow[], incoming: WebChatRow[]): boolean {
    return !!anchorId && displayed.some((row) => row.key === anchorId) && !incoming.some((row) => row.key === anchorId);
}

/** Rebuilds may change reducer IDs. Keep DOM identity through raw IDs and exact replay matches. */
export class WebChatRowIdentity {
    private next = 0;
    private previous = new Map<string, string>();

    reconcile(rows: Omit<WebChatRow, 'key'>[], signature: (message: Message) => string, retained: WebChatRow[] = []): WebChatRow[] {
        const rawAlias = (row: Omit<WebChatRow, 'key'>) => `${row.sourceSessionId}:${row.message.kind}:${row.rawId}`;
        const counts = (values: Omit<WebChatRow, 'key'>[]) => {
            const result = new Map<string, number>();
            for (const row of values) result.set(rawAlias(row), (result.get(rawAlias(row)) ?? 0) + 1);
            return result;
        };
        const incomingCounts = counts(rows);
        const retainedCounts = counts(retained);
        const retainedAliases = new Map<string, string[]>();
        const retain = (alias: string, key: string) => retainedAliases.set(alias, [...(retainedAliases.get(alias) ?? []), key]);
        const retainedOccurrences = new Map<string, number>();
        for (const row of retained) {
            retain(`id:${row.sourceSessionId}:${row.message.id}`, row.key);
            retain(`replay:${signature(row.message)}`, row.key);
            // A raw event may contain multiple text blocks. A filtered retained
            // subset cannot safely reconstruct their occurrence ordinals.
            const raw = rawAlias(row);
            const ordinal = retainedOccurrences.get(raw) ?? 0;
            retainedOccurrences.set(raw, ordinal + 1);
            if (incomingCounts.get(raw) === retainedCounts.get(raw)) {
                retain(`raw:${raw}:${ordinal}`, row.key);
            }
        }
        const next = new Map<string, string>();
        const used = new Set<string>();
        const occurrences = new Map<string, number>();
        const result = rows.map((row) => {
            const raw = `${row.sourceSessionId}:${row.message.kind}:${row.rawId}`;
            const ordinal = occurrences.get(raw) ?? 0;
            occurrences.set(raw, ordinal + 1);
            const aliases = [
                `id:${row.sourceSessionId}:${row.message.id}`,
                `raw:${raw}:${ordinal}`,
                `replay:${signature(row.message)}`,
            ];
            const existing = aliases.flatMap((alias) => [this.previous.get(alias), ...(retainedAliases.get(alias) ?? [])])
                .find((key) => key && !used.has(key));
            const key = existing ?? `row-${++this.next}`;
            used.add(key);
            for (const alias of aliases) next.set(alias, key);
            return { ...row, key };
        });
        // Only aliases for the bounded current message window remain retained.
        this.previous = next;
        return result;
    }
}
