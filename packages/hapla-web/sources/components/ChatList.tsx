import * as React from 'react';
import { storage, useConversationMessages, useSession } from "@/sync/storage";
import { FlatList, NativeScrollEvent, NativeSyntheticEvent, Platform, Pressable, View, type ViewToken } from 'react-native';
import { SessionScrollAnchorTracker } from '@/sync/sessionScrollAnchor';
import { isNearOlderHistoryEdge, SessionHistoryGate } from '@/sync/sessionHistoryGate';
import { useCallback } from 'react';
import { useHeaderHeight } from '@/utils/responsive';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { MessageView } from './MessageView';
import { Metadata, Session } from '@/sync/storageTypes';
import { ChatFooter } from './ChatFooter';
import { Message } from '@/sync/typesMessage';
import Ionicons from '@expo/vector-icons/Ionicons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import type { WorkspaceMode } from '@/hooks/useWorkspaceMode';
import { Text } from '@/components/StyledText';
import { filterMessagesForActiveBranch, getUserMessageOrdinal } from '@/utils/sessionBranches';
import { machineStopSession, sessionAbort, sessionGetCodexThreadStatus, sessionSwitchCodexBranch } from '@/sync/ops';
import { Modal } from '@/modal';
import { sync } from '@/sync/sync';
import { CodexBranchBar } from './CodexBranchBar';
import { useSessionContinuation } from '@/hooks/useSessionContinuation';
import { useNavigateToSession } from '@/hooks/useNavigateToSession';
import { WebChatList } from './WebChatList';

const SCROLL_THRESHOLD = 300;
const LIVE_BRANCH_RPC_TIMEOUT_MS = 5_000;

function withTimeout<T>(operation: Promise<T>, timeoutMs: number, message: string): Promise<T> {
    return Promise.race([
        operation,
        new Promise<T>((_, reject) => {
            const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
            operation.finally(() => clearTimeout(timer)).catch(() => undefined);
        }),
    ]);
}

export const ChatList = React.memo((props: { session: Session; workspaceMode: WorkspaceMode; latestRequest?: number }) => {
    const { messages, sessionIds, hasOlder, hasNewer, isLoadingOlder, isLoadingLatest } = useConversationMessages(props.session.id);
    const prepareSessionForBranchSwitch = useSessionContinuation(props.session);
    const navigateToSession = useNavigateToSession();
    const switchBranch = React.useCallback(async (branchId: string) => {
        if (props.session.thinking) {
            const shouldStop = await Modal.confirm(
                '切换对话分支？',
                'Codex 正在运行。切换会先停止当前任务，已完成的内容仍会保留。',
                { cancelText: '继续当前任务', confirmText: '停止并切换', destructive: true },
            );
            if (!shouldStop) return;
            await sessionAbort(props.session.id);
            const deadline = Date.now() + 5_000;
            while (storage.getState().sessions[props.session.id]?.thinking && Date.now() < deadline) {
                await new Promise((resolve) => setTimeout(resolve, 100));
            }
        }
        // A live branch runtime already owns the branch RPC. Calling the machine
        // continuation path first can wait forever when a freshly continued
        // session has not yet propagated back into the daemon's tracking cache.
        // Prefer the session RPC and only ask the daemon to recover the runtime
        // when that direct path is unavailable.
        try {
            return await withTimeout(
                sessionSwitchCodexBranch(props.session.id, branchId),
                LIVE_BRANCH_RPC_TIMEOUT_MS,
                'The active branch runtime did not respond in time.',
            );
        } catch {
            // Continue below: the runtime may be asleep, stale, or from an older
            // CLI without the branch RPC.
        }

        const targetSessionId = await prepareSessionForBranchSwitch();
        try {
            const switched = await sessionSwitchCodexBranch(targetSessionId, branchId);
            if (targetSessionId !== props.session.id) navigateToSession(targetSessionId);
            return switched;
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (!message.includes('RPC method not available')) throw error;

            const branch = props.session.metadata?.codexBranches?.find((candidate) => candidate.id === branchId);
            const machineId = props.session.metadata?.machineId;
            if (!branch || !machineId) throw error;

            // A session restored from an older CLI can look online while lacking
            // the branch RPC. Retire only that stale runtime, then transparently
            // continue the selected Codex thread with the full branch state.
            await machineStopSession(machineId, targetSessionId).catch((stopError) => {
                const stopMessage = stopError instanceof Error ? stopError.message : String(stopError);
                if (!stopMessage.includes('not found')) throw stopError;
            });
            const resumedSessionId = await prepareSessionForBranchSwitch({
                metadata: {
                    codexThreadId: branch.threadId,
                    activeCodexBranchId: branch.id,
                    codexBranches: props.session.metadata?.codexBranches,
                },
            });
            let verifiedStatus: { branchId: string; threadId: string } | null = null;
            let verificationError: unknown;
            for (let attempt = 0; attempt < 40; attempt += 1) {
                try {
                    const status = await sessionGetCodexThreadStatus(resumedSessionId);
                    if (status.branchId !== branch.id || status.threadId !== branch.threadId) {
                        throw new Error(`Codex resumed the wrong branch (${status.threadId}).`);
                    }
                    verifiedStatus = status;
                    break;
                } catch (statusError) {
                    verificationError = statusError;
                    await new Promise((resolve) => setTimeout(resolve, 250));
                }
            }
            if (!verifiedStatus) {
                const reason = verificationError instanceof Error ? verificationError.message : String(verificationError);
                throw new Error(`分支运行时未能完成验证：${reason}`);
            }
            if (resumedSessionId !== props.session.id) navigateToSession(resumedSessionId);
            return verifiedStatus;
        }
    }, [navigateToSession, prepareSessionForBranchSwitch, props.session.id, props.session.metadata, props.session.thinking]);
    const List = Platform.OS === 'web' ? WebChatList : ChatListNative;
    return (
        <List
            key={`${props.session.id}:${props.session.metadata?.activeCodexBranchId ?? 'main'}`}
            metadata={props.session.metadata}
            sessionId={props.session.id}
            conversationSessionIds={sessionIds}
            messages={messages}
            hasOlder={hasOlder}
            hasNewer={hasNewer}
            isLoadingOlder={isLoadingOlder}
            isLoadingLatest={isLoadingLatest}
            workspaceMode={props.workspaceMode}
            onSwitchBranch={switchBranch}
            latestRequest={props.latestRequest}
        />
    )
});

const ListHeader = React.memo(() => {
    const headerHeight = useHeaderHeight();
    const safeArea = useSafeAreaInsets();
    return <View style={{ flexDirection: 'row', alignItems: 'center', height: headerHeight + safeArea.top + 32 }} />;
});

const ListFooter = React.memo((props: { sessionId: string }) => {
    const session = useSession(props.sessionId)!;
    return (
        <ChatFooter controlledByUser={session.agentState?.controlledByUser || false} />
    )
});

// Web uses its own forward DOM viewport. Keep native list positioning isolated
// from browser gesture handling and DOM anchoring.
const ChatListNative = React.memo((props: {
    metadata: Metadata | null,
    sessionId: string,
    conversationSessionIds: string[],
    messages: Message[],
    hasOlder: boolean,
    hasNewer: boolean,
    isLoadingOlder: boolean,
    isLoadingLatest: boolean,
    workspaceMode: WorkspaceMode,
    onSwitchBranch: (branchId: string) => Promise<unknown>,
}) => {
    const { theme } = useUnistyles();
    const flatListRef = React.useRef<FlatList>(null);
    const scrollOffset = React.useRef(0);
    const restoreKey = `${props.sessionId}:${props.metadata?.activeCodexBranchId ?? 'main'}`;
    const historyGate = React.useMemo(() => new SessionHistoryGate(), [restoreKey]);
    const historyIntentUntil = React.useRef(0);
    const nearOlderHistoryEdge = React.useRef(false);
    const activeRestoreKey = React.useRef(restoreKey);
    const historyGestureEndTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
    const beginHistoryGesture = React.useCallback(() => {
        if (historyGestureEndTimer.current !== null) clearTimeout(historyGestureEndTimer.current);
        historyGestureEndTimer.current = null;
        historyGate.beginGesture();
    }, [historyGate]);
    const endHistoryGestureAfter = React.useCallback((delayMs: number) => {
        if (historyGestureEndTimer.current !== null) clearTimeout(historyGestureEndTimer.current);
        historyGestureEndTimer.current = setTimeout(() => {
            historyGestureEndTimer.current = null;
            historyGate.endGesture();
        }, delayMs);
    }, [historyGate]);
    const [olderLoadError, setOlderLoadError] = React.useState<string | null>(null);
    activeRestoreKey.current = restoreKey;
    React.useEffect(() => {
        setOlderLoadError(null);
        return () => {
            if (historyGestureEndTimer.current !== null) clearTimeout(historyGestureEndTimer.current);
            historyGestureEndTimer.current = null;
        };
    }, [restoreKey]);
    const anchorTracker = React.useMemo(() => new SessionScrollAnchorTracker(
        storage.getState().sessionViewStates[props.sessionId]?.anchor,
        (anchor) => {
            if ((storage.getState().sessions[props.sessionId]?.metadata?.activeCodexBranchId ?? 'main') !== (props.metadata?.activeCodexBranchId ?? 'main')) return;
            storage.getState().saveSessionScrollAnchor(props.sessionId, { ...anchor, branchId: props.metadata?.activeCodexBranchId });
        },
    ), [restoreKey]);
    const restoredKey = React.useRef<string | null>(null);
    const pendingRestore = React.useRef<{ key: string; index: number; attempts: number; awaitingExact: boolean } | null>(null);
    const restoreTimer = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
    const retryRestore = React.useCallback(() => {
        if (restoreTimer.current !== undefined || !pendingRestore.current || pendingRestore.current.attempts >= 8) return;
        restoreTimer.current = setTimeout(() => {
            restoreTimer.current = undefined;
            const pending = pendingRestore.current;
            if (!pending) return;
            pending.attempts++;
            pending.awaitingExact = true;
            flatListRef.current?.scrollToIndex({ index: pending.index, animated: false, viewPosition: 0.5 });
        }, 100);
    }, []);
    const anchorContext = React.useRef({ sessionId: props.sessionId, sessionIds: props.conversationSessionIds, branchId: props.metadata?.activeCodexBranchId, tracker: anchorTracker });
    anchorContext.current = { sessionId: props.sessionId, sessionIds: props.conversationSessionIds, branchId: props.metadata?.activeCodexBranchId, tracker: anchorTracker };
    const onViewableItemsChanged = React.useRef(({ viewableItems }: { viewableItems: ViewToken[] }) => {
        const item = viewableItems.find((candidate) => candidate.isViewable)?.item as Message | undefined;
        if (!item) return;
        const { sessionId, sessionIds, branchId, tracker } = anchorContext.current;
        const sourceSessionId = sessionIds.find((id) => storage.getState().sessionMessages[id]?.messagesMap[item.id]) ?? sessionId;
        const page = storage.getState().sessionMessages[sourceSessionId];
        const rawId = page?.reducerState.messages.get(item.id)?.realID ?? item.id;
        tracker.viewable({ sourceSessionId, messageId: rawId, seq: page?.rawMessagesMap?.[rawId]?.seq, branchId });
    }).current;
    React.useEffect(() => () => {
        anchorTracker.flush();
        pendingRestore.current = null;
        if (restoreTimer.current !== undefined) clearTimeout(restoreTimer.current);
        restoreTimer.current = undefined;
    }, [anchorTracker]);
    const [showScrollButton, setShowScrollButton] = React.useState(false);
    const [newMessageCount, setNewMessageCount] = React.useState(0);
    const newestVisible = React.useRef<{ id: string; at: number } | undefined>(undefined);
    const followFrame = React.useRef<number | undefined>(undefined);
    React.useEffect(() => () => { if (followFrame.current !== undefined) cancelAnimationFrame(followFrame.current); }, []);
    const visibleMessages = React.useMemo(
        () => filterMessagesForActiveBranch(props.messages, props.metadata),
        [props.messages, props.metadata],
    );
    React.useEffect(() => {
        if (visibleMessages.length === 0) { restoredKey.current = null; return; }
        if (restoredKey.current === restoreKey) return;
        const anchor = storage.getState().sessionViewStates[props.sessionId]?.anchor;
        if (!anchor || anchor.offset <= 0 || (anchor.branchId ?? 'main') !== (props.metadata?.activeCodexBranchId ?? 'main')) {
            restoredKey.current = restoreKey;
            anchorTracker.restored();
            return;
        }
        const page = storage.getState().sessionMessages[anchor.sourceSessionId ?? props.sessionId];
        const index = visibleMessages.findIndex((message) => {
            const rawId = page?.reducerState.messages.get(message.id)?.realID ?? message.id;
            return rawId === anchor.messageId || (anchor.seq !== undefined && page?.rawMessagesMap?.[rawId]?.seq === anchor.seq);
        });
        if (index < 0) return;
        pendingRestore.current = { key: restoreKey, index, attempts: 0, awaitingExact: false };
        retryRestore();
    }, [props.sessionId, props.metadata?.activeCodexBranchId, restoreKey, visibleMessages, anchorTracker, retryRestore]);
    React.useEffect(() => {
        const newest = visibleMessages[0];
        const previous = newestVisible.current;
        if (newest && previous && newest.id !== previous.id && newest.createdAt >= previous.at && scrollOffset.current > 10 && !props.hasNewer) {
            setNewMessageCount((count) => Math.min(999, count + 1));
        }
        newestVisible.current = newest ? { id: newest.id, at: newest.createdAt } : undefined;
        if (!newest) setNewMessageCount(0);
    }, [visibleMessages, props.hasNewer]);

    const userOrdinals = React.useMemo(() => new Map(
        visibleMessages
            .filter((message) => message.kind === 'user-text')
            .map((message) => [message.id, getUserMessageOrdinal(visibleMessages, message.id)]),
    ), [visibleMessages]);
    const keyExtractor = useCallback((item: Message) => item.id, []);
    const renderItem = useCallback(({ item }: { item: Message }) => (
        <MessageView
            message={item}
            metadata={props.metadata}
            sessionId={props.sessionId}
            workspaceMode={props.workspaceMode}
            userOrdinal={userOrdinals.get(item.id)}
        />
    ), [props.metadata, props.sessionId, props.workspaceMode, userOrdinals]);

    const scrollToBottom = useCallback(() => {
        setNewMessageCount(0);
        if (props.hasNewer) {
            void sync.returnToLatestConversationMessages(props.conversationSessionIds, props.sessionId);
            return;
        }
        flatListRef.current?.scrollToOffset({ offset: 0, animated: true });
    }, [props.hasNewer, props.conversationSessionIds, props.sessionId]);

    const loadOlder = useCallback(() => {
        if (!props.hasOlder || props.isLoadingOlder || !historyGate.take()) return;
        setOlderLoadError(null);
        const requestKey = restoreKey;
        void sync.loadOlderConversationMessages(props.conversationSessionIds, props.sessionId)
            .catch((error) => {
                if (activeRestoreKey.current === requestKey) {
                    setOlderLoadError(error instanceof Error ? error.message : '无法加载更早记录');
                }
            })
            .finally(() => historyGate.complete());
    }, [props.hasOlder, props.isLoadingOlder, props.conversationSessionIds, props.sessionId, historyGate, restoreKey]);

    // In an inverted FlatList, offset 0 is the latest message and offset grows
    // as the user moves toward older history. Trigger near that older edge from
    // native scroll intent; layout-driven onEndReached alone cannot identify
    // a new user gesture.
    const handleScroll = useCallback((e: NativeSyntheticEvent<NativeScrollEvent>) => {
        const offsetY = Math.max(0, e.nativeEvent.contentOffset.y);
        const now = Date.now();
        const movedTowardHistory = offsetY > scrollOffset.current + 1;
        const nearHistory = isNearOlderHistoryEdge({
            offset: offsetY,
            viewport: e.nativeEvent.layoutMeasurement.height,
            content: e.nativeEvent.contentSize.height,
        });
        nearOlderHistoryEdge.current = nearHistory;
        if (movedTowardHistory && now <= historyIntentUntil.current) {
            historyGate.userScrolledTowardHistory();
            if (nearHistory) loadOlder();
        }
        scrollOffset.current = offsetY;
        if (pendingRestore.current?.awaitingExact && offsetY > 10) {
            restoredKey.current = pendingRestore.current.key;
            pendingRestore.current = null;
            anchorContext.current.tracker.restored();
        }
        if (offsetY <= 10) setNewMessageCount(0);
        anchorContext.current.tracker.scroll(offsetY);
        setShowScrollButton(offsetY > SCROLL_THRESHOLD);
    }, [historyGate, loadOlder]);

    return (
        <View style={{ flex: 1 }}>
            {(props.metadata?.codexBranches?.length ?? 0) > 1 ? (
                <CodexBranchBar
                    sessionId={props.sessionId}
                    branches={props.metadata!.codexBranches!}
                    activeBranchId={props.metadata?.activeCodexBranchId}
                    onSwitch={props.onSwitchBranch}
                    onError={(error) => Modal.alert('无法切换分支', error instanceof Error ? error.message : String(error))}
                />
            ) : null}
            <FlatList
                ref={flatListRef}
                data={visibleMessages}
                inverted={true}
                keyExtractor={keyExtractor}
                maintainVisibleContentPosition={{
                    minIndexForVisible: 0,
                    autoscrollToTopThreshold: 10,
                }}
                keyboardShouldPersistTaps="handled"
                keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'none'}
                renderItem={renderItem}
                initialNumToRender={12}
                maxToRenderPerBatch={8}
                updateCellsBatchingPeriod={40}
                windowSize={7}
                removeClippedSubviews={false}
                onScroll={handleScroll}
                onScrollBeginDrag={(event) => {
                    beginHistoryGesture();
                    historyIntentUntil.current = Number.POSITIVE_INFINITY;
                    historyGate.userScrolledTowardHistory();
                    nearOlderHistoryEdge.current = isNearOlderHistoryEdge({
                        offset: Math.max(0, event.nativeEvent.contentOffset.y),
                        viewport: event.nativeEvent.layoutMeasurement.height,
                        content: event.nativeEvent.contentSize.height,
                    });
                    if (nearOlderHistoryEdge.current) loadOlder();
                }}
                onScrollEndDrag={() => {
                    historyIntentUntil.current = Date.now() + 1_000;
                    endHistoryGestureAfter(1_000);
                }}
                onMomentumScrollBegin={() => {
                    if (historyGestureEndTimer.current !== null) clearTimeout(historyGestureEndTimer.current);
                    historyGestureEndTimer.current = null;
                    historyIntentUntil.current = Number.POSITIVE_INFINITY;
                }}
                onMomentumScrollEnd={() => {
                    historyIntentUntil.current = 0;
                    historyGate.endGesture();
                }}
                onContentSizeChange={() => {
                    if (pendingRestore.current) { retryRestore(); return; }
                    if (followFrame.current !== undefined) cancelAnimationFrame(followFrame.current);
                    if (scrollOffset.current <= 10 && !props.hasNewer && restoredKey.current === restoreKey) {
                        followFrame.current = requestAnimationFrame(() => {
                            if (scrollOffset.current <= 10) flatListRef.current?.scrollToOffset({ offset: 0, animated: false });
                        });
                    }
                }}
                onViewableItemsChanged={onViewableItemsChanged}
                onScrollToIndexFailed={({ index, averageItemLength }) => {
                    if (pendingRestore.current) pendingRestore.current.awaitingExact = false;
                    flatListRef.current?.scrollToOffset({ offset: Math.max(0, averageItemLength * index), animated: false });
                    retryRestore();
                }}
                scrollEventThrottle={16}
                onEndReached={() => {
                    nearOlderHistoryEdge.current = true;
                    loadOlder();
                }}
                onEndReachedThreshold={0.6}
                ListHeaderComponent={<ListFooter sessionId={props.sessionId} />}
                ListFooterComponent={(
                    <View>
                        {props.isLoadingOlder ? (
                            <Text accessibilityLiveRegion="polite" style={styles.historyStatus}>
                                正在加载更早记录…
                            </Text>
                        ) : olderLoadError && props.hasOlder ? (
                            <Pressable
                                accessibilityRole="button"
                                accessibilityLabel="重试加载更早记录"
                                onPressIn={() => {
                                    beginHistoryGesture();
                                    historyGate.userScrolledTowardHistory();
                                }}
                                onPress={() => {
                                    loadOlder();
                                }}
                            >
                                <Text accessibilityLiveRegion="polite" style={styles.historyStatus}>
                                    加载失败，点击重试
                                </Text>
                            </Pressable>
                        ) : null}
                        <ListHeader />
                    </View>
                )}
            />
            {(showScrollButton || newMessageCount > 0 || props.hasNewer) && (
                <View style={styles.scrollButtonContainer}>
                    {newMessageCount > 0 && <Text accessibilityLiveRegion="polite" style={styles.newMessages}>{newMessageCount} 条新消息</Text>}
                    <Pressable
                        style={({ pressed }) => [
                            styles.scrollButton,
                            pressed ? styles.scrollButtonPressed : styles.scrollButtonDefault
                        ]}
                        onPress={scrollToBottom}
                        accessibilityLabel={props.hasNewer ? '返回最新消息' : '滚动到最新消息'}
                    >
                        <Ionicons name={props.isLoadingLatest ? 'hourglass-outline' : 'chevron-down'} size={20} color={theme.colors.fab.icon} />
                    </Pressable>
                </View>
            )}
        </View>
    )
});

const styles = StyleSheet.create((theme) => ({
    scrollButtonContainer: {
        position: 'absolute',
        right: 16,
        bottom: 8,
        alignItems: 'center',
        justifyContent: 'center',
    },
    scrollButton: {
        borderRadius: 22,
        width: 44,
        height: 44,
        alignItems: 'center',
        justifyContent: 'center',
        shadowColor: theme.colors.shadow.color,
        shadowOffset: { width: 0, height: 2 },
        shadowRadius: 3.84,
        shadowOpacity: theme.colors.shadow.opacity,
        elevation: 5,
    },
    scrollButtonDefault: {
        backgroundColor: theme.colors.fab.background,
    },
    scrollButtonPressed: {
        backgroundColor: theme.colors.fab.backgroundPressed,
    },
    newMessages: { color: theme.colors.textSecondary, backgroundColor: theme.colors.surfaceHigh, borderRadius: 10, paddingHorizontal: 8, paddingVertical: 4, marginBottom: 4, fontSize: theme.typography.caption.fontSize },
    historyStatus: { color: theme.colors.textSecondary, fontSize: theme.typography.caption.fontSize, textAlign: 'center', paddingVertical: 10 },
}));
