import * as React from 'react';
import { Pressable, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useUnistyles } from 'react-native-unistyles';
import { Text } from './StyledText';
import { MessageView } from './MessageView';
import { ChatFooter } from './ChatFooter';
import { CodexBranchBar } from './CodexBranchBar';
import { ForwardScrollViewport, type ForwardScrollLayout, type ForwardScrollPosition } from './ForwardScrollViewport';
import { isVisibleChatMessage, shouldHoldReadingWindow, snapshotChatMessage, WebChatRowIdentity, type WebChatRow } from './webChatRows';
import { mergeNormalChatWindow } from './normalChatWindow';
import { mergeNormalHistorySlice, type NormalHistorySlice } from './normalHistorySlice';
import { messageSignature, storage, useSession } from '@/sync/storage';
import { sync } from '@/sync/sync';
import { SessionHistoryGate } from '@/sync/sessionHistoryGate';
import type { SessionScrollAnchor } from '@/sync/sessionResources';
import type { Metadata } from '@/sync/storageTypes';
import type { Message } from '@/sync/typesMessage';
import type { WorkspaceMode } from '@/hooks/useWorkspaceMode';
import { filterMessagesForActiveBranch, getUserMessageOrdinal } from '@/utils/sessionBranches';
import { Modal } from '@/modal';
import { ArtifactCollectionView } from './ArtifactCollectionView';
import { ArtifactTimelineIdentity, artifactAnchorKey, artifactAnchorRow, type ArtifactItem, type ArtifactTimelineEntry } from './artifactTimeline';

const HISTORY_BATCH_VISIBLE_ROWS = 20;
const HISTORY_BATCH_VIEWPORTS = 2;

type Props = {
    metadata: Metadata | null;
    sessionId: string;
    conversationSessionIds: string[];
    messages: Message[];
    hasOlder: boolean;
    hasNewer: boolean;
    isLoadingOlder: boolean;
    isLoadingLatest: boolean;
    workspaceMode: WorkspaceMode;
    latestRequest?: number;
    onSwitchBranch: (branchId: string) => Promise<unknown>;
};

/** Web owns a forward, bounded DOM list. RN's inverted virtual list is native-only. */
export const WebChatList = React.memo((props: Props) => {
    const { theme } = useUnistyles();
    const session = useSession(props.sessionId);
    const viewport = React.useRef<ForwardScrollViewport>(null);
    const gate = React.useMemo(() => new SessionHistoryGate(), []);
    const identities = React.useMemo(() => new WebChatRowIdentity(), []);
    const artifactIdentities = React.useMemo(() => new ArtifactTimelineIdentity(), []);
    const displayedTimeline = React.useRef<ArtifactTimelineEntry[]>([]);
    const [interacting, setInteracting] = React.useState(false);
    const [olderError, setOlderError] = React.useState(false);
    const [latestError, setLatestError] = React.useState(false);
    const [awayFromBottom, setAwayFromBottom] = React.useState(false);
    const [newMessageCount, setNewMessageCount] = React.useState(0);
    const [forceLatest, setForceLatest] = React.useState(false);
    const [, reconsiderReadingWindow] = React.useState<string | undefined>();
    const [, acceptDisjointWindow] = React.useState(0);
    const normalRows = React.useRef<WebChatRow[]>([]);
    const normalHistory = React.useRef<NormalHistorySlice | null>(null);
    const [historyRows, setHistoryRows] = React.useState<Omit<WebChatRow, 'key'>[]>([]);
    const [historyCursor, setHistoryCursor] = React.useState<{ sessionId: string; before: number } | null | undefined>();
    const [historyLoading, setHistoryLoading] = React.useState(false);
    const [normalHasNewer, setNormalHasNewer] = React.useState(false);
    const windowDirection = React.useRef<'oldest' | 'newest'>('newest');
    const [needsFill, setNeedsFill] = React.useState(false);
    const measuredNeedsFill = React.useRef(false);
    const [fillPaused, setFillPaused] = React.useState(false);
    const [requestCompleted, setRequestCompleted] = React.useState(0);
    const mounted = React.useRef(true);
    const latestRequested = React.useRef(false);
    const replaceNormalOnLatest = React.useRef(false);
    const olderRequest = React.useRef(0);
    const historyGoal = React.useRef<{ keys: Set<string>; renderedKeys: Set<string>; before: number; targetHeight: number } | null>(null);
    const viewportHeight = React.useRef(600);
    const position = React.useRef<ForwardScrollPosition | null>(null);
    const presentedMode = React.useRef(props.workspaceMode);
    const modePositions = React.useRef<Partial<Record<WorkspaceMode, ForwardScrollPosition>>>({});
    const savedPosition = React.useRef<SessionScrollAnchor | undefined>(undefined);
    const lastSavedAt = React.useRef(0);
    const branchId = props.metadata?.activeCodexBranchId;
    const hasOlder = props.workspaceMode === 'normal' && historyCursor !== undefined ? historyCursor !== null : props.hasOlder;
    const hasNewer = props.hasNewer || (props.workspaceMode === 'normal' && normalHasNewer);
    const isLoadingOlder = props.isLoadingOlder || historyLoading;
    const [savedAnchor] = React.useState(() => {
        const anchor = storage.getState().sessionViewStates[props.sessionId]?.anchor;
        return (anchor?.branchId ?? 'main') === (branchId ?? 'main') ? anchor : undefined;
    });
    const branchMessages = React.useMemo(
        () => filterMessagesForActiveBranch(props.messages, props.metadata),
        [props.messages, props.metadata],
    );
    const incomingRows = React.useMemo(() => {
        const pages = props.conversationSessionIds.map((id) => ({ id, page: storage.getState().sessionMessages[id] }));
        const live = [...branchMessages].reverse().map((message) => {
            const source = pages.find(({ page }) => !!page?.messagesMap[message.id]);
            const rawId = source?.page?.reducerState.messages.get(message.id)?.realID ?? message.id;
            return {
                message: snapshotChatMessage(message),
                rawId,
                sourceSessionId: source?.id ?? props.sessionId,
                seq: source?.page?.rawMessagesMap?.[rawId]?.seq,
            };
        });
        const allowed = new Set(filterMessagesForActiveBranch(historyRows.map((row) => row.message), props.metadata));
        const historical = props.workspaceMode === 'normal' ? historyRows.filter((row) => allowed.has(row.message)
            && !pages.find(({ id }) => id === row.sourceSessionId)?.page?.rawMessagesMap?.[row.rawId]) : [];
        return identities.reconcile([...historical, ...live], messageSignature, normalRows.current);
    }, [branchMessages, identities, props.conversationSessionIds, props.sessionId, historyRows, props.metadata, props.workspaceMode]);
    const snapshot = React.useMemo(() => {
        let rows: WebChatRow[];
        let trimmed = false;
        if (props.workspaceMode === 'normal') {
            const allowed = new Set(filterMessagesForActiveBranch(normalRows.current.map((row) => row.message), props.metadata));
            const replace = replaceNormalOnLatest.current && forceLatest && !props.hasNewer && !props.isLoadingLatest;
            const retained = replace ? [] : normalRows.current.filter((row) => allowed.has(row.message)
                && props.conversationSessionIds.includes(row.sourceSessionId));
            const window = mergeNormalChatWindow(retained, incomingRows, { keep: windowDirection.current });
            rows = window.rows;
            trimmed = window.trimmed;
        } else {
            rows = incomingRows.filter((row) => isVisibleChatMessage(row.message, props.workspaceMode));
        }
        const messages = rows.map((row) => row.message);
        return { rows, trimmed, metadata: props.metadata, mode: props.workspaceMode,
            ordinals: new Map(messages.filter((message) => message.kind === 'user-text')
                .map((message) => [message.id, getUserMessageOrdinal(messages, message.id)])) };
    }, [incomingRows, props.metadata, props.workspaceMode, props.conversationSessionIds, forceLatest, props.hasNewer, props.isLoadingLatest, awayFromBottom]);
    React.useLayoutEffect(() => {
        if (snapshot.mode === 'normal') {
            normalRows.current = snapshot.rows;
            if (snapshot.trimmed) {
                if (windowDirection.current === 'oldest') setNormalHasNewer(true);
                else {
                    const first = snapshot.rows[0];
                    if (first?.seq !== undefined) setHistoryCursor({ sessionId: first.sourceSessionId, before: first.seq });
                }
            }
        }
    }, [snapshot]);
    // Network responses may arrive while Safari is still moving its compositor.
    // Keep the current row tree until the gesture/inertia has settled, then make
    // one layout commit. Only the current and latest bounded windows are held.
    const committed = React.useRef(snapshot);
    // A resolved permission or a mode switch may intentionally hide a row.
    // Retain a window only for actual data eviction, never for visibility changes.
    const readingWindow = snapshot.mode === 'normal'
        ? [...snapshot.rows, ...incomingRows.filter((row) => !isVisibleChatMessage(row.message, 'normal'))]
        : incomingRows;
    const heldWindow = (position.current?.distanceFromBottom ?? 0) > 48
        && committed.current.mode === snapshot.mode
        && shouldHoldReadingWindow(artifactAnchorRow(displayedTimeline.current, position.current?.anchorId)?.key ?? position.current?.anchorId,
            committed.current.rows, readingWindow);
    const disjointWindow = heldWindow && !committed.current.rows.some((row) => snapshot.rows.some((next) => next.key === row.key));
    const canShowLatest = forceLatest && !props.hasNewer && !props.isLoadingLatest;
    const displayed = (interacting || heldWindow || forceLatest) && !canShowLatest ? committed.current : snapshot;
    const timeline = React.useMemo(() => artifactIdentities.reconcile(displayed.rows), [artifactIdentities, displayed.rows]);
    React.useLayoutEffect(() => { if (displayed === snapshot) committed.current = snapshot; }, [displayed, snapshot]);
    React.useLayoutEffect(() => { displayedTimeline.current = timeline; }, [timeline]);

    const savePosition = React.useCallback(() => {
        if (savedPosition.current) storage.getState().saveSessionScrollAnchor(props.sessionId, savedPosition.current);
    }, [props.sessionId]);
    React.useEffect(() => {
        mounted.current = true;
        return () => { mounted.current = false; savePosition(); };
    }, [savePosition]);
    const onPosition = React.useCallback((next: ForwardScrollPosition) => {
        // A mode change's first DOM layout is provisional. Preserve the saved
        // position for that mode until the layout effect restores its anchor.
        if (displayed.mode !== presentedMode.current) return;
        modePositions.current[displayed.mode] = next;
        position.current = next;
        reconsiderReadingWindow(next.anchorId);
        const away = next.distanceFromBottom > 48;
        setAwayFromBottom(away);
        if (!away) { setNewMessageCount(0); windowDirection.current = 'newest'; }
        const row = artifactAnchorRow(timeline, next.anchorId);
        if (!away) savedPosition.current = { offset: 0, branchId };
        else if (row?.seq !== undefined) savedPosition.current = {
            offset: next.distanceFromBottom,
            sourceSessionId: row.sourceSessionId,
            messageId: row.rawId,
            seq: row.seq,
            viewportTop: next.anchorViewportTop,
            branchId,
        };
        if (Date.now() - lastSavedAt.current >= 250) {
            lastSavedAt.current = Date.now();
            savePosition();
        }
    }, [branchId, timeline, displayed.mode, savePosition]);
    React.useLayoutEffect(() => {
        if (presentedMode.current === displayed.mode) return;
        presentedMode.current = displayed.mode;
        const saved = modePositions.current[displayed.mode];
        if (saved) viewport.current?.restoreAnchor({ id: artifactAnchorKey(timeline, saved.anchorId) ?? saved.anchorId, viewportTop: saved.anchorViewportTop,
            distanceFromBottom: saved.distanceFromBottom });
    }, [displayed.mode, timeline]);
    const previousNewest = React.useRef<WebChatRow | undefined>(snapshot.rows.at(-1));
    React.useEffect(() => {
        const newest = snapshot.rows.at(-1);
        const previous = previousNewest.current;
        if (newest && previous && newest.key !== previous.key && newest.message.createdAt >= previous.message.createdAt
            && (position.current?.distanceFromBottom ?? 0) > 48 && !props.hasNewer) {
            setNewMessageCount((count) => Math.min(999, count + 1));
        }
        previousNewest.current = newest;
    }, [snapshot.rows, props.hasNewer]);

    const onLayout = React.useCallback((layout: ForwardScrollLayout) => {
        // Load enough visible content to fill the screen and a small scroll
        // reserve. One short answer is not a complete viewport.
        measuredNeedsFill.current = layout.viewportHeight > 0 && layout.rowsHeight < layout.viewportHeight + 240;
        if (layout.viewportHeight > 0) viewportHeight.current = layout.viewportHeight;
        setNeedsFill(measuredNeedsFill.current);
    }, []);
    const loadOlder = React.useCallback((automatic = false, continuingGesture = false) => {
        if (heldWindow || forceLatest || !hasOlder || isLoadingOlder || props.isLoadingLatest
            || !(automatic ? gate.takeAutomatic() : gate.take())) return;
        windowDirection.current = automatic && !continuingGesture ? 'newest' : 'oldest';
        if (!automatic && props.workspaceMode === 'normal') historyGoal.current = {
            keys: new Set(normalRows.current.map((row) => row.key)),
            renderedKeys: new Set(displayedTimeline.current.map(entry => entry.key)),
            before: normalRows.current[0]?.message.createdAt ?? Number.POSITIVE_INFINITY,
            targetHeight: viewportHeight.current * HISTORY_BATCH_VIEWPORTS,
        };
        const request = ++olderRequest.current;
        setOlderError(false);
        const work = props.workspaceMode === 'normal' ? (async () => {
            setHistoryLoading(true);
            const page = await sync.readConversationHistoryPage(props.conversationSessionIds, historyCursor ?? undefined);
            if (!mounted.current || request !== olderRequest.current) return true;
            const slice = mergeNormalHistorySlice(normalHistory.current, page);
            normalHistory.current = slice;
            setHistoryRows(slice.rows);
            setHistoryCursor(page.next);
            return true;
        })() : sync.loadOlderConversationMessages(props.conversationSessionIds, props.sessionId, windowDirection.current);
        void work
            .then((advanced) => { if (mounted.current && request === olderRequest.current && advanced === false) setOlderError(true); })
            .catch(() => { if (mounted.current && request === olderRequest.current) setOlderError(true); })
            .finally(() => {
                gate.complete();
                if (mounted.current) { setHistoryLoading(false); setRequestCompleted((count) => count + 1); }
            });
    }, [gate, heldWindow, forceLatest, hasOlder, isLoadingOlder, props.isLoadingLatest, props.conversationSessionIds, props.sessionId, props.workspaceMode, historyCursor]);
    React.useEffect(() => {
        // Traverse tool-dense pages serially, stopping on actual visible height,
        // history exhaustion, no cursor progress, errors or user interaction.
        const goal = historyGoal.current;
        if (goal) {
            const added = snapshot.rows.filter((row) => !goal.keys.has(row.key) && row.message.createdAt <= goal.before);
            // Count only newly loaded older rows. Total content-height deltas
            // also include streaming replies, media resize and tail eviction.
            const addedKeys = new Set(added.map((row) => artifactAnchorKey(timeline, row.key) ?? row.key)
                .filter(key => !goal.renderedKeys.has(key)));
            const addedHeight = viewport.current?.getRowsHeight(addedKeys) ?? 0;
            if (props.workspaceMode !== 'normal' || !hasOlder || olderError
                || addedKeys.size >= HISTORY_BATCH_VISIBLE_ROWS || addedHeight >= goal.targetHeight) historyGoal.current = null;
        }
        if (fillPaused || interacting || olderError) return;
        if (historyGoal.current) loadOlder(true, true);
        else if (measuredNeedsFill.current) loadOlder(true);
    }, [needsFill, fillPaused, interacting, loadOlder, olderError, requestCompleted, props.workspaceMode, hasOlder, snapshot.rows, timeline]);
    const onHistoryIntent = React.useCallback(() => {
        setFillPaused(false);
        gate.userScrolledTowardHistory();
        // Additional movement can resume a paused batch, but must not reset
        // its starting point or start more pages while a finger is held down.
        if (!historyGoal.current) loadOlder();
    }, [gate, loadOlder]);
    const scrollToLatest = React.useCallback(async () => {
        setLatestError(false);
        setOlderError(false);
        historyGoal.current = null;
        olderRequest.current += 1;
        setForceLatest(true);
        windowDirection.current = 'newest';
        setFillPaused(false);
        latestRequested.current = true;
        if (hasNewer || isLoadingOlder) {
            replaceNormalOnLatest.current = true;
            normalHistory.current = null;
            setHistoryRows([]);
            setHistoryCursor(undefined);
            try { await sync.returnToLatestConversationMessages(props.conversationSessionIds, props.sessionId); }
            catch {
                if (mounted.current) { setLatestError(true); setForceLatest(false); }
                latestRequested.current = false;
                replaceNormalOnLatest.current = false;
            }
        }
    }, [hasNewer, isLoadingOlder, props.conversationSessionIds, props.sessionId]);
    React.useEffect(() => {
        // Reaching the tail resumes live following, including a historical
        // window retained after a reconnect. Initial restored anchors still
        // keep their saved position.
        if (position.current && position.current.distanceFromBottom <= 48 && hasNewer
            && !interacting && !isLoadingOlder && !forceLatest && !latestError) void scrollToLatest();
    }, [awayFromBottom, hasNewer, interacting, isLoadingOlder, forceLatest, latestError, scrollToLatest]);
    const previousLatestRequest = React.useRef(props.latestRequest);
    React.useEffect(() => {
        if (previousLatestRequest.current === props.latestRequest) return;
        previousLatestRequest.current = props.latestRequest;
        // A successfully queued prompt in this composer explicitly returns to
        // the live reply. Remote updates and history loading never do this.
        void scrollToLatest();
    }, [props.latestRequest, scrollToLatest]);
    React.useLayoutEffect(() => {
        if (latestRequested.current && canShowLatest) {
            viewport.current?.scrollToLatest();
            if (replaceNormalOnLatest.current && displayed.mode !== 'normal') normalRows.current = [];
            latestRequested.current = false;
            replaceNormalOnLatest.current = false;
            setNormalHasNewer(false);
            setForceLatest(false);
        }
    }, [canShowLatest, displayed]);
    const restoreRow = savedAnchor && savedAnchor.offset > 10 ? displayed.rows.find((row) =>
        row.sourceSessionId === (savedAnchor.sourceSessionId ?? props.sessionId)
        && (row.rawId === savedAnchor.messageId || (row.seq !== undefined && row.seq === savedAnchor.seq))) : undefined;
    const renderArtifact = React.useCallback((item: ArtifactItem) => <MessageView message={item.message}
        metadata={displayed.metadata} sessionId={item.row.sourceSessionId} workspaceMode={displayed.mode} />,
    [displayed.metadata, displayed.mode]);
    const preserveCollectionPosition = React.useCallback(() => {
        const current = position.current;
        // Expanding an attachment is a reading action. Reuse the viewport's
        // anchor restoration so a taller group does not jump to its last card.
        if (current?.anchorId) viewport.current?.restoreAnchor({ id: current.anchorId, viewportTop: current.anchorViewportTop });
    }, []);

    return <View style={{ flex: 1, minHeight: 0 }}>
        {(props.metadata?.codexBranches?.length ?? 0) > 1 && <CodexBranchBar
            sessionId={props.sessionId}
            branches={props.metadata!.codexBranches!}
            activeBranchId={branchId}
            onSwitch={props.onSwitchBranch}
            onError={(error) => Modal.alert('无法切换分支', error instanceof Error ? error.message : String(error))}
        />}
        <ForwardScrollViewport
            ref={viewport}
            initialAnchor={{ id: artifactAnchorKey(timeline, restoreRow?.key), viewportTop: savedAnchor?.viewportTop, distanceFromBottom: savedAnchor?.offset }}
            onPosition={onPosition}
            onLayout={onLayout}
            onGestureStart={() => gate.beginGesture()}
            onUserScroll={({ scrollTop, previousScrollTop }) => {
                // A prepend changes scrollTop to preserve the reading anchor.
                // Only real movement toward newer content cancels this batch.
                if (scrollTop > previousScrollTop + 0.5 && scrollTop > 240) historyGoal.current = null;
            }}
            onGestureEnd={() => gate.endGesture()}
            onHistoryIntent={onHistoryIntent}
            onInteractionChange={setInteracting}
        >
            <div style={{ height: 32, flexShrink: 0, textAlign: 'center', color: theme.colors.textSecondary, fontSize: theme.typography.caption.fontSize }} aria-live="polite">
                {isLoadingOlder ? <>正在加载更早对话…{(needsFill || historyGoal.current) && !fillPaused && <button type="button"
                    onClick={() => setFillPaused(true)}
                    style={{ color: 'inherit', border: 0, background: 'transparent', cursor: 'pointer', marginLeft: 8 }}
                >暂停加载</button>}</> : olderError ? <button
                    type="button"
                    onClick={() => { setFillPaused(false); gate.beginGesture(); gate.userScrolledTowardHistory(); loadOlder(); }}
                    style={{ color: 'inherit', border: 0, background: 'transparent', cursor: 'pointer' }}
                >加载失败，点击重试</button> : fillPaused && hasOlder ? '已暂停，向上滑动继续加载' : null}
            </div>
            {displayed.rows.length === 0 && <div style={{ padding: 20, color: theme.colors.textSecondary, textAlign: 'center', fontSize: theme.typography.small.fontSize }}>
                {isLoadingOlder ? '正在查找对话记录…' : hasOlder ? '当前记录为工具活动，继续下拉可查看更早对话' : '当前没有可显示的对话消息'}
            </div>}
            {timeline.map((entry) => <div key={entry.key} data-hapla-forward-row={entry.key} style={{ flexShrink: 0, minWidth: 0 }}>
                {entry.kind === 'artifacts' ? <ArtifactCollectionView collection={entry.collection} renderItem={renderArtifact}
                    onBeforeChange={preserveCollectionPosition} /> : <MessageView message={entry.row.message} metadata={displayed.metadata}
                    sessionId={props.sessionId} workspaceMode={displayed.mode}
                    userOrdinal={displayed.ordinals.get(entry.row.message.id)} webHistoryAnchorKey={entry.key} />}
            </div>)}
            <ChatFooter controlledByUser={session?.agentState?.controlledByUser || false} />
        </ForwardScrollViewport>
        {disjointWindow && <button type="button" onClick={() => {
            committed.current = snapshot;
            position.current = null;
            acceptDisjointWindow((count) => count + 1);
        }} style={{ position: 'absolute', top: 4, alignSelf: 'center', padding: '8px 12px', borderRadius: 12,
            border: 0, background: theme.colors.surfaceHigh, color: theme.colors.textSecondary, cursor: 'pointer' }}>
            查看已加载的更早对话
        </button>}
        {(awayFromBottom || hasNewer || latestError || heldWindow) && <View style={{ position: 'absolute', right: 16, bottom: 8, alignItems: 'center' }}>
            {(newMessageCount > 0 || latestError) && <Text style={{ color: theme.colors.textSecondary, backgroundColor: theme.colors.surfaceHigh, borderRadius: 10, padding: 6, marginBottom: 4, fontSize: theme.typography.caption.fontSize }}>
                {latestError ? '加载失败，请重试' : `${newMessageCount} 条新消息`}
            </Text>}
            <Pressable onPress={() => { void scrollToLatest(); }} accessibilityLabel="返回最新消息"
                style={{ width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center', backgroundColor: theme.colors.fab.background }}>
                <Ionicons name={props.isLoadingLatest ? 'hourglass-outline' : 'chevron-down'} size={20} color={theme.colors.fab.icon} />
            </Pressable>
        </View>}
    </View>;
});
