export type CodexUpdateState = 'idle' | 'checking' | 'installing' | 'verifying' | 'refreshing' | 'completed' | 'failed';

export interface CodexUpdateStatus {
    state: CodexUpdateState;
    message: string;
    operationId?: string;
    currentVersion?: string | null;
    previousVersion?: string | null;
    startedAt?: number;
    finishedAt?: number;
    error?: string;
    modelsRefreshed?: boolean;
    updateSupported?: boolean;
    unsupportedReason?: string;
    installation?: 'npm' | 'pnpm' | 'brew' | 'managed' | 'custom' | 'missing';
}

export type CodexUpdateResponse = { success: true; status: CodexUpdateStatus } | { success: false; error: string };
