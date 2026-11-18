import { SessionListViewItem, useSessionListViewData } from '@/sync/storage';

export function useVisibleSessionListViewData(): SessionListViewItem[] | null {
    // Conversations are always visible. Runtime liveness is an implementation
    // detail: sending a message transparently ensures a runtime exists.
    return useSessionListViewData();
}
