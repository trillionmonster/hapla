import { useEffect, useRef, useCallback } from 'react';
import { AppState, AppStateStatus } from 'react-native';
import { storage } from '@/sync/storage';
import { loadSessionDrafts } from '@/sync/persistence';
import { useIsFocused } from '@react-navigation/native';

interface UseDraftOptions {
    autoSaveInterval?: number;
}

export function useDraft(
    sessionId: string | null | undefined,
    value: string,
    onChange: (value: string) => void,
    options: UseDraftOptions = {},
) {
    const { autoSaveInterval = 2000 } = options;
    const isFocused = useIsFocused();
    const lastSavedValue = useRef('');
    const restoring = useRef<string | null>(null);
    const latest = useRef({ value, onChange });
    latest.current = { value, onChange };
    const saveDraft = useCallback((draft: string) => {
        if (!sessionId) return;
        storage.getState().updateSessionDraft(sessionId, draft);
        lastSavedValue.current = draft;
    }, [sessionId]);

    useEffect(() => {
        if (!sessionId || !isFocused) return;
        const draft = loadSessionDrafts()[sessionId] ?? '';
        lastSavedValue.current = draft;
        restoring.current = draft;
        latest.current.onChange(draft);
        return () => {
            // Flush the current edit once when focus leaves, then release component-held text.
            if (restoring.current === null && latest.current.value !== lastSavedValue.current) saveDraft(latest.current.value);
            restoring.current = null;
            latest.current.onChange('');
        };
    }, [sessionId, isFocused, saveDraft]);

    useEffect(() => {
        if (!sessionId || !isFocused) return;
        if (restoring.current !== null) {
            if (value !== restoring.current) return;
            restoring.current = null;
        }
        if (value === lastSavedValue.current) return;
        if (!value.trim() || !lastSavedValue.current.trim()) {
            saveDraft(value);
            return;
        }
        const timer = setTimeout(() => saveDraft(value), autoSaveInterval);
        return () => clearTimeout(timer);
    }, [value, sessionId, isFocused, autoSaveInterval, saveDraft]);

    useEffect(() => {
        if (!sessionId || !isFocused) return;
        const subscription = AppState.addEventListener('change', (state: AppStateStatus) => {
            if ((state === 'background' || state === 'inactive') && restoring.current === null
                && latest.current.value !== lastSavedValue.current) saveDraft(latest.current.value);
        });
        return () => subscription.remove();
    }, [sessionId, isFocused, saveDraft]);

    const clearDraft = useCallback(() => {
        if (!sessionId) return;
        storage.getState().updateSessionDraft(sessionId, null);
        lastSavedValue.current = '';
        restoring.current = null;
    }, [sessionId]);

    return { clearDraft };
}
