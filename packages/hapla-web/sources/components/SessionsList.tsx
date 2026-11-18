import { visibleSessionsByQuestion } from '@/sync/sessionQuestionOrder';
import React from 'react';
import { FlatList, Platform, Pressable, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { usePathname, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Text } from '@/components/StyledText';
import { Typography } from '@/constants/Typography';
import { useNavigateToSession } from '@/hooks/useNavigateToSession';
import { useNewSessionDraft } from '@/hooks/useNewSessionDraft';
import { useSessionActionAlert } from '@/hooks/useSessionQuickActions';
import { useVisibleSessionListViewData } from '@/hooks/useVisibleSessionListViewData';
import {
    type SessionListViewItem,
    type SessionRowData,
    useAllMachines,
    useSetting,
} from '@/sync/storage';
import type { Machine } from '@/sync/storageTypes';
import { t } from '@/text';
import {
    formatLastSeen,
    formatPathRelativeToHome,
} from '@/utils/sessionUtils';
import { requestReview } from '@/utils/requestReview';
import { getRepoPath, isWorktreePath } from '@/utils/worktree';
import { ProjectGitStatus } from './ProjectGitStatus';
import { ProjectIdentityIcon } from './ProjectIdentityIcon';
import {
    type SessionActionsAnchor,
    SessionActionsPopover,
} from './SessionActionsPopover';
import { SessionActionsTrigger } from './SessionActionsTrigger';
import { sessionAgentLabel } from './SessionAgentIcon';
import { StatusDot } from './StatusDot';
import { UpdateBanner } from './UpdateBanner';
import { layout } from './layout';

type WorkspaceGroupItem = Extract<SessionListViewItem, { type: 'workspace-group' }>;
type WorkspaceGroup = WorkspaceGroupItem['group'];

const stylesheet = StyleSheet.create((theme) => ({
    container: {
        flex: 1,
        flexDirection: 'row',
        justifyContent: 'center',
        alignItems: 'stretch',
        backgroundColor: theme.colors.groupped.background,
    },
    contentContainer: {
        flex: 1,
        maxWidth: layout.maxWidth,
    },
    folderSection: {
        paddingTop: 12,
    },
    folderHeader: {
        minHeight: 52,
        paddingHorizontal: 16,
        paddingBottom: 8,
        flexDirection: 'row',
        alignItems: 'center',
    },
    folderIdentity: {
        flex: 1,
        minWidth: 0,
        marginLeft: 10,
    },
    folderTitleRow: {
        minWidth: 0,
        flexDirection: 'row',
        alignItems: 'center',
    },
    folderTitle: {
        flex: 1,
        minWidth: 0,
        color: theme.colors.text,
        fontSize: theme.typography.label.fontSize,
        lineHeight: theme.typography.label.lineHeight,
        fontWeight: '600',
        ...Typography.default('semiBold'),
    },
    onlineCount: {
        height: 26,
        minWidth: 24,
        marginLeft: 8,
        paddingHorizontal: 7,
        borderRadius: 10,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: theme.colors.surfaceHigh,
    },
    onlineCountText: {
        marginLeft: 5,
        color: theme.colors.textSecondary,
        fontSize: theme.typography.caption.fontSize,
        lineHeight: theme.typography.caption.lineHeight,
        ...Typography.default('semiBold'),
    },
    folderMetaRow: {
        minWidth: 0,
        marginTop: 2,
        flexDirection: 'row',
        alignItems: 'center',
    },
    folderPath: {
        flex: 1,
        minWidth: 0,
        color: theme.colors.textSecondary,
        fontSize: theme.typography.caption.fontSize,
        lineHeight: theme.typography.caption.lineHeight,
        ...Typography.default(),
    },
    folderGitStatus: {
        flexShrink: 0,
        marginLeft: 8,
    },
    addButton: {
        width: 40,
        height: 40,
        marginLeft: 4,
        borderRadius: 11,
        alignItems: 'center',
        justifyContent: 'center',
    },
    addButtonPressed: {
        backgroundColor: theme.colors.surfacePressed,
    },
    addButtonDisabled: {
        opacity: 0.35,
    },
    folderCard: {
        marginHorizontal: 12,
        borderRadius: 14,
        overflow: 'hidden',
        backgroundColor: theme.colors.surface,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.divider,
    },
    sessionRow: {
        minHeight: 66,
        paddingLeft: 14,
        paddingRight: 8,
        flexDirection: 'row',
        alignItems: 'center',
        backgroundColor: theme.colors.surface,
    },
    sessionRowCompact: {
        minHeight: 64,
    },
    sessionRowSelected: {
        backgroundColor: theme.colors.surfaceSelected,
    },
    sessionRowPressed: {
        backgroundColor: theme.colors.surfacePressed,
    },
    rowDivider: {
        borderBottomWidth: StyleSheet.hairlineWidth,
        borderBottomColor: theme.colors.divider,
    },
    statusDotSlot: {
        width: 18,
        height: 24,
        alignItems: 'center',
        justifyContent: 'center',
        marginRight: 4,
    },
    sessionContent: {
        flex: 1,
        minWidth: 0,
        paddingVertical: 8,
    },
    sessionTitleRow: {
        flexDirection: 'row',
        alignItems: 'center',
        minWidth: 0,
    },
    sessionTitle: {
        flex: 1,
        minWidth: 0,
        color: theme.colors.text,
        fontSize: theme.typography.body.fontSize,
        lineHeight: theme.typography.body.lineHeight,
        ...Typography.default('semiBold'),
    },
    sessionTitleOffline: {
        color: theme.colors.textSecondary,
    },
    sessionMeta: {
        color: theme.colors.textSecondary,
        fontSize: theme.typography.caption.fontSize,
        lineHeight: theme.typography.caption.lineHeight,
        marginTop: 2,
        ...Typography.default(),
    },
    draftMark: {
        width: 22,
        height: 22,
        marginLeft: 4,
        alignItems: 'center',
        justifyContent: 'center',
    },
    todoBadge: {
        height: 26,
        minWidth: 28,
        marginLeft: 4,
        paddingHorizontal: 6,
        borderRadius: 6,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: theme.colors.surfaceHighest,
    },
    todoText: {
        color: theme.colors.textSecondary,
        fontSize: theme.typography.caption.fontSize,
        lineHeight: theme.typography.caption.lineHeight,
        ...Typography.default('semiBold'),
    },
    offlineToggle: {
        minHeight: 44,
        paddingLeft: 15,
        paddingRight: 12,
        flexDirection: 'row',
        alignItems: 'center',
        backgroundColor: theme.colors.surfaceHigh,
    },
    offlineTogglePressed: {
        backgroundColor: theme.colors.surfacePressed,
    },
    offlineToggleIcon: {
        width: 18,
        alignItems: 'center',
        justifyContent: 'center',
        marginRight: 5,
    },
    offlineToggleText: {
        flex: 1,
        color: theme.colors.textSecondary,
        fontSize: theme.typography.caption.fontSize,
        lineHeight: theme.typography.caption.lineHeight,
        ...Typography.default('semiBold'),
    },
}));

function selectedSessionIdFromPathname(pathname: string): string | undefined {
    if (!pathname.startsWith('/session/')) return undefined;
    const raw = pathname.split('/')[2];
    if (!raw) return undefined;
    try {
        return decodeURIComponent(raw);
    } catch {
        return raw;
    }
}

export function SessionsList() {
    const styles = stylesheet;
    const safeArea = useSafeAreaInsets();
    const data = useVisibleSessionListViewData();
    const pathname = usePathname();
    const compact = useSetting('compactSessionView');
    const machines = useAllMachines({ includeOffline: true });
    const selectedSessionId = selectedSessionIdFromPathname(pathname);
    const [expandedOfflineGroups, setExpandedOfflineGroups] = React.useState<Set<string>>(() => new Set());
    const lastSelectionLocation = React.useRef<string | null>(null);
    const machineMap = React.useMemo(
        () => new Map(machines.map((machine) => [machine.id, machine])),
        [machines],
    );

    React.useEffect(() => {
        if (!data || !selectedSessionId) {
            lastSelectionLocation.current = null;
            return;
        }

        const selectedGroup = data.find((item) => (
            item.group.offlineSessions.some((session) => session.id === selectedSessionId)
        ));
        const location = selectedGroup
            ? `${selectedSessionId}\u0000${selectedGroup.group.key}\u0000offline`
            : `${selectedSessionId}\u0000online`;

        if (selectedGroup && lastSelectionLocation.current !== location) {
            setExpandedOfflineGroups((current) => {
                if (current.has(selectedGroup.group.key)) return current;
                const next = new Set(current);
                next.add(selectedGroup.group.key);
                return next;
            });
        }
        lastSelectionLocation.current = location;
    }, [data, selectedSessionId]);

    React.useEffect(() => {
        if (data && data.length > 0) requestReview();
    }, [data?.length]);

    const toggleOffline = React.useCallback((key: string) => {
        setExpandedOfflineGroups((current) => {
            const next = new Set(current);
            if (next.has(key)) next.delete(key);
            else next.add(key);
            return next;
        });
    }, []);

    const renderItem = React.useCallback(({ item }: { item: SessionListViewItem }) => (
        <WorkspaceFolder
            group={item.group}
            machine={item.group.machineId ? machineMap.get(item.group.machineId) ?? null : null}
            compact={compact}
            selectedSessionId={selectedSessionId}
            offlineExpanded={expandedOfflineGroups.has(item.group.key)}
            onToggleOffline={toggleOffline}
        />
    ), [compact, expandedOfflineGroups, machineMap, selectedSessionId, toggleOffline]);

    if (!data) return <View style={styles.container} />;

    return (
        <View style={styles.container}>
            <View style={styles.contentContainer}>
                <FlatList
                    data={data}
                    renderItem={renderItem}
                    keyExtractor={(item) => item.group.key}
                    extraData={expandedOfflineGroups}
                    contentContainerStyle={{
                        paddingBottom: safeArea.bottom + 128,
                        maxWidth: layout.maxWidth,
                    }}
                    ListHeaderComponent={UpdateBanner}
                    windowSize={5}
                    maxToRenderPerBatch={8}
                    initialNumToRender={10}
                />
            </View>
        </View>
    );
}

const WorkspaceFolder = React.memo(function WorkspaceFolder({
    group,
    machine,
    compact,
    selectedSessionId,
    offlineExpanded,
    onToggleOffline,
}: {
    group: WorkspaceGroup;
    machine: Machine | null;
    compact: boolean;
    selectedSessionId?: string;
    offlineExpanded: boolean;
    onToggleOffline: (key: string) => void;
}) {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    const router = useRouter();
    const draft = useNewSessionDraft();
    const firstSession = group.onlineSessions[0] ?? group.offlineSessions[0];
    if (!firstSession) return null;

    const machineName = machine?.metadata?.displayName
        || machine?.metadata?.host
        || group.machineId
        || t('status.unknown');
    const sessionPath = firstSession.path || group.normalizedPath || '';
    const displayPath = sessionPath
        ? formatPathRelativeToHome(sessionPath, firstSession.homeDir ?? undefined)
        : firstSession.subtitle;
    const folderName = group.displayName || firstSession.subtitle || 'Workspace';
    const canCreate = !!firstSession.machineId && machine?.active === true;
    const onlineCount = group.onlineSessions.length;
    const offlineCount = group.offlineSessions.length;
    const visibleSessions = visibleSessionsByQuestion(group, offlineExpanded);

    const handleAdd = (event: any) => {
        event.stopPropagation?.();
        if (!canCreate || !firstSession.machineId) return;
        const worktree = isWorktreePath(sessionPath);
        const repoPath = worktree ? getRepoPath(sessionPath) : sessionPath;
        draft.setMachineId(firstSession.machineId);
        draft.setPath(formatPathRelativeToHome(repoPath, firstSession.homeDir ?? undefined));
        draft.setSessionType(worktree ? 'worktree' : 'simple');
        draft.setWorktreeKey(worktree ? sessionPath : null);
        router.navigate('/new');
    };

    return (
        <View style={styles.folderSection}>
            <View style={styles.folderHeader}>
                <ProjectIdentityIcon path={sessionPath} fallback={folderName} size={30} />
                <View style={styles.folderIdentity}>
                    <View style={styles.folderTitleRow}>
                        <Text style={styles.folderTitle} numberOfLines={1}>{folderName}</Text>
                        {onlineCount > 0 && (
                            <View
                                style={styles.onlineCount}
                                accessibilityLabel={`${onlineCount} ${t('status.online')}`}
                            >
                                <StatusDot color={theme.colors.status.connected} size={6} />
                                <Text style={styles.onlineCountText}>{onlineCount}</Text>
                            </View>
                        )}
                    </View>
                    <View style={styles.folderMetaRow}>
                        <Text style={styles.folderPath} numberOfLines={1}>
                            {displayPath}{machineName ? ` · ${machineName}` : ''}
                        </Text>
                        <View style={styles.folderGitStatus}>
                            <ProjectGitStatus sessionId={firstSession.id} />
                        </View>
                    </View>
                </View>
                <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`New session in ${folderName}`}
                    accessibilityState={{ disabled: !canCreate }}
                    disabled={!canCreate}
                    hitSlop={4}
                    onPress={handleAdd}
                    style={({ pressed }) => [
                        styles.addButton,
                        pressed && styles.addButtonPressed,
                        !canCreate && styles.addButtonDisabled,
                    ]}
                >
                    <Ionicons name="add-outline" size={18} color={theme.colors.textSecondary} />
                </Pressable>
            </View>

            <View style={styles.folderCard}>
                {offlineCount > 0 && (
                    <Pressable
                        accessibilityRole="button"
                        accessibilityLabel={`${folderName}, ${offlineCount} ${t('status.offline')}`}
                        accessibilityState={{ expanded: offlineExpanded }}
                        onPress={() => onToggleOffline(group.key)}
                        style={({ pressed }) => [
                            styles.offlineToggle,
                            offlineExpanded && styles.rowDivider,
                            pressed && styles.offlineTogglePressed,
                        ]}
                    >
                        <View style={styles.offlineToggleIcon}>
                            <Ionicons
                                name={offlineExpanded ? 'chevron-down' : 'chevron-forward'}
                                size={14}
                                color={theme.colors.groupped.chevron}
                            />
                        </View>
                        <Text style={styles.offlineToggleText}>
                            {offlineCount} {t('status.offline')}
                        </Text>
                    </Pressable>
                )}
                {visibleSessions.map((session, index) => (
                    <SessionRow
                        key={session.id}
                        session={session}
                        compact={compact}
                        selected={selectedSessionId === session.id}
                        showDivider={index < visibleSessions.length - 1}
                    />
                ))}
            </View>
        </View>
    );
});

const SessionRow = React.memo(function SessionRow({
    session,
    compact,
    selected,
    showDivider,
}: {
    session: SessionRowData;
    compact: boolean;
    selected: boolean;
    showDivider: boolean;
}) {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    const router = useRouter();
    const navigateToSession = useNavigateToSession();
    const showActionAlert = useSessionActionAlert(session.id);
    const [actionsAnchor, setActionsAnchor] = React.useState<SessionActionsAnchor | null>(null);
    const agent = sessionAgentLabel(session.flavor);
    const presentation = session.state === 'disconnected'
        ? {
            label: session.lastUserMessageAt != null ? `最后提问 ${formatLastSeen(session.lastUserMessageAt, false)}` : session.questionTimeIndexed ? '尚未提问' : '正在整理提问时间',
            color: theme.colors.status.disconnected,
            pulse: false,
        }
        : session.state === 'permission_required'
            ? {
                label: t('status.permissionRequired'),
                color: theme.colors.permission.bypass,
                pulse: true,
            }
            : session.state === 'thinking'
                ? {
                label: t('sessionInfo.thinking'),
                    color: theme.colors.status.connected,
                    pulse: true,
                }
                : {
                    label: t('status.online'),
                    color: theme.colors.status.connected,
                    pulse: false,
                };

    const prefetchSession = React.useCallback(() => {
        router.prefetch(`/session/${encodeURIComponent(session.id)}`);
    }, [router, session.id]);
    const openSession = React.useCallback(() => {
        navigateToSession(session.id);
    }, [navigateToSession, session.id]);
    const handleContextMenu = React.useCallback((event: any) => {
        event.preventDefault?.();
        event.stopPropagation?.();
        setActionsAnchor({
            type: 'point',
            x: event.nativeEvent.clientX ?? event.nativeEvent.pageX ?? 0,
            y: event.nativeEvent.clientY ?? event.nativeEvent.pageY ?? 0,
        });
    }, []);
    const platformMenuProps = Platform.OS === 'web'
        ? { onContextMenu: handleContextMenu } as any
        : { onLongPress: showActionAlert };

    return (
        <>
            <Pressable
                accessibilityRole="button"
                accessibilityLabel={`${session.name}, ${agent}, ${presentation.label}`}
                accessibilityState={{ selected }}
                onPress={openSession}
                onHoverIn={Platform.OS === 'web' ? prefetchSession : undefined}
                onPressIn={Platform.OS === 'web' ? prefetchSession : undefined}
                {...platformMenuProps}
                style={({ pressed }) => [
                    styles.sessionRow,
                    compact && styles.sessionRowCompact,
                    showDivider && styles.rowDivider,
                    selected && styles.sessionRowSelected,
                    pressed && styles.sessionRowPressed,
                ]}
            >
                <View style={styles.statusDotSlot}>
                    <StatusDot
                        color={presentation.color}
                        isPulsing={presentation.pulse}
                        size={7}
                    />
                </View>
                <View style={styles.sessionContent}>
                    <View style={styles.sessionTitleRow}>
                        <Text
                            style={[
                                styles.sessionTitle,
                                session.state === 'disconnected' && styles.sessionTitleOffline,
                            ]}
                            numberOfLines={compact ? 1 : 2}
                        >
                            {session.name}
                        </Text>
                        {session.hasDraft && (
                            <View style={styles.draftMark} accessibilityLabel="Draft">
                                <Ionicons name="create-outline" size={14} color={theme.colors.textSecondary} />
                            </View>
                        )}
                        {session.totalTodosCount > 0 && (
                            <View
                                style={styles.todoBadge}
                                accessibilityLabel={`${session.completedTodosCount} of ${session.totalTodosCount} tasks complete`}
                            >
                                <Text style={styles.todoText}>
                                    {session.completedTodosCount}/{session.totalTodosCount}
                                </Text>
                            </View>
                        )}
                    </View>
                    <Text style={styles.sessionMeta} numberOfLines={1}>
                        {agent} · {presentation.label}
                    </Text>
                </View>
                <SessionActionsTrigger
                    label={`Actions for ${session.name}`}
                    onOpen={setActionsAnchor}
                />
            </Pressable>
            {Platform.OS === 'web' && (
                <SessionActionsPopover
                    anchor={actionsAnchor}
                    onClose={() => setActionsAnchor(null)}
                    sessionId={session.id}
                    visible={!!actionsAnchor}
                />
            )}
        </>
    );
});
