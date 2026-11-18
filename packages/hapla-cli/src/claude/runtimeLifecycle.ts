import type { Metadata } from '@/api/types';

export type ClaudeRuntimeShutdownCause =
    | 'manual-sleep'
    | 'terminal-exit'
    | 'archived'
    | 'process-signal'
    | 'runtime-error';

/**
 * Only an explicit user action may move a conversation into the sleeping
 * product state. Transport loss, process failure and archival have their own
 * state and must not be presented as a user-requested sleep.
 */
export function shouldPersistClaudeSleep(cause: ClaudeRuntimeShutdownCause): boolean {
    return cause === 'manual-sleep' || cause === 'terminal-exit';
}

export function markClaudeSessionSleeping(metadata: Metadata, now = Date.now()): Metadata {
    return {
        ...metadata,
        lifecycleState: 'sleeping',
        lifecycleStateSince: now,
        sleepReason: 'runtime-stop',
    };
}
