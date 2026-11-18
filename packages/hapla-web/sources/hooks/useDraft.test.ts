import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
// The installed renderer has no separate @types package in this workspace.
// @ts-expect-error no declaration file
import { act, create } from 'react-test-renderer';
const fixture = vi.hoisted(() => ({ focused: true, drafts: {} as Record<string, string>, updates: [] as string[] }));
vi.mock('@react-navigation/native', () => ({ useIsFocused: () => fixture.focused }));
vi.mock('react-native', () => ({ AppState: { addEventListener: () => ({ remove() {} }) } }));
vi.mock('@/sync/persistence', () => ({ loadSessionDrafts: () => ({ ...fixture.drafts }) }));
vi.mock('@/sync/storage', () => ({ storage: { getState: () => ({ updateSessionDraft: (id: string, draft: string | null) => {
    if (draft) fixture.drafts[id] = draft; else delete fixture.drafts[id];
    fixture.updates.push(`${id}:${draft ?? ''}`);
} }) } }));
import { useDraft } from './useDraft';
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => { fixture.focused = true; fixture.drafts = {}; fixture.updates = []; });

describe('draft focus lifetime', () => {
    it('restores a persisted draft without clearing it in the initial autosave effect, then flushes and releases text on blur', async () => {
        fixture.drafts.one = 'persisted unsent';
        let edit!: (value: string) => void;
        let rendered = '';
        function Harness() {
            const [value, setValue] = React.useState(''); edit = setValue; rendered = value;
            useDraft('one', value, setValue, { autoSaveInterval: 60000 });
            return null;
        }
        let renderer: any;
        await act(async () => { renderer = create(React.createElement(Harness)); });
        expect(rendered).toBe('persisted unsent');
        expect(fixture.drafts.one).toBe('persisted unsent');
        await act(async () => edit('last edit before leaving'));
        fixture.focused = false;
        await act(async () => renderer.update(React.createElement(Harness)));
        expect(rendered).toBe('');
        expect(fixture.drafts.one).toBe('last edit before leaving');
        fixture.focused = true;
        await act(async () => renderer.update(React.createElement(Harness)));
        expect(rendered).toBe('last edit before leaving');
        await act(async () => renderer.unmount());
    });
});
