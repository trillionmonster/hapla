import { create } from 'zustand';
import type { Dispatch, SetStateAction } from 'react';
import type { PreviewAccess, PreviewListing, PreviewRegistration } from '@hapla/wire';

export const emptyPreviewRule = { name: '', machineId: '', target: '', access: 'private' as PreviewAccess };
type Editor = {
    editing: PreviewRegistration | null | undefined;
    draft: typeof emptyPreviewRule;
    busy: boolean;
    items: PreviewListing[];
    setEditing: (editing: Editor['editing']) => void;
    setDraft: Dispatch<SetStateAction<Editor['draft']>>;
    setBusy: (busy: boolean) => void;
    setItems: Dispatch<SetStateAction<PreviewListing[]>>;
};
function createEditor() {
    return create<Editor>(set => ({
        editing: undefined, draft: { ...emptyPreviewRule }, busy: false, items: [],
        setEditing: editing => set({ editing }),
        setDraft: value => set(state => ({ draft: typeof value === 'function' ? value(state.draft) : value })),
        setBusy: busy => set({ busy }),
        setItems: value => set(state => ({ items: typeof value === 'function' ? value(state.items) : value })),
    }));
}
// The responsive app shell remounts routes at its layout breakpoint. Keep the
// editor in memory for that account, without persisting targets or share keys.
let current: { owner: string; store: ReturnType<typeof createEditor> } | null = null;
export function previewEditorFor(owner: string) {
    if (current?.owner !== owner) current = { owner, store: createEditor() };
    return current.store;
}
