import * as React from 'react';
import { Modal } from '@/modal';
import { sessionKill } from '@/sync/ops';
import { useLocalSetting } from '@/sync/storage';
import { Session } from '@/sync/storageTypes';
import { t } from '@/text';
import { copySessionMetadataToClipboard, copySessionMetadataAndLogsToClipboard } from '@/utils/copySessionMetadataToClipboard';
import { useRouter } from 'expo-router';
import { useSession } from '@/sync/storage';
import { useDeleteConversationAction } from './useDeleteConversationAction';

export interface SessionActionItem {
    id: string;
    label: string;
    icon: string;
    onPress: () => void;
    destructive?: boolean;
}

interface UseSessionQuickActionsOptions {
    /** Retained for source compatibility; sessions are no longer manually archived. */
    onAfterArchive?: () => void;
    onAfterDelete?: () => void;
    onAfterCopySessionMetadata?: () => void;
}

export function useSessionQuickActions(
    session: Session | null | undefined,
    options: UseSessionQuickActionsOptions = {},
) {
    const {
        onAfterCopySessionMetadata,
        onAfterDelete,
    } = options;
    const router = useRouter();
    const devModeEnabled = useLocalSetting('devModeEnabled');
    const { deleting, requestDelete } = useDeleteConversationAction(session, { onAfterDelete });

    const sleeping = React.useRef(false);
    const sleepSession = React.useCallback(() => {
        if (!session || sleeping.current) return;
        sleeping.current = true;
        void (async () => {
            try {
                const result = await sessionKill(session.id);
                if (!result.success) throw new Error(result.message || '休眠失败，请重试');
                router.replace('/');
            } catch (error) {
                Modal.alert('休眠失败', error instanceof Error ? error.message : '请重试');
            } finally { sleeping.current = false; }
        })();
    }, [router, session]);

    const openDetails = React.useCallback(() => {
        if (!session) return;
        router.push(`/session/${session.id}/info`);
    }, [router, session]);

    const copySessionMetadata = React.useCallback(() => {
        if (!session) return;
        void (async () => {
            const copied = await copySessionMetadataToClipboard(session);
            if (copied) {
                onAfterCopySessionMetadata?.();
            }
        })();
    }, [onAfterCopySessionMetadata, session]);

    const copySessionMetadataAndLogs = React.useCallback(() => {
        if (!session) return;
        void (async () => {
            const copied = await copySessionMetadataAndLogsToClipboard(session);
            if (copied) {
                onAfterCopySessionMetadata?.();
            }
        })();
    }, [onAfterCopySessionMetadata, session]);

    const canCopySessionMetadata = __DEV__ || devModeEnabled;

    const actionItems = React.useMemo<SessionActionItem[]>(() => {
        if (!session) return [];
        const items: SessionActionItem[] = [
            { id: 'details', icon: 'information-circle-outline', label: t('profile.details'), onPress: openDetails },
        ];

        if (session.active && session.metadata?.flavor === 'codex') {
            items.push({ id: 'sleep', icon: 'moon-outline', label: '休眠', onPress: sleepSession });
        }

        if (canCopySessionMetadata) {
            items.push({ id: 'copy-metadata', icon: 'bug-outline', label: t('sessionInfo.copyMetadata'), onPress: copySessionMetadata });
            items.push({ id: 'copy-metadata-and-logs', icon: 'document-text-outline', label: t('sessionInfo.copyMetadata') + ' & Client Logs', onPress: copySessionMetadataAndLogs });
        }

        items.push({
            id: 'delete',
            icon: 'trash-outline',
            label: t('sessionInfo.deleteSession'),
            onPress: requestDelete,
            destructive: true,
        });

        return items;
    }, [
        canCopySessionMetadata,
        copySessionMetadata,
        copySessionMetadataAndLogs,
        openDetails,
        requestDelete,
        sleepSession,
        session,
    ]);

    const showActionAlert = React.useCallback(() => {
        const buttons: Array<{ text: string; onPress?: () => void; style?: 'cancel' | 'destructive' | 'default' }> = actionItems.map(item => ({
            text: item.label,
            onPress: item.onPress,
            style: item.destructive ? 'destructive' as const : undefined,
        }));
        buttons.push({ text: t('common.cancel'), style: 'cancel' });
        Modal.alert('Session', undefined, buttons);
    }, [actionItems]);

    return {
        actionItems,
        showActionAlert,
        canCopySessionMetadata,
        copySessionMetadata,
        copySessionMetadataAndLogs,
        openDetails,
        deleting,
    };
}

/**
 * Lightweight hook for list items that only have a sessionId.
 * Returns a long-press handler that shows the action alert on mobile.
 */
export function useSessionActionAlert(sessionId: string) {
    const session = useSession(sessionId);
    const { showActionAlert } = useSessionQuickActions(session, {});
    return session ? showActionAlert : undefined;
}
