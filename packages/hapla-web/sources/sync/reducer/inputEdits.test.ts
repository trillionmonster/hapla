import { describe, it, expect } from 'vitest';
import { createReducer, reducer } from './reducer';
import type { NormalizedMessage } from '../typesRaw';
const original: NormalizedMessage = { id: 'server-id', localId: 'local-id', createdAt: 1, role: 'user', content: { type: 'text', text: 'old' }, isSidechain: false, meta: { displayText: 'old display' } };
const edit = (revision: number, text: string): NormalizedMessage => ({ id: 'edit-' + revision, localId: null, createdAt: 2, role: 'user', content: { type: 'text', text }, isSidechain: false, meta: { inputEdit: { messageId: 'server-id', revision } } });
describe('durable queued input revisions', () => {
    it('projects the latest revision without a second user question and ignores old revisions', () => {
        const state = createReducer(); reducer(state, [original]);
        const result = reducer(state, [edit(2, 'executed'), edit(1, 'stale')]);
        expect(result.messages).toHaveLength(1);
        expect(result.messages[0]).toMatchObject({ kind: 'user-text', text: 'executed', displayText: 'executed', sourceMessageId: 'server-id' });
        expect(state.messages.size).toBe(1);
    });
    it('retains the revision when history or the server acknowledgement arrives later', () => {
        const state = createReducer(); reducer(state, [{ ...original, id: 'local-id' }]);
        expect(reducer(state, [edit(1, 'edited')]).messages).toHaveLength(0);
        expect(reducer(state, [original]).messages[0]).toMatchObject({ text: 'edited', displayText: 'edited', sourceMessageId: 'server-id' });
        const paged = createReducer(); reducer(paged, [edit(1, 'edited')]);
        expect(reducer(paged, [original]).messages[0]).toMatchObject({ text: 'edited', displayText: 'edited' });
    });
});
