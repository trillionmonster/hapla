import type { Message } from './typesMessage';
import type { NormalizedMessage } from './typesRaw';
import { estimateRetainedBytes } from './sessionResources';

export const MAX_PENDING_STREAM_BYTES = 2 * 1024 * 1024;
const MAX_STREAM_PREVIEW_CHARS = 256 * 1024;

export type SessionStream = {
    id: string;
    turnId: string;
    text: string;
    branchId?: string;
    updatedAt: number;
    seq?: number;
    epoch?: string;
    kind?: 'text' | 'tool-output' | 'reasoning-summary';
    callId?: string;
    truncated?: boolean;
    totalBytes?: number;
    createdAt?: number;
};

export type SessionStreamState = {
    pending: Record<string, SessionStream>;
    completed: Record<string, number>;
    completedTurns: Record<string, number>;
};

export function createSessionStreamState(): SessionStreamState {
    return { pending: {}, completed: {}, completedTurns: {} };
}

function streamKey(id: string, branchId?: string, kind: 'text' | 'tool-output' | 'reasoning-summary' = 'text'): string {
    return JSON.stringify([branchId ?? 'main', kind, id]);
}

export function canonicalStreamMessageId(id: string, branchId?: string, kind: 'text' | 'reasoning-summary' = 'text'): string {
    return `stream:${streamKey(id, branchId, kind)}`;
}

export function acceptSessionStream(state: SessionStreamState, incoming: SessionStream): SessionStreamState {
    const key = streamKey(incoming.callId ?? incoming.id, incoming.branchId, incoming.kind);
    if (state.completed[key] !== undefined) return state;
    if (incoming.kind === 'tool-output' && state.completedTurns[JSON.stringify([incoming.branchId ?? 'main', incoming.turnId])] !== undefined) return state;
    const current = state.pending[key];
    if (current) {
        if (incoming.seq !== undefined && current.seq !== undefined) {
            if (incoming.seq <= current.seq) return state;
        } else if (incoming.updatedAt < current.updatedAt
            || (incoming.updatedAt === current.updatedAt && incoming.text.length <= current.text.length)) {
            return state;
        }
    }
    const text = incoming.text.length > MAX_STREAM_PREVIEW_CHARS
        ? incoming.text.slice(-MAX_STREAM_PREVIEW_CHARS) : incoming.text;
    const pending = { ...state.pending, [key]: {
        ...incoming, text, truncated: incoming.truncated || text.length < incoming.text.length,
        createdAt: current?.createdAt ?? incoming.updatedAt,
    } };
    // Keep live previews bounded too: a missing final event must not pin an unbounded transcript.
    let bytes = estimateRetainedBytes(pending);
    for (const [id, stream] of Object.entries(pending).sort((a, b) => a[1].updatedAt - b[1].updatedAt)) {
        if (bytes <= MAX_PENDING_STREAM_BYTES) break;
        if (id === key) continue;
        bytes -= estimateRetainedBytes(stream) + id.length * 2 + 8;
        delete pending[id];
    }
    return { ...state, pending };
}

/** Text waits for its persisted item; authoritative turn failure can also retire scoped tool output. */
export function commitSessionStreams(state: SessionStreamState, messages: NormalizedMessage[]): SessionStreamState {
    const completed = { ...state.completed };
    const pending = { ...state.pending };
    const completedTurns = { ...state.completedTurns };
    let changed = false;
    for (const message of messages) {
        if (message.meta?.turnId && (message.turnEndStatus === 'cancelled' || message.turnEndStatus === 'failed')) {
            changed = true;
            completedTurns[JSON.stringify([message.meta.branchId ?? 'main', message.meta.turnId])] = message.createdAt;
            for (const [key, stream] of Object.entries(pending)) {
                if (stream.kind === 'tool-output' && stream.turnId === message.meta.turnId
                    && (stream.branchId ?? 'main') === (message.meta.branchId ?? 'main')) {
                    completed[key] = message.createdAt;
                    delete pending[key];
                }
            }
        }
        if (message.role !== 'agent') continue;
        for (const content of message.content) {
            const key = (content.type === 'text' || (content.type === 'thinking' && message.meta?.reasoningSummary)) && message.meta?.streamId
                ? streamKey(message.meta.streamId, message.meta.branchId, message.meta.reasoningSummary ? 'reasoning-summary' : 'text')
                : content.type === 'tool-result'
                    ? streamKey(content.tool_use_id, message.meta?.branchId, 'tool-output')
                    : null;
            if (!key) continue;
            changed = true;
            completed[key] = message.createdAt;
            delete pending[key];
        }
    }
    if (!changed) return state;
    // Keep replay tombstones bounded independently from the displayed history window.
    const recent = Object.entries(completed).sort((a, b) => b[1] - a[1]).slice(0, 1200);
    return {
        pending, completed: Object.fromEntries(recent),
        completedTurns: Object.fromEntries(Object.entries(completedTurns).sort((a, b) => b[1] - a[1]).slice(0, 512)),
    };
}

/** A single storage transaction projects provisional and persisted items into canonical UI rows. */
export function projectSessionStreams(
    messages: Record<string, Message>,
    streams: SessionStreamState,
    toolIds: Map<string, string>,
    sidechainToolIds: Map<string, string> = new Map(),
): Record<string, Message> {
    const result = Object.fromEntries(Object.entries(messages).filter(([, message]) => (
        message.kind !== 'agent-text' || !message.provisional
    )));
    for (const stream of Object.values(streams.pending)) {
        if (stream.kind === 'tool-output') {
            const callId = stream.callId ?? stream.id;
            const ids = new Set([toolIds.get(callId), sidechainToolIds.get(callId)].filter(Boolean));
            if (!ids.size) continue;
            const project = (message: Message): Message => {
                if (message.kind !== 'tool-call') return message;
                const children = message.children.map(project);
                const matches = ids.has(message.id) && message.tool.state === 'running'
                    && (message.meta?.branchId ?? 'main') === (stream.branchId ?? 'main')
                    && (!message.meta?.turnId || message.meta.turnId === stream.turnId);
                if (!matches && children.every((child, index) => child === message.children[index])) return message;
                return {
                    ...message, children,
                    ...(matches ? { tool: {
                        ...message.tool,
                        result: {
                            ...(typeof message.tool.result === 'object' && message.tool.result !== null ? message.tool.result : {}),
                            output: stream.text, truncated: stream.truncated, totalBytes: stream.totalBytes,
                        },
                    } } : {}),
                };
            };
            for (const [id, message] of Object.entries(result)) result[id] = project(message);
        } else if (stream.text) {
            const id = canonicalStreamMessageId(stream.id, stream.branchId, stream.kind === 'reasoning-summary' ? 'reasoning-summary' : 'text');
            if (result[id]) continue;
            result[id] = {
                kind: 'agent-text', id, localId: null,
                createdAt: stream.createdAt ?? stream.updatedAt,
                text: stream.text,
                provisional: true,
                ...(stream.kind === 'reasoning-summary' ? { isThinking: true } : {}),
                meta: { streamId: stream.id, branchId: stream.branchId, ...(stream.kind === 'reasoning-summary' ? { reasoningSummary: true } : {}) },
            };
        }
    }
    return result;
}
