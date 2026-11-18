import * as React from 'react';
import { machineResumeSession } from '@/sync/ops';
import { storage, useAllMachines } from '@/sync/storage';
import type { Session } from '@/sync/storageTypes';
import { sync } from '@/sync/sync';
import { prepareSessionForSend, resolveContinuationMachines, type SessionContinuationOptions } from '@/utils/sessionContinuation';

export function useSessionContinuation(session: Session | null) {
    const machines = useAllMachines({ includeOffline: true });
    const continuationMachines = session ? resolveContinuationMachines(session, machines) : [];
    const machine = continuationMachines[0] ?? null;
    const current = React.useRef({ session, machine, continuationMachines });
    current.current = { session, machine, continuationMachines };

    return React.useCallback(async (options?: SessionContinuationOptions) => {
        const latest = current.current;
        if (!latest.session) {
            throw new Error('Conversation is not available');
        }
        // Legacy rows are grouped once while their encrypted relationship is
        // available in the browser. Every replacement runtime then inherits a
        // durable server-side conversation id.
        const identity = await sync.ensureConversationIdentity(latest.session.id);
        const session = latest.session.conversationId === identity.conversationId
            ? latest.session
            : { ...latest.session, conversationId: identity.conversationId };
        return prepareSessionForSend(session, latest.machine, session.presence === 'online', {
            // An acknowledgement timeout does not prove the selected daemon
            // failed to resume. Retrying on another daemon can create a second
            // writer for the same thread. The next user retry reuses this owner.
            resumeSession: machineResumeSession,
            refreshSessions: () => sync.refreshSessions(),
            getSession: (sessionId) => storage.getState().sessions[sessionId],
            copySessionSettings: (source, targetSessionId) => {
                if (source.permissionMode) {
                    storage.getState().updateSessionPermissionMode(targetSessionId, source.permissionMode);
                }
                if (source.modelMode) {
                    storage.getState().updateSessionModelMode(targetSessionId, source.modelMode);
                }
                if (source.codexPreferences) storage.getState().updateSessionCodexPreferences(targetSessionId, source.codexPreferences);
                if (source.effortLevel) {
                    storage.getState().updateSessionEffortLevel(targetSessionId, source.effortLevel);
                }
            },
            wait: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
        }, options);
    }, []);
}
