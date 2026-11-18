import * as React from 'react';

export type WorkspaceMode = 'normal' | 'coder';

export function useWorkspaceMode(sessionId: string) {
    // Coder is an explicit choice for the current visit, never a saved default.
    const [selection, setSelection] = React.useState<{ sessionId: string; mode: WorkspaceMode }>(() => ({ sessionId, mode: 'normal' }));
    const mode = selection.sessionId === sessionId ? selection.mode : 'normal';
    React.useEffect(() => {
        setSelection(current => current.sessionId === sessionId ? current : { sessionId, mode: 'normal' });
    }, [sessionId]);

    const setMode = React.useCallback((nextMode: WorkspaceMode) => {
        setSelection({ sessionId, mode: nextMode });
    }, [sessionId]);

    return [mode, setMode] as const;
}
