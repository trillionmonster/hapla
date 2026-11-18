import { AgentContentView } from '@/components/AgentContentView';
import { CodexProtocolDiagnostics } from '@/components/CodexProtocolDiagnostics';
import { AgentInput } from '@/components/AgentInput';
import { defaultCodexPreferences } from '@/sync/codexPreferences';
import { PendingRequestsPanel } from '@/components/PendingRequestsPanel';
import { useIsFocused } from '@react-navigation/native';
import { useWorkspaceAttachments } from '@/hooks/useWorkspaceAttachments';
import { attachmentMessage } from '@/utils/workspaceAttachments';
import {
    getAvailableModels,
    getAvailablePermissionModes,
    getDefaultModelKey,
    getDefaultPermissionModeKey,
    getEffortLevelsForModel,
    getDefaultEffortKeyForModel,
    resolveCurrentOption,
    resolveModelCatalog,
    EffortLevel,
} from '@/components/modelModeOptions';
import { getSuggestions } from '@/components/autocomplete/suggestions';
import { ChatHeaderView } from '@/components/ChatHeaderView';
import { ChatList } from '@/components/ChatList';
import { Deferred } from '@/components/Deferred';
import { EmptyMessages } from '@/components/EmptyMessages';
import { SessionActionsAnchor, SessionActionsPopover } from '@/components/SessionActionsPopover';
import { useDraft } from '@/hooks/useDraft';
import { useNavigateToSession } from '@/hooks/useNavigateToSession';
import { useSessionContinuation } from '@/hooks/useSessionContinuation';
import { Modal } from '@/modal';
import { gitStatusSync } from '@/sync/gitStatusSync';
import { sessionAbort } from '@/sync/ops';
import { storage, useAllMachines, useConversationMessages, useConversationSessionIds, useIsDataReady, useLocalSetting, useSessionStream, useSessionUsage, useSetting, useSocketStatus } from '@/sync/storage';
import { useSession } from '@/sync/storage';
import { Session } from '@/sync/storageTypes';
import { sync } from '@/sync/sync';
import { t } from '@/text';
import { isRunningOnMac } from '@/utils/platform';
import { useDeviceType, useHeaderHeight, useIsLandscape } from '@/utils/responsive';
import { formatPathRelativeToHome, getSessionAvatarId, getSessionName, useSessionStatus } from '@/utils/sessionUtils';
import { isVersionSupported, MINIMUM_CLI_VERSION } from '@/utils/versionUtils';
import { resolveContinuationMachine } from '@/utils/sessionContinuation';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useRouter } from 'expo-router';
import * as React from 'react';
import { useMemo } from 'react';
import { ActivityIndicator, Platform, Pressable, Text, View } from 'react-native';
import { useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useUnistyles } from 'react-native-unistyles';
import type { ModelMode, PermissionMode } from '@/components/PermissionModeSelector';
import { CoderWorkspaceBar, type CoderPanel } from '@/components/CoderWorkspaceBar';
import { useWorkspaceMode } from '@/hooks/useWorkspaceMode';
import { preloadCommonCoderViews } from '@/components/tools/views/_all';
import { buildInputHistory } from '@/components/inputHistory';
import { filterMessagesForActiveBranch } from '@/utils/sessionBranches';
import { formatCodexActivity } from '@/utils/codexActivity';
import {
    closeMcpAppWorkspace,
    findLatestMcpApp,
    openMcpAppWorkspace,
    useMcpAppWorkspace,
} from '@/components/tools/mcpAppWorkspace';

const LazyCoderTerminalPanel = React.lazy(() => import('@/components/CoderTerminalPanel'));
const LazyMcpAppSurface = React.lazy(async () => {
    const module = await import('@/components/tools/views/McpAppSurface');
    return { default: module.McpAppSurface };
});

export const SessionView = React.memo((props: { id: string }) => {
    const isFocused = useIsFocused();
    const sessionId = props.id;
    const router = useRouter();
    const session = useSession(sessionId);
    const allMachines = useAllMachines({ includeOffline: true });
    const continuationMachine = React.useMemo(
        () => session ? resolveContinuationMachine(session, allMachines) : null,
        [allMachines, session],
    );
    const isDataReady = useIsDataReady();
    const { theme } = useUnistyles();
    const safeArea = useSafeAreaInsets();
    const isLandscape = useIsLandscape();
    const deviceType = useDeviceType();
    const headerHeight = useHeaderHeight();
    const [sessionActionsAnchor, setSessionActionsAnchor] = React.useState<SessionActionsAnchor | null>(null);

    // Compute header props based on session state
    const headerProps = useMemo(() => {
        if (!isDataReady) {
            // Loading state - show empty header
            return {
                title: '',
                subtitle: undefined,
                avatarId: undefined,
                onAvatarPress: undefined,
                isConnected: false,
                flavor: null
            };
        }

        if (!session) {
            // Deleted state - show deleted message in header
            return {
                title: t('errors.sessionDeleted'),
                subtitle: undefined,
                avatarId: undefined,
                onAvatarPress: undefined,
                isConnected: false,
                flavor: null
            };
        }

        // Normal state - show session info
        // A conversation runtime is intentionally disposable. The workbench is
        // ready whenever its machine daemon is reachable; sending transparently
        // creates/resumes a runtime instead of exposing a misleading lock state.
        const isConnected = continuationMachine?.active === true;
        return {
            title: getSessionName(session),
            subtitle: session.metadata?.path ? formatPathRelativeToHome(session.metadata.path, session.metadata?.homeDir) : undefined,
            avatarId: getSessionAvatarId(session),
            onAvatarPress: () => router.push(`/session/${sessionId}/info`),
            isConnected: isConnected,
            flavor: session.metadata?.flavor || null,
            tintColor: isConnected ? '#000' : '#8E8E93'
        };
    }, [session, continuationMachine?.active, isDataReady, sessionId, router]);

    // Navigation retains route shells; only the focused route owns the chat
    // tree, composer, tool views and media. Drafts/anchors survive in light state.
    if (!isFocused) return null;

    return (
        <>
            {/* Status bar shadow for landscape mode */}
            {isLandscape && deviceType === 'phone' && (
                <View style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    right: 0,
                    height: safeArea.top,
                    backgroundColor: theme.colors.surface,
                    zIndex: 1000,
                    shadowColor: theme.colors.shadow.color,
                    shadowOffset: {
                        width: 0,
                        height: 2,
                    },
                    shadowOpacity: theme.colors.shadow.opacity,
                    shadowRadius: 3,
                    elevation: 5,
                }} />
            )}

            {/* Header - always shown on desktop/Mac, hidden in landscape mode only on actual phones */}
            {!(isLandscape && deviceType === 'phone' && Platform.OS !== 'web') && (
                <View style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    right: 0,
                    zIndex: 1000
                }}>
                    <ChatHeaderView
                        {...headerProps}
                        onBackPress={() => router.back()}
                        avatarMenuExpanded={Platform.OS === 'web' && !!sessionActionsAnchor}
                        avatarMenuSession={session}
                        onAfterAvatarArchive={() => {
                            setSessionActionsAnchor(null);
                            router.replace('/');
                        }}
                        onAfterAvatarDelete={() => {
                            setSessionActionsAnchor(null);
                            router.replace('/');
                        }}
                        onAvatarMenuRequest={Platform.OS === 'web' && session ? setSessionActionsAnchor : undefined}
                    />
                </View>
            )}

            {/* Content based on state */}
            <View style={{ flex: 1, paddingTop: !(isLandscape && deviceType === 'phone' && Platform.OS !== 'web') ? safeArea.top + headerHeight : 0 }}>
                {!isDataReady ? (
                    // Loading state
                    <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
                        <ActivityIndicator size="small" color={theme.colors.textSecondary} />
                    </View>
                ) : !session ? (
                    // Deleted state
                    <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
                        <Ionicons name="trash-outline" size={48} color={theme.colors.textSecondary} />
                        <Text style={{ color: theme.colors.text, fontSize: theme.typography.heading.fontSize, marginTop: 16, fontWeight: '600' }}>{t('errors.sessionDeleted')}</Text>
                        <Text style={{ color: theme.colors.textSecondary, fontSize: theme.typography.body.fontSize, marginTop: 8, textAlign: 'center', paddingHorizontal: 32 }}>{t('errors.sessionDeletedDescription')}</Text>
                    </View>
                ) : (
                    // Normal session view
                    <SessionViewLoaded key={sessionId} sessionId={sessionId} session={session} />
                )}
            </View>
            {Platform.OS === 'web' && session && (
                <SessionActionsPopover
                    anchor={sessionActionsAnchor}
                    onAfterArchive={() => {
                        setSessionActionsAnchor(null);
                        router.replace('/');
                    }}
                    onAfterDelete={() => {
                        setSessionActionsAnchor(null);
                        router.replace('/');
                    }}
                    onClose={() => setSessionActionsAnchor(null)}
                    sessionId={session.id}
                    visible={!!sessionActionsAnchor}
                />
            )}
        </>
    );
});


function SessionViewLoaded({ sessionId, session }: { sessionId: string, session: Session }) {
    const isFocused = useIsFocused();
    const focusedRef = React.useRef(isFocused);
    focusedRef.current = isFocused;
    const { theme } = useUnistyles();
    const router = useRouter();
    const safeArea = useSafeAreaInsets();
    const isLandscape = useIsLandscape();
    const deviceType = useDeviceType();
    const { width: viewportWidth } = useWindowDimensions();
    const [message, setMessage] = React.useState('');
    const [pastedImages, setPastedImages] = React.useState<Array<{ data: string; mediaType: string }>>([]);
    const [isSendingMessage, setIsSendingMessage] = React.useState(false);
    const [latestRequest, setLatestRequest] = React.useState(0);
    const [workspaceMode, setWorkspaceMode] = useWorkspaceMode(sessionId);
    const [coderPanel, setCoderPanel] = React.useState<CoderPanel>(null);
    const coderPreloadedRef = React.useRef(false);
    const coderGitStatusRequestedRef = React.useRef(false);
    const { messages, isLoaded } = useConversationMessages(sessionId);
    const conversationSessionIds = useConversationSessionIds(sessionId);
    const activeMcpApp = useMcpAppWorkspace(sessionId);
    const latestMcpApp = React.useMemo(() => findLatestMcpApp(messages), [messages]);
    const lastAutoOpenedMcpApp = React.useRef<string | null>(null);
    const branchMessages = React.useMemo(
        () => filterMessagesForActiveBranch(messages, session.metadata),
        [messages, session.metadata],
    );
    const inputHistory = React.useMemo(() => buildInputHistory(branchMessages), [branchMessages]);
    const socketStatus = useSocketStatus();
    const stream = useSessionStream(sessionId);
    const isActiveBranchStreaming = Boolean(stream?.text) && (
        !stream?.branchId || stream.branchId === (session.metadata?.activeCodexBranchId ?? 'main')
    );
    const acknowledgedCliVersions = useLocalSetting('acknowledgedCliVersions');
    const navigateToSession = useNavigateToSession();
    const prepareCurrentSessionForSend = useSessionContinuation(session);
    const attachments = useWorkspaceAttachments({ scope: `${sessionId}:${session.metadata?.activeCodexBranchId ?? 'main'}`, active: isFocused, prepareSession: prepareCurrentSessionForSend });

    // Check if CLI version is outdated and not already acknowledged
    const cliVersion = session.metadata?.version;
    const machineId = session.metadata?.machineId;
    const allMachines = useAllMachines({ includeOffline: true });
    const continuationMachine = React.useMemo(
        () => resolveContinuationMachine(session, allMachines),
        [allMachines, session],
    );
    const isCliOutdated = cliVersion && !isVersionSupported(cliVersion, MINIMUM_CLI_VERSION);
    const isAcknowledged = machineId && acknowledgedCliVersions[machineId] === cliVersion;
    const shouldShowCliWarning = isCliOutdated && !isAcknowledged;
    const flavor = session.metadata?.flavor;
    const catalogMachine = continuationMachine ?? allMachines.find((machine) => machine.id === machineId);
    const availableModels = React.useMemo(() => (
        getAvailableModels(flavor, { models: resolveModelCatalog(flavor, catalogMachine?.metadata, session.metadata) }, t)
    ), [flavor, session.metadata, catalogMachine?.metadata]);
    const availableModes = React.useMemo(() => (
        getAvailablePermissionModes(flavor, session.metadata, t)
    ), [flavor, session.metadata]);

    const permissionMode = React.useMemo<PermissionMode | null>(() => (
        resolveCurrentOption(availableModes, [
            session.permissionMode,
            session.metadata?.currentOperatingModeCode,
            getDefaultPermissionModeKey(flavor),
        ])
    ), [availableModes, session.permissionMode, session.metadata?.currentOperatingModeCode, flavor]);

    const modelMode = React.useMemo<ModelMode | null>(() => (
        resolveCurrentOption(availableModels, [
            // "default" is a local sentinel, not a Codex model name. Prefer the
            // app-server's resolved model so the UI reports what is actually used.
            session.modelMode !== 'default' ? session.modelMode : null,
            session.metadata?.currentModelCode,
            session.modelMode,
            getDefaultModelKey(flavor),
        ])
    ), [availableModels, session.modelMode, session.metadata?.currentModelCode, flavor]);

    // Effort level state
    const modelKey = modelMode?.key ?? 'default';
    const availableEffortLevels = React.useMemo<EffortLevel[]>(() => (
        getEffortLevelsForModel(flavor, modelKey, availableModels)
    ), [flavor, modelKey, availableModels]);
    const effortLevel = React.useMemo<EffortLevel | null>(() => (
        resolveCurrentOption(availableEffortLevels, [
            session.effortLevel,
            getDefaultEffortKeyForModel(flavor, modelKey, availableModels),
        ])
    ), [availableEffortLevels, session.effortLevel, flavor, modelKey, availableModels]);

    const sessionStatus = useSessionStatus(session);
    const sessionUsage = useSessionUsage(sessionId);
    const alwaysShowContextSize = useSetting('alwaysShowContextSize');
    const experiments = useSetting('experiments');
    const devModeEnabled = useLocalSetting('devModeEnabled');
    const workbenchReady = continuationMachine?.active === true;
    const isDisconnected = !workbenchReady;
    const connectionStatus = React.useMemo(() => {
        if (socketStatus.status !== 'connected') {
            const connecting = socketStatus.status === 'connecting';
            return {
                text: connecting ? '正在重新连接…' : '连接已断开 · 正在重试',
                color: connecting ? '#FF9500' : '#FF453A',
                dotColor: connecting ? '#FF9500' : '#FF453A',
                isPulsing: connecting,
            };
        }
        if (!workbenchReady) {
            return {
                text: '工作台离线',
                color: '#8E8E93',
                dotColor: '#8E8E93',
                isPulsing: false,
            };
        }
        if (session.metadata?.lifecycleState === 'sleeping') {
            return { text: 'Codex · 休眠，可继续', color: '#8E8E93', dotColor: '#8E8E93', isPulsing: false };
        }
        if (sessionStatus.state === 'disconnected') {
            return { text: 'Codex · 运行时未连接，可恢复', color: '#FF9500', dotColor: '#FF9500', isPulsing: false };
        }
        if (session.agentState?.codexRuntime) {
            return {
                text: sessionStatus.statusText,
                color: sessionStatus.statusColor,
                dotColor: sessionStatus.statusDotColor,
                isPulsing: sessionStatus.isPulsing,
            };
        }
        if (sessionStatus.state === 'permission_required') {
            return {
                text: 'Codex · 等待你的确认',
                color: '#FF9500',
                dotColor: '#FF9500',
                isPulsing: true,
            };
        }
        if (sessionStatus.state === 'thinking') {
            const latestUserAt = branchMessages.reduce(
                (latest, item) => item.kind === 'user-text' ? Math.max(latest, item.createdAt) : latest,
                0,
            );
            const runningTool = [...branchMessages]
                .sort((left, right) => right.createdAt - left.createdAt)
                .find((item) => (
                    item.kind === 'tool-call' &&
                    item.tool.state === 'running' &&
                    item.createdAt >= latestUserAt
                ));
            const toolName = runningTool?.kind === 'tool-call'
                ? (runningTool.tool.description || runningTool.tool.name)
                : null;
            return {
                // The app-server's latest activity wins. A streamed commentary
                // snapshot can remain present while Codex subsequently runs a
                // command, edits a file, or tests; treating the snapshot as the
                // highest-priority signal would incorrectly pin this to output.
                text: session.activity
                    ? formatCodexActivity(session.activity, toolName)
                    : isActiveBranchStreaming
                        ? formatCodexActivity({ phase: 'outputting' })
                        : formatCodexActivity(null, toolName),
                color: '#0A84FF',
                dotColor: '#0A84FF',
                isPulsing: true,
            };
        }
        return {
            text: 'Codex · 就绪',
            color: '#34C759',
            dotColor: '#34C759',
            isPulsing: false,
        };
    }, [branchMessages, isActiveBranchStreaming, session.activity, session.agentState?.codexRuntime, session.metadata?.lifecycleState, sessionStatus.state, sessionStatus.statusText, sessionStatus.statusColor, sessionStatus.statusDotColor, sessionStatus.isPulsing, socketStatus.status, workbenchReady]);

    React.useEffect(() => {
        if (workspaceMode === 'normal') {
            setCoderPanel(null);
        }
    }, [workspaceMode]);

    React.useEffect(() => {
        if (Platform.OS !== 'web' || !latestMcpApp) return;
        if (lastAutoOpenedMcpApp.current !== latestMcpApp.key) {
            lastAutoOpenedMcpApp.current = latestMcpApp.key;
            openMcpAppWorkspace(sessionId, latestMcpApp.tool);
            return;
        }
        if (activeMcpApp?.key === latestMcpApp.key && activeMcpApp.tool !== latestMcpApp.tool) {
            openMcpAppWorkspace(sessionId, latestMcpApp.tool);
        }
    }, [activeMcpApp?.key, activeMcpApp?.tool, latestMcpApp, sessionId]);

    React.useEffect(() => {
        if (workspaceMode !== 'coder' || Platform.OS !== 'web' || coderPreloadedRef.current) {
            return;
        }
        let cancelled = false;
        const schedule = typeof window !== 'undefined' && 'requestIdleCallback' in window
            ? (window as any).requestIdleCallback
            : (callback: () => void) => globalThis.setTimeout(callback, 180);
        const cancel = typeof window !== 'undefined' && 'cancelIdleCallback' in window
            ? (window as any).cancelIdleCallback
            : (handle: number) => globalThis.clearTimeout(handle);
        const handle = schedule(() => {
            if (!cancelled) {
                coderPreloadedRef.current = true;
                void Promise.all([
                    import('@/components/CoderTerminalPanel'),
                    preloadCommonCoderViews(),
                ]);
            }
        });
        return () => {
            cancelled = true;
            cancel(handle);
        };
    }, [workspaceMode]);

    // Use draft hook for auto-saving message drafts
    const { clearDraft } = useDraft(sessionId, message, setMessage);

    // Handle dismissing CLI version warning
    const handleDismissCliWarning = React.useCallback(() => {
        if (machineId && cliVersion) {
            storage.getState().applyLocalSettings({
                acknowledgedCliVersions: {
                    ...acknowledgedCliVersions,
                    [machineId]: cliVersion
                }
            });
        }
    }, [machineId, cliVersion, acknowledgedCliVersions]);

    // Function to update permission mode
    const updatePermissionMode = React.useCallback((mode: PermissionMode) => {
        storage.getState().updateSessionPermissionMode(sessionId, mode.key);
    }, [sessionId]);

    const updateModelMode = React.useCallback((mode: ModelMode) => {
        storage.getState().updateSessionModelMode(sessionId, mode.key);
    }, [sessionId]);

    const updateEffortLevel = React.useCallback((level: EffortLevel) => {
        storage.getState().updateSessionEffortLevel(sessionId, level.key);
    }, [sessionId]);

    // Memoize header-dependent styles to prevent re-renders
    const headerDependentStyles = React.useMemo(() => ({
        contentContainer: {
            flex: 1
        },
        flatListStyle: {
            marginTop: 0 // No marginTop needed since header is handled by parent
        },
    }), []);


    // Load only the conversation on entry. Repository status is a coder-only
    // concern and can be expensive for large/untracked worktrees.
    React.useLayoutEffect(() => {
        if (!isFocused) return;
        return sync.retainVisibleSessions(conversationSessionIds, sessionId);
    }, [conversationSessionIds, isFocused, sessionId]);

    React.useEffect(() => {
        if (
            workspaceMode !== 'coder' ||
            Platform.OS !== 'web' ||
            coderGitStatusRequestedRef.current
        ) {
            return;
        }

        coderGitStatusRequestedRef.current = true;

        let cancelled = false;
        const schedule = typeof window !== 'undefined' && 'requestIdleCallback' in window
            ? (callback: () => void) => (window as any).requestIdleCallback(callback, { timeout: 1500 })
            : (callback: () => void) => globalThis.setTimeout(callback, 250);
        const cancel = typeof window !== 'undefined' && 'cancelIdleCallback' in window
            ? (handle: number) => (window as any).cancelIdleCallback(handle)
            : (handle: number) => globalThis.clearTimeout(handle);
        const handle = schedule(() => {
            if (!cancelled) {
                gitStatusSync.getSync(sessionId).invalidate();
            }
        });

        return () => {
            cancelled = true;
            cancel(handle);
        };
    }, [sessionId, workspaceMode]);

    let content = (
        <>
            <Deferred>
                {messages.length > 0 && (
                    <ChatList session={session} workspaceMode={workspaceMode} latestRequest={latestRequest} />
                )}
            </Deferred>
        </>
    );
    const placeholder = messages.length === 0 ? (
        <>
            {isLoaded ? (
                <EmptyMessages session={session} />
            ) : (
                <ActivityIndicator size="small" color={theme.colors.textSecondary} />
            )}
        </>
    ) : null;

    const composer = (
        <>
        <PendingRequestsPanel session={session} />
        {attachments.input}
        <AgentInput
            placeholder={t('session.inputPlaceholder')}
            value={message}
            onChangeText={setMessage}
            inputHistory={inputHistory}
            historyKey={`${sessionId}:${session.metadata?.activeCodexBranchId ?? 'main'}`}
            sessionId={sessionId}
            permissionMode={permissionMode}
            onPermissionModeChange={updatePermissionMode}
            availableModes={availableModes}
            modelMode={modelMode}
            availableModels={availableModels}
            onModelModeChange={updateModelMode}
            effortLevel={effortLevel}
            availableEffortLevels={availableEffortLevels}
            onEffortLevelChange={updateEffortLevel}
            metadata={session.metadata}
            codexPreferences={session.codexPreferences ?? defaultCodexPreferences}
            onCodexPreferencesChange={preferences => storage.getState().updateSessionCodexPreferences(sessionId, preferences)}
            attachmentCount={attachments.count}
            onPickFiles={attachments.pick}
            attachmentPreview={attachments.preview}
            connectionStatus={connectionStatus}
            onSend={() => {
                if (isSendingMessage) {
                    return;
                }
                if (message.trim() || pastedImages.length > 0 || attachments.count > 0) {
                    const draftMessage = message;
                    const images = pastedImages.length > 0 ? [...pastedImages] : undefined;
                    setIsSendingMessage(true);
                    void (async () => {
                        try {
                            const targetSessionId = await prepareCurrentSessionForSend();
                            const files = await attachments.uploadAll(targetSessionId);
                            if (!draftMessage.trim() && !images?.length && files.length === 0) return;
                            const payload = attachmentMessage(draftMessage, files);
                            await sync.sendMessage(targetSessionId, payload.text, { source: 'chat', images, displayText: payload.displayText });
                            setLatestRequest(value => value + 1);
                            setMessage('');
                            setPastedImages([]);
                            attachments.clear();
                            clearDraft();
                            if (focusedRef.current && targetSessionId !== sessionId) {
                                navigateToSession(targetSessionId);
                            }
                        } catch (error) {
                            console.error('Failed to queue session message:', error);
                            const errorMessage = error instanceof Error ? error.message : String(error);
                            Modal.alert(t('common.error'), errorMessage || 'Failed to send message');
                        } finally {
                            setIsSendingMessage(false);
                        }
                    })();
                }
            }}
            isSending={isSendingMessage}
            images={pastedImages}
            onPasteImages={(imgs) => setPastedImages(prev => [...prev, ...imgs])}
            onRemoveImage={(index) => setPastedImages(prev => prev.filter((_, i) => i !== index))}
            onAbort={socketStatus.status === 'connected' && !isDisconnected ? () => sessionAbort(sessionId) : undefined}
            showAbortButton={
                socketStatus.status === 'connected' &&
                !isDisconnected &&
                (sessionStatus.state === 'thinking' || sessionStatus.state === 'permission_required')
            }
            onFileViewerPress={() => router.push(`/session/${sessionId}/files`)}
            autocompletePrefixes={['@', '/']}
            autocompleteSuggestions={(query) => getSuggestions(sessionId, query)}
            usageData={sessionUsage ? {
                inputTokens: sessionUsage.inputTokens,
                outputTokens: sessionUsage.outputTokens,
                cacheCreation: sessionUsage.cacheCreation,
                cacheRead: sessionUsage.cacheRead,
                contextSize: sessionUsage.contextSize
            } : session.latestUsage ? {
                inputTokens: session.latestUsage.inputTokens,
                outputTokens: session.latestUsage.outputTokens,
                cacheCreation: session.latestUsage.cacheCreation,
                cacheRead: session.latestUsage.cacheRead,
                contextSize: session.latestUsage.contextSize
            } : undefined}
            alwaysShowContextSize={alwaysShowContextSize}
        />
        </>
    );

    const terminalPanel = workspaceMode === 'coder' && coderPanel === 'terminal' ? (
        <React.Suspense fallback={
            <View style={{ height: 250, alignItems: 'center', justifyContent: 'center' }}>
                <ActivityIndicator size="small" color={theme.colors.textSecondary} />
            </View>
        }>
            <LazyCoderTerminalPanel
                sessionId={sessionId}
                cwd={session.metadata?.path}
                onClose={() => setCoderPanel(null)}
            />
        </React.Suspense>
    ) : null;

    const input = (
        <>
            {terminalPanel}
            {devModeEnabled && session.metadata?.flavor === 'codex' && (
                <CodexProtocolDiagnostics
                    session={session}
                    machine={continuationMachine}
                    socketStatus={socketStatus.status}
                />
            )}
            {composer}
        </>
    );


    return (
        <>
            {/* CLI Version Warning Overlay - Subtle centered pill */}
            {shouldShowCliWarning && !(isLandscape && deviceType === 'phone') && (
                <Pressable
                    onPress={handleDismissCliWarning}
                    style={{
                        position: 'absolute',
                        top: 8, // Position at top of content area (padding handled by parent)
                        alignSelf: 'center',
                        backgroundColor: '#FFF3CD',
                        borderRadius: 100, // Fully rounded pill
                        paddingHorizontal: 14,
                        paddingVertical: 7,
                        flexDirection: 'row',
                        alignItems: 'center',
                        zIndex: 998, // Below voice bar but above content
                        shadowColor: '#000',
                        shadowOffset: { width: 0, height: 2 },
                        shadowOpacity: 0.15,
                        shadowRadius: 4,
                        elevation: 4,
                    }}
                >
                    <Ionicons name="warning-outline" size={14} color="#FF9500" style={{ marginRight: 6 }} />
                    <Text style={{
                        fontSize: theme.typography.caption.fontSize,
                        color: '#856404',
                        fontWeight: '600'
                    }}>
                        {t('sessionInfo.cliVersionOutdated')}
                    </Text>
                    <Ionicons name="close" size={14} color="#856404" style={{ marginLeft: 8 }} />
                </Pressable>
            )}

            {/* Main content area - no padding since header is overlay */}
            <View style={{ flexBasis: 0, flexGrow: 1, paddingBottom: safeArea.bottom + ((isRunningOnMac() || Platform.OS === 'web') ? 8 : 0) }}>
                <CoderWorkspaceBar
                    sessionId={sessionId}
                    mode={workspaceMode}
                    panel={coderPanel}
                    onModeChange={setWorkspaceMode}
                    onPanelChange={setCoderPanel}
                />
                <View style={{ flex: 1, minHeight: 0, flexDirection: 'row' }}>
                    <View style={{ flex: 1, minWidth: 0 }}>
                        <AgentContentView
                            content={content}
                            input={input}
                            placeholder={placeholder}
                        />
                    </View>
                    {Platform.OS === 'web' && activeMcpApp && (
                        <View
                            accessibilityViewIsModal={viewportWidth < 980}
                            style={viewportWidth >= 980 ? {
                                width: Math.min(760, Math.max(460, viewportWidth * 0.5)),
                                minWidth: 0,
                                borderLeftWidth: 1,
                                borderLeftColor: theme.colors.divider,
                            } : {
                                position: 'absolute',
                                inset: 0,
                                zIndex: 900,
                                backgroundColor: theme.colors.surface,
                            } as any}
                        >
                            <React.Suspense fallback={
                                <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
                                    <ActivityIndicator size="small" color={theme.colors.textSecondary} />
                                </View>
                            }>
                                <LazyMcpAppSurface
                                    workspace
                                    onClose={() => closeMcpAppWorkspace(sessionId)}
                                    tool={activeMcpApp.tool}
                                    metadata={session.metadata}
                                    messages={[]}
                                    sessionId={sessionId}
                                />
                            </React.Suspense>
                        </View>
                    )}
                </View>
            </View >

            {/* Back button for landscape phone mode when header is hidden */}
            {
                isLandscape && deviceType === 'phone' && (
                    <Pressable
                        onPress={() => router.back()}
                        style={{
                            position: 'absolute',
                            top: safeArea.top + 8,
                            left: 16,
                            width: 44,
                            height: 44,
                            borderRadius: 22,
                            backgroundColor: `rgba(${theme.dark ? '28, 23, 28' : '255, 255, 255'}, 0.9)`,
                            alignItems: 'center',
                            justifyContent: 'center',
                            ...Platform.select({
                                ios: {
                                    shadowColor: '#000',
                                    shadowOffset: { width: 0, height: 2 },
                                    shadowOpacity: 0.1,
                                    shadowRadius: 4,
                                },
                                android: {
                                    elevation: 2,
                                }
                            }),
                        }}
                        hitSlop={15}
                    >
                        <Ionicons
                            name={Platform.OS === 'ios' ? 'chevron-back' : 'arrow-back'}
                            size={Platform.select({ ios: 28, default: 24 })}
                            color="#000"
                        />
                    </Pressable>
                )
            }
        </>
    )
}
