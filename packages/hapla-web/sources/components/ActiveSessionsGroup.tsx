import React from 'react';
import { View, Pressable, Platform } from 'react-native';
import { Text } from '@/components/StyledText';
import { useRouter } from 'expo-router';
import { Machine } from '@/sync/storageTypes';
import { SessionRowData } from '@/sync/storage';
import Ionicons from '@expo/vector-icons/Ionicons';
import { type SessionState, formatLastSeen, formatPathRelativeToHome, vibingMessages } from '@/utils/sessionUtils';
import { Typography } from '@/constants/Typography';
import { StatusDot } from './StatusDot';
import { useAllMachines, useSetting } from '@/sync/storage';
import { StyleSheet } from 'react-native-unistyles';
import { ProjectGitStatus } from './ProjectGitStatus';
import { t } from '@/text';
import { useNavigateToSession } from '@/hooks/useNavigateToSession';
import { SessionActionsAnchor, SessionActionsPopover } from './SessionActionsPopover';
import { useSessionActionAlert } from '@/hooks/useSessionQuickActions';
import { SessionAgentIcon, sessionAgentLabel } from './SessionAgentIcon';
import { ProjectIdentityIcon } from './ProjectIdentityIcon';
import { SessionActionsTrigger } from './SessionActionsTrigger';

const stylesheet = StyleSheet.create((theme, runtime) => ({
    container: {
        backgroundColor: theme.colors.groupped.background,
        paddingTop: 6,
    },
    projectCard: {
        backgroundColor: theme.colors.surface,
        marginBottom: 10,
        marginHorizontal: 16,
        borderRadius: 16,
        overflow: 'hidden',
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.divider,
    },
    sectionHeader: {
        paddingTop: 16,
        paddingBottom: 9,
        paddingHorizontal: 20,
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
    },
    sectionHeaderLeft: {
        flexDirection: 'row',
        alignItems: 'center',
        flex: 1,
        marginRight: 12,
        minWidth: 0,
    },
    projectIcon: {
        width: 28,
        height: 28,
        borderRadius: 8,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: theme.colors.surfaceHigh,
        marginRight: 10,
    },
    projectText: {
        flex: 1,
        minWidth: 0,
    },
    sectionHeaderPath: {
        ...Typography.default('semiBold'),
        color: theme.colors.text,
        fontSize: theme.typography.label.fontSize,
        lineHeight: theme.typography.label.lineHeight,
        fontWeight: '600',
    },
    sectionHeaderSubtitle: {
        ...Typography.default(),
        color: theme.colors.textSecondary,
        fontSize: theme.typography.caption.fontSize,
        lineHeight: theme.typography.caption.lineHeight,
        marginTop: 1,
    },
    sectionHeaderMachine: {
        ...Typography.default('regular'),
        color: theme.colors.groupped.sectionTitle,
        fontSize: Platform.select({ ios: theme.typography.small.fontSize, default: theme.typography.label.fontSize }),
        lineHeight: Platform.select({ ios: theme.typography.label.lineHeight, default: theme.typography.label.lineHeight }),
        letterSpacing: Platform.select({ ios: -0.08, default: 0.1 }),
        fontWeight: Platform.select({ ios: 'normal', default: '500' }),
        maxWidth: 150,
        textAlign: 'right',
    },
    sessionRow: {
        minHeight: 92,
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 14,
        paddingVertical: 13,
        backgroundColor: theme.colors.surface,
    },
    sessionRowWithBorder: {
        borderBottomWidth: StyleSheet.hairlineWidth,
        borderBottomColor: theme.colors.divider,
    },
    sessionRowSelected: {
        backgroundColor: theme.colors.surfaceSelected,
    },
    sessionRowPressed: {
        backgroundColor: theme.colors.surfacePressed,
    },
    sessionContent: {
        flex: 1,
        minWidth: 0,
        marginLeft: 12,
        justifyContent: 'center',
    },
    sessionTitleRow: {
        flexDirection: 'row',
        alignItems: 'center',
        marginBottom: 8,
    },
    sessionTitle: {
        flex: 1,
        fontSize: theme.typography.body.fontSize,
        lineHeight: theme.typography.body.lineHeight,
        fontWeight: '600',
        ...Typography.default('semiBold'),
    },
    sessionTitleConnected: {
        color: theme.colors.text,
    },
    sessionTitleDisconnected: {
        color: theme.colors.textSecondary,
    },
    statusRow: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between'
    },
    statusLeft: {
        flex: 1,
        minWidth: 0,
        flexDirection: 'row',
        alignItems: 'center',
    },
    agentLabel: {
        fontSize: theme.typography.caption.fontSize,
        lineHeight: theme.typography.caption.lineHeight,
        color: theme.colors.textSecondary,
        marginLeft: 8,
        ...Typography.default(),
    },
    statusDotContainer: {
        alignItems: 'center',
        justifyContent: 'center',
        height: 16,
        marginTop: 2,
        marginRight: 4,
    },
    statusText: {
        fontSize: theme.typography.caption.fontSize,
        fontWeight: '500',
        lineHeight: theme.typography.caption.lineHeight,
        ...Typography.default(),
    },
    newSessionButton: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        paddingVertical: 12,
        paddingHorizontal: 16,
        borderTopWidth: StyleSheet.hairlineWidth,
        borderTopColor: theme.colors.divider,
        backgroundColor: theme.colors.surface,
    },
    newSessionButtonDisabled: {
        opacity: 0.5,
    },
    newSessionButtonContent: {
        flexDirection: 'row',
        alignItems: 'center',
    },
    newSessionButtonIcon: {
        marginRight: 6,
        width: 18,
        height: 18,
        alignItems: 'center',
        justifyContent: 'center',
    },
    newSessionButtonText: {
        fontSize: theme.typography.label.fontSize,
        fontWeight: '500',
        color: theme.colors.text,
        ...Typography.default('semiBold'),
    },
    newSessionButtonTextDisabled: {
        color: theme.colors.textSecondary,
    },
    taskStatusContainer: {
        flexDirection: 'row',
        alignItems: 'center',
        backgroundColor: theme.colors.surfaceHighest,
        paddingHorizontal: 4,
        height: 16,
        borderRadius: 4,
    },
    taskStatusText: {
        fontSize: theme.typography.caption.fontSize,
        fontWeight: '500',
        color: theme.colors.textSecondary,
        ...Typography.default(),
    },
    swipeAction: {
        width: 112,
        height: '100%',
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: theme.colors.status.error,
    },
    swipeActionText: {
        marginTop: 4,
        fontSize: theme.typography.caption.fontSize,
        color: '#FFFFFF',
        textAlign: 'center',
        ...Typography.default('semiBold'),
    },
}));

const STATUS_CONFIG: Record<SessionState, { color: string; dotColor: string; isPulsing: boolean; isConnected: boolean }> = {
    disconnected: { color: '#999', dotColor: '#999', isPulsing: false, isConnected: false },
    thinking: { color: '#007AFF', dotColor: '#007AFF', isPulsing: true, isConnected: true },
    waiting: { color: '#34C759', dotColor: '#34C759', isPulsing: false, isConnected: true },
    permission_required: { color: '#FF9500', dotColor: '#FF9500', isPulsing: true, isConnected: true },
};

interface ActiveSessionsGroupProps {
    sessions: SessionRowData[];
    selectedSessionId?: string;
}


export function ActiveSessionsGroup({ sessions, selectedSessionId }: ActiveSessionsGroupProps) {
    const styles = stylesheet;
    const machines = useAllMachines();
    const machinesMap = React.useMemo(() => {
        const map: Record<string, Machine> = {};
        machines.forEach(machine => {
            map[machine.id] = machine;
        });
        return map;
    }, [machines]);

    // Group sessions by project, then associate with machine
    const projectGroups = React.useMemo(() => {
        const groups = new Map<string, {
            path: string;
            displayPath: string;
            machines: Map<string, {
                machine: Machine | null;
                machineName: string;
                sessions: SessionRowData[];
            }>;
        }>();

        sessions.forEach(session => {
            const projectPath = session.path || '';
            const machineId = session.machineId || 'unknown';

            // Get machine info
            const machine = machineId !== 'unknown' ? machinesMap[machineId] : null;
            const machineName = machine?.metadata?.displayName ||
                machine?.metadata?.host ||
                (machineId !== 'unknown' ? machineId : '<unknown>');

            // Get or create project group
            let projectGroup = groups.get(projectPath);
            if (!projectGroup) {
                const displayPath = formatPathRelativeToHome(projectPath, session.homeDir ?? undefined);
                projectGroup = {
                    path: projectPath,
                    displayPath,
                    machines: new Map()
                };
                groups.set(projectPath, projectGroup);
            }

            // Get or create machine group within project
            let machineGroup = projectGroup.machines.get(machineId);
            if (!machineGroup) {
                machineGroup = {
                    machine,
                    machineName,
                    sessions: []
                };
                projectGroup.machines.set(machineId, machineGroup);
            }

            // Add session to machine group
            machineGroup.sessions.push(session);
        });

        // Sort sessions within each machine group by creation time (newest first)
        groups.forEach(projectGroup => {
            projectGroup.machines.forEach(machineGroup => {
                machineGroup.sessions.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
            });
        });

        return groups;
    }, [sessions, machinesMap]);

    // Sort project groups by display path
    const sortedProjectGroups = React.useMemo(() => {
        return Array.from(projectGroups.entries()).sort(([, groupA], [, groupB]) => {
            return groupA.displayPath.localeCompare(groupB.displayPath);
        });
    }, [projectGroups]);

    return (
        <View style={styles.container}>
            {sortedProjectGroups.map(([projectPath, projectGroup]) => {
                // Get the first machine name from this project's machines
                const firstMachine = Array.from(projectGroup.machines.values())[0];
                const machineName = projectGroup.machines.size === 1
                    ? firstMachine?.machineName
                    : `${projectGroup.machines.size} machines`;

                return (
                    <View key={projectPath}>
                        {/* Section header on grouped background */}
                        <View style={styles.sectionHeader}>
                            <View style={styles.sectionHeaderLeft}>
                                <View style={styles.projectIcon}>
                                    <ProjectIdentityIcon
                                        path={projectPath}
                                        fallback={projectGroup.displayPath}
                                        size={28}
                                    />
                                </View>
                                <View style={styles.projectText}>
                                    <Text style={styles.sectionHeaderPath} numberOfLines={1}>
                                        {projectGroup.displayPath.split('/').filter(Boolean).at(-1) || projectGroup.displayPath}
                                    </Text>
                                    <Text style={styles.sectionHeaderSubtitle} numberOfLines={1}>
                                        {projectGroup.displayPath}
                                    </Text>
                                </View>
                            </View>
                            {/* Show git status instead of machine name */}
                            {(() => {
                                // Get the first session from any machine in this project
                                const firstSession = Array.from(projectGroup.machines.values())[0]?.sessions[0];
                                return firstSession ? (
                                    <ProjectGitStatus sessionId={firstSession.id} />
                                ) : (
                                    <Text style={styles.sectionHeaderMachine} numberOfLines={1}>
                                        {machineName}
                                    </Text>
                                );
                            })()}
                        </View>

                        {/* Card with just the sessions */}
                        <View style={styles.projectCard}>
                            {/* Sessions grouped by machine within the card */}
                            {Array.from(projectGroup.machines.entries())
                                .sort(([, machineA], [, machineB]) => machineA.machineName.localeCompare(machineB.machineName))
                                .map(([machineId, machineGroup]) => (
                                    <View key={`${projectPath}-${machineId}`}>
                                        {machineGroup.sessions.map((session, index) => (
                                            <CompactSessionRow
                                                key={session.id}
                                                session={session}
                                                selected={selectedSessionId === session.id}
                                                showBorder={index < machineGroup.sessions.length - 1 ||
                                                    Array.from(projectGroup.machines.keys()).indexOf(machineId) < projectGroup.machines.size - 1}
                                            />
                                        ))}
                                    </View>
                                ))}
                        </View>
                    </View>
                );
            })}
        </View>
    );
}

// Compact session row component with status line
const CompactSessionRow = React.memo(({ session, selected, showBorder }: { session: SessionRowData; selected?: boolean; showBorder?: boolean }) => {
    const styles = stylesheet;
    const status = STATUS_CONFIG[session.state];
    const navigateToSession = useNavigateToSession();
    const [actionsAnchor, setActionsAnchor] = React.useState<SessionActionsAnchor | null>(null);

    const vibingMessage = React.useMemo(() => {
        return vibingMessages[Math.floor(Math.random() * vibingMessages.length)].toLowerCase() + '…';
    }, [session.state]);

    const statusText = session.state === 'thinking'
        ? vibingMessage
        : session.state === 'disconnected'
            ? t('status.lastSeen', { time: formatLastSeen(session.activeAt!, false) })
            : session.state === 'permission_required'
                ? t('status.permissionRequired')
                : t('status.online');

    const handlePress = React.useCallback(() => {
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

    const showActionAlert = useSessionActionAlert(session.id);
    const menuProps = Platform.OS === 'web' ? {
        onContextMenu: handleContextMenu,
    } as any : {
        onLongPress: showActionAlert,
    };

    const itemContent = (
        <Pressable
            accessibilityRole="button"
            accessibilityLabel={`${session.name}, ${sessionAgentLabel(session.flavor)}, ${statusText}`}
            style={({ pressed }) => [
                styles.sessionRow,
                showBorder && styles.sessionRowWithBorder,
                selected && styles.sessionRowSelected,
                pressed && styles.sessionRowPressed,
            ]}
            onPress={handlePress}
            {...menuProps}
        >
            <SessionAgentIcon flavor={session.flavor} size={40} />
            <View style={styles.sessionContent}>
                <View style={styles.sessionTitleRow}>
                    <Text
                        style={[
                            styles.sessionTitle,
                            status.isConnected ? styles.sessionTitleConnected : styles.sessionTitleDisconnected
                        ]}
                        numberOfLines={2}
                    >
                        {session.name}
                    </Text>
                </View>

                <View style={styles.statusRow}>
                    <View style={styles.statusLeft}>
                        <View style={styles.statusDotContainer}>
                            <StatusDot color={status.dotColor} isPulsing={status.isPulsing} />
                        </View>
                        <Text style={[
                            styles.statusText,
                            { color: status.color }
                        ]}>
                            {statusText}
                        </Text>
                        <Text style={styles.agentLabel} numberOfLines={1}>
                            {sessionAgentLabel(session.flavor)}
                        </Text>
                    </View>

                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, transform: [{ translateY: 1 }] }}>
                        {session.hasDraft && (
                            <View style={styles.taskStatusContainer}>
                                <Ionicons
                                    name="create-outline"
                                    size={10}
                                    color={styles.taskStatusText.color}
                                />
                            </View>
                        )}

                        {session.totalTodosCount > 0 && session.completedTodosCount < session.totalTodosCount && (
                            <View style={styles.taskStatusContainer}>
                                <Ionicons
                                    name="bulb-outline"
                                    size={10}
                                    color={styles.taskStatusText.color}
                                    style={{ marginRight: 2 }}
                                />
                                <Text style={styles.taskStatusText}>
                                    {session.completedTodosCount}/{session.totalTodosCount}
                                </Text>
                            </View>
                        )}
                    </View>
                </View>
            </View>
            <SessionActionsTrigger
                label={`Actions for ${session.name}`}
                onOpen={setActionsAnchor}
            />
        </Pressable>
    );

    return (
        <>
            {itemContent}
            <SessionActionsPopover
                anchor={actionsAnchor}
                onClose={() => setActionsAnchor(null)}
                sessionId={session.id}
                visible={!!actionsAnchor}
            />
        </>
    );
});
