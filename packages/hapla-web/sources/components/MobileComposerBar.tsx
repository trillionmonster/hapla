import type { ReactNode } from 'react';

export type MobileComposerBarProps = {
    sessionId?: string;
    controls?: ReactNode;
    hasContent: boolean;
    sending?: boolean;
    canSend: boolean;
    aborting: boolean;
    status?: string;
    onSend: () => void;
    onAbort?: () => void | Promise<void>;
    onSettings: () => void;
    onHistory?: () => void;
    onFiles?: () => void;
    onImages?: () => void;
    onWorkspace?: () => void;
};

export function MobileComposerBar(_props: MobileComposerBarProps) {
    return null;
}
