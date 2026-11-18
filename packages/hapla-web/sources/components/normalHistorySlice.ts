import { mergeMessageWindow } from '@/sync/messageWindow';
import { createReducer, reducer } from '@/sync/reducer/reducer';
import type { NormalizedMessage } from '@/sync/typesRaw';
import type { WebChatRow } from './webChatRows';
import { isFileArtifactMessage } from './artifactTimeline';

export type NormalHistorySlice = {
    sessionId: string;
    raw: Record<string, NormalizedMessage>;
    rows: Omit<WebChatRow, 'key'>[];
};

/** Reconstruct a bounded history slice without mutating the live session store. */
export function mergeNormalHistorySlice(previous: NormalHistorySlice | null, page: {
    sessionId: string; messages: NormalizedMessage[];
}): NormalHistorySlice {
    const window = mergeMessageWindow(previous?.sessionId === page.sessionId ? previous.raw : {}, page.messages, { keep: 'oldest' });
    const state = createReducer();
    const result = reducer(state, window.messages);
    const rows = result.messages.filter((message) => message.kind !== 'tool-call' || isFileArtifactMessage(message)).map((message) => {
        const rawId = state.messages.get(message.id)?.realID ?? message.id;
        return { message, rawId, sourceSessionId: page.sessionId, seq: window.map[rawId]?.seq };
    });
    return { sessionId: page.sessionId, raw: window.map, rows };
}
