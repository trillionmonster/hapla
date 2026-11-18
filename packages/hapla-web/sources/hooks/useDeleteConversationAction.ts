import * as React from 'react';
import { Modal } from '@/modal';
import { useHaplaAction } from '@/hooks/useHaplaAction';
import { maybeCleanupWorktree } from '@/hooks/useWorktreeCleanup';
import { conversationDelete, sessionKill } from '@/sync/ops';
import { storage, useAllSessions } from '@/sync/storage';
import type { Session } from '@/sync/storageTypes';
import { getConversationRuntimeIds } from '@/sync/conversationSessions';
import { sync } from '@/sync/sync';
import { t } from '@/text';
import { HaplaError } from '@/utils/errors';

export function useDeleteConversationAction(
    session: Session | null | undefined,
    options: { onAfterDelete?: () => void } = {},
) {
    const sessions = useAllSessions();
    const runtimeIds = React.useMemo(
        () => session ? getConversationRuntimeIds(sessions, session.id) : [],
        [session, sessions],
    );

    const [deleting, performDelete] = useHaplaAction(async () => {
        if (!session) throw new HaplaError(t('sessionInfo.failedToDeleteSession'), false);
        // The home screen intentionally holds only a recent window. Resolve the
        // complete logical conversation before mutating anything so one click
        // cannot leave older runtime records to reappear on the next refresh.
        const { conversationId, runtimeIds: allRuntimeIds } = await sync.ensureConversationIdentity(session.id);
        await maybeCleanupWorktree(session.id, session.metadata?.path, session.metadata?.machineId);

        const runtimeById = new Map(sessions.map((item) => [item.id, item]));
        await Promise.allSettled(allRuntimeIds.map(async (sessionId) => {
            const runtime = runtimeById.get(sessionId);
            if (runtime?.active || runtime?.presence === 'online') {
                await sessionKill(sessionId);
            }
        }));

        const result = await conversationDelete(conversationId);
        if (!result.success || (result.deletedCount ?? 0) < 1) {
            throw new HaplaError(result.message || t('sessionInfo.failedToDeleteSession'), false);
        }

        for (const sessionId of allRuntimeIds) {
            storage.getState().deleteSession(sessionId);
        }
        options.onAfterDelete?.();
    });

    const requestDelete = React.useCallback(() => {
        if (!session) return;
        void (async () => {
            const confirmed = await Modal.confirm(
                t('sessionInfo.deleteSessionConfirm'),
                t('sessionInfo.deleteSessionWarning'),
                {
                    cancelText: t('common.cancel'),
                    confirmText: t('sessionInfo.deleteSession'),
                    destructive: true,
                },
            );
            if (confirmed) performDelete();
        })();
    }, [performDelete, session]);

    return { deleting, requestDelete, runtimeCount: runtimeIds.length };
}
