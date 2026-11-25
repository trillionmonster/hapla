import { describe, expect, it } from 'vitest';
import { previewEditorFor } from './previewEditor';
describe('proxy drafts survive layout changes within one account', () => {
    it('retains unsaved rules and a pending operation across responsive remounts', () => {
        const first = previewEditorFor('test-account-a');
        first.getState().setEditing(null);
        first.getState().setDraft(rule => ({ ...rule, target: 'http://localhost:5173/app/' }));
        first.getState().setBusy(true);
        const remounted = previewEditorFor('test-account-a');
        expect(remounted).toBe(first);
        expect(remounted.getState().draft.target).toBe('http://localhost:5173/app/');
        first.getState().setBusy(false);
        expect(remounted.getState().busy).toBe(false);
    });
    it('does not expose another account draft or a late result from that account', () => {
        const old = previewEditorFor('test-account-old');
        old.getState().setDraft(rule => ({ ...rule, target: 'http://private.example.test' }));
        const active = previewEditorFor('test-account-new');
        old.getState().setDraft(rule => ({ ...rule, name: 'late-result' }));
        expect(active.getState().draft.target).toBe(''); expect(active.getState().draft.name).toBe('');
        expect(active.getState()).not.toHaveProperty('key');
    });
});
