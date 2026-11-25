import { configurationOwner, projectSessionConfiguration, preferencesPatch } from './sessionConfiguration';
import { create } from "zustand";
import { useShallow } from 'zustand/react/shallow'
import equal from 'fast-deep-equal'
import type { CodexPreferences } from './codexPreferences';
import { loadSessionCodexPreferences, saveSessionCodexPreferences } from './persistence';

function useDeepEqual<T>(selector: (state: StorageState) => T): (state: StorageState) => T {
    const prev = React.useRef<T>(undefined);
    return (state: StorageState) => {
        const next = selector(state);
        return equal(prev.current, next) ? prev.current! : (prev.current = next);
    };
}
import { Session, Machine, GitStatus } from "./storageTypes";
import type { GitStatusFiles } from "./gitStatusFiles";
import { createReducer, reducer, ReducerState } from "./reducer/reducer";
import { Message } from "./typesMessage";
import { NormalizedMessage } from "./typesRaw";
import { isMachineOnline } from '@/utils/machineUtils';
import { getSessionName, getSessionSubtitle, getSessionAvatarId, type SessionState } from '@/utils/sessionUtils';
import { applySettings, Settings } from "./settings";
import { LocalSettings, applyLocalSettings } from "./localSettings";
import { Profile } from "./profile";
import { UserProfile, RelationshipUpdatedEvent } from "./friendTypes";
import {
    loadSettings,
    loadLocalSettings,
    saveLocalSettings,
    saveSettings,
    loadProfile,
    saveProfile,
    loadSessionDrafts,
    saveSessionDrafts,
    loadSessionPermissionModes,
    saveSessionPermissionModes,
    loadSessionModelModes,
    saveSessionModelModes,
    loadSessionEffortLevels,
    saveSessionEffortLevels,
} from "./persistence";
import type { PermissionModeKey } from '@/components/PermissionModeSelector';
import { MAX_ACTIVE_MESSAGE_EVENTS, mergeMessageWindow } from './messageWindow';
import { conversationHistoryOrder } from './sessionHistory';
import { acceptSessionStream, commitSessionStreams, createSessionStreamState, projectSessionStreams, type SessionStream, type SessionStreamState } from './sessionStream';
import React from "react";
import { sync } from "./sync";
import { isMutableTool } from "@/components/tools/knownTools";
import { projectManager } from "./projectManager";
import { DecryptedArtifact } from "./artifactTypes";
import { FeedItem } from "./feedTypes";
import { defaultPermissionModeForSession } from './defaultPermissionMode';
import { isSameConversation } from './conversationSessions';
import {
    buildWorkspaceSessionGroups,
    mapWorkspaceSessionGroup,
    type WorkspaceSessionGroup,
} from './sessionListGrouping';
import { codexRuntimePresentation } from '@/utils/codexActivity';
import { estimateRetainedBytes, MAX_SESSION_CACHE_BYTES, sessionResources, type SessionScrollAnchor, type SessionViewState } from './sessionResources';
import { compareSessionQuestions, mergeSessionQuestionState } from './sessionQuestionOrder';

export { isSameConversation } from './conversationSessions';

// Debounce timer for realtimeMode changes
let realtimeModeDebounceTimer: ReturnType<typeof setTimeout> | null = null;
const REALTIME_MODE_DEBOUNCE_MS = 150;

/**
 * Centralized session online state resolver
 * Returns either "online" (string) or a timestamp (number) for last seen
 */
function resolveSessionOnlineState(session: { active: boolean; activeAt: number }): "online" | number {
    // Session is online if the active flag is true
    return session.active ? "online" : session.activeAt;
}

/**
 * Checks if a session should be shown in the active sessions group
 */
function isSessionActive(session: { active: boolean; activeAt: number }): boolean {
    // Use the active flag directly, no timeout checks
    return session.active;
}

function lightweightMetadata(metadata: Session['metadata']): Session['metadata'] {
    if (!metadata) return metadata;
    const { skills, models, operatingModes, thoughtLevels, tools, slashCommands, sandbox, ...lightweight } = metadata;
    return { ...lightweight, ...(metadata.summary ? { summary: { ...metadata.summary, text: metadata.summary.text.slice(0, 1000) } } : {}) };
}

function lightweightAgentState(agentState: Session['agentState']): Session['agentState'] {
    return agentState ? {
        codexRuntime: agentState.codexRuntime,
        controlledByUser: agentState.controlledByUser,
        requests: Object.fromEntries(Object.entries(agentState.requests ?? {}).map(([id, request]) => [id, {
            tool: request.tool, createdAt: request.createdAt, arguments: {}, status: request.status,
            protocol: request.protocol, submittedAt: request.submittedAt,
        }])),
    } : agentState;
}

/**
 * Runtime sessions are transport records. A conversation may span several of
 * them when the local agent process is recreated. Keep that lifecycle detail
 * out of the user-facing list and chat history.
 */
interface SessionMessages {
    messages: Message[];
    messagesMap: Record<string, Message>;
    rawMessagesMap?: Record<string, NormalizedMessage>;
    reducerState: ReducerState;
    isLoaded: boolean;
    hasOlder?: boolean;
    hasNewer?: boolean;
    isLoadingOlder?: boolean;
    isLoadingLatest?: boolean;
    cachedEventCount?: number;
    cachedBytes?: number;
}

export type { SessionStream } from './sessionStream';

// Machine type is now imported from storageTypes - represents persisted machine data

// Display-only row data — all primitives, cheap to deep-equal
export interface SessionRowData {
    id: string;
    name: string;
    subtitle: string;
    avatarId: string;
    flavor: string | null;
    state: SessionState;
    // Only present on inactive sessions — active sessions never show "last seen"
    // and activeAt updates on every heartbeat, causing needless deep-equal diffs
    activeAt?: number;
    createdAt?: number;
    questionOrderId?: string;
    questionFallbackCreatedAt?: number;
    lastUserMessageAt?: number | null;
    questionTimeIndexed?: boolean;
    hasDraft: boolean;
    active: boolean;
    machineId: string | null;
    path: string | null;
    homeDir: string | null;
    completedTodosCount: number;
    totalTodosCount: number;
}

function buildSessionRowData(session: Session): SessionRowData {
    const isOnline = session.presence === "online";
    const hasPermissions = !!(session.agentState?.requests && Object.keys(session.agentState.requests).length > 0);

    let state: SessionState;
    if (!isOnline) {
        state = 'disconnected';
    } else if (session.agentState?.codexRuntime) {
        const visible = codexRuntimePresentation(session.agentState.codexRuntime,
            Object.values(session.agentState.requests ?? {}).map((request) => request.tool));
        state = visible.waiting ? 'permission_required' : visible.busy ? 'thinking' : 'waiting';
    } else if (hasPermissions) {
        state = 'permission_required';
    } else if (session.thinking) {
        state = 'thinking';
    } else {
        state = 'waiting';
    }

    return {
        id: session.id,
        name: getSessionName(session),
        subtitle: getSessionSubtitle(session),
        avatarId: getSessionAvatarId(session),
        flavor: session.metadata?.flavor ?? null,
        state,
        ...(!session.active && { activeAt: session.activeAt }),
        createdAt: session.createdAt,
        questionOrderId: session.questionOrderId ?? session.conversationId ?? session.id,
        questionFallbackCreatedAt: session.questionFallbackCreatedAt,
        lastUserMessageAt: session.lastUserMessageAt,
        questionTimeIndexed: (session.lastUserMessageIndexedSeq ?? 0) >= session.seq,
        hasDraft: !!session.draft || !!session.hasDraft,
        active: session.active,
        machineId: session.metadata?.machineId ?? null,
        path: session.metadata?.path ?? null,
        homeDir: session.metadata?.homeDir ?? null,
        completedTodosCount: session.todos?.filter(todo => todo.status === 'completed').length ?? 0,
        totalTodosCount: session.todos?.length ?? 0,
    };
}

// Unified list item type for SessionsList component
export type SessionListViewItem =
    { type: 'workspace-group'; group: WorkspaceSessionGroup<SessionRowData> };

// Legacy type for backward compatibility - to be removed
export type SessionListItem = string | Session;

interface StorageState {
    settings: Settings;
    settingsVersion: number | null;
    localSettings: LocalSettings;
    profile: Profile;
    sessions: Record<string, Session>;
    sessionsData: SessionListItem[] | null;  // Legacy - to be removed
    sessionListViewData: SessionListViewItem[] | null;
    sessionMessages: Record<string, SessionMessages>;
    sessionViewStates: Record<string, SessionViewState>;
    sessionResourceAccess: Record<string, number>;
    releasedSessionResources: Record<string, boolean>;
    sessionStreams: Record<string, SessionStreamState | undefined>;
    sessionGitStatus: Record<string, GitStatus | null>;
    sessionGitStatusFiles: Record<string, GitStatusFiles | null>;
    sessionFileCache: Record<string, Record<string, { content: string | null; diff: string | null; isBinary: boolean; cachedAt: number; size?: number; modified?: number }>>;
    machines: Record<string, Machine>;
    artifacts: Record<string, DecryptedArtifact>;  // New artifacts storage
    friends: Record<string, UserProfile>;  // All relationships (friends, pending, requested, etc.)
    users: Record<string, UserProfile | null>;  // Global user cache, null = 404/failed fetch
    feedItems: FeedItem[];  // Simple list of feed items
    feedHead: string | null;  // Newest cursor
    feedTail: string | null;  // Oldest cursor
    feedHasMore: boolean;
    feedLoaded: boolean;  // True after initial feed fetch
    friendsLoaded: boolean;  // True after initial friends fetch
    realtimeStatus: 'disconnected' | 'connecting' | 'connected' | 'error';
    realtimeMode: 'idle' | 'agent-speaking' | 'user-speaking';
    socketStatus: 'disconnected' | 'connecting' | 'connected' | 'error';
    socketLastConnectedAt: number | null;
    socketLastDisconnectedAt: number | null;
    isDataReady: boolean;
    nativeUpdateStatus: { available: boolean; updateUrl?: string } | null;
    applySessions: (sessions: (Omit<Session, 'presence'> & { presence?: "online" | number })[]) => void;
    applyMachines: (machines: Machine[], replace?: boolean) => void;
    deleteMachine: (machineId: string) => void;
    applyLoaded: () => void;
    applyReady: () => void;
    applyMessages: (sessionId: string, messages: NormalizedMessage[], options?: { rebuild?: boolean; replace?: boolean; keep?: 'newest' | 'oldest' }) => { changed: string[], hasReadyEvent: boolean };
    applySessionStream: (sessionId: string, stream: SessionStream) => void;
    clearSessionStream: (sessionId: string, turnId?: string) => void;
    touchSessionResources: (sessionId: string) => void;
    unloadSessionResources: (sessionId: string) => void;
    enforceSessionCacheBudget: (protectedSessionId?: string) => void;
    saveSessionScrollAnchor: (sessionId: string, anchor: SessionScrollAnchor) => void;
    setSessionHistoryState: (sessionId: string, view: Pick<SessionViewState, 'historyDirection' | 'historyLoading'>) => void;
    applyMessagesLoaded: (sessionId: string) => void;
    applyMessagePageState: (sessionId: string, page: { hasOlder?: boolean; hasNewer?: boolean; isLoadingOlder?: boolean; isLoadingLatest?: boolean; cachedEventCount?: number }) => void;
    applySettings: (settings: Settings, version: number) => void;
    applySettingsLocal: (settings: Partial<Settings>) => void;
    applyLocalSettings: (settings: Partial<LocalSettings>) => void;
    applyProfile: (profile: Profile) => void;
    applyGitStatus: (sessionId: string, status: GitStatus | null) => void;
    applyGitStatusFiles: (sessionId: string, files: GitStatusFiles | null) => void;
    applyFileCache: (sessionId: string, filePath: string, content: string | null, diff: string | null, isBinary: boolean, metadata?: { size?: number; modified?: number }) => void;
    applyNativeUpdateStatus: (status: { available: boolean; updateUrl?: string } | null) => void;
    isMutableToolCall: (sessionId: string, callId: string) => boolean;
    setRealtimeStatus: (status: 'disconnected' | 'connecting' | 'connected' | 'error') => void;
    setRealtimeMode: (mode: 'idle' | 'agent-speaking' | 'user-speaking', immediate?: boolean) => void;
    clearRealtimeModeDebounce: () => void;
    setSocketStatus: (status: 'disconnected' | 'connecting' | 'connected' | 'error') => void;
    getActiveSessions: () => Session[];
    updateSessionDraft: (sessionId: string, draft: string | null) => void;
    updateSessionPermissionMode: (sessionId: string, mode: string) => void;
    updateSessionModelMode: (sessionId: string, mode: string) => void;
    updateSessionEffortLevel: (sessionId: string, level: string) => void;
    updateSessionCodexPreferences: (sessionId: string, preferences: Partial<CodexPreferences>) => void;
    // Artifact methods
    applyArtifacts: (artifacts: DecryptedArtifact[]) => void;
    addArtifact: (artifact: DecryptedArtifact) => void;
    updateArtifact: (artifact: DecryptedArtifact) => void;
    deleteArtifact: (artifactId: string) => void;
    deleteSession: (sessionId: string) => void;
    // Project management methods
    getProjects: () => import('./projectManager').Project[];
    getProject: (projectId: string) => import('./projectManager').Project | null;
    getProjectForSession: (sessionId: string) => import('./projectManager').Project | null;
    getProjectSessions: (projectId: string) => string[];
    // Project git status methods
    getProjectGitStatus: (projectId: string) => import('./storageTypes').GitStatus | null;
    getSessionProjectGitStatus: (sessionId: string) => import('./storageTypes').GitStatus | null;
    updateSessionProjectGitStatus: (sessionId: string, status: import('./storageTypes').GitStatus | null) => void;
    // Friend management methods
    applyFriends: (friends: UserProfile[]) => void;
    applyRelationshipUpdate: (event: RelationshipUpdatedEvent) => void;
    getFriend: (userId: string) => UserProfile | undefined;
    getAcceptedFriends: () => UserProfile[];
    // User cache methods
    applyUsers: (users: Record<string, UserProfile | null>) => void;
    getUser: (userId: string) => UserProfile | null | undefined;
    assumeUsers: (userIds: string[]) => Promise<void>;
    // Feed methods
    applyFeedItems: (items: FeedItem[]) => void;
    clearFeed: () => void;
}

// Helper function to build unified list view data from sessions and machines
function buildSessionListViewData(
    sessions: Record<string, Session>
): SessionListViewItem[] {
    return buildWorkspaceSessionGroups(Object.values(sessions)).map(group => ({
        type: 'workspace-group',
        group: mapWorkspaceSessionGroup(group, buildSessionRowData),
    }));
}

export const storage = create<StorageState>()((set, get) => {
    let { settings, version } = loadSettings();
    let localSettings = loadLocalSettings();
    let profile = loadProfile();
    const sessionDrafts: Record<string, string> = {};
    let sessionPermissionModes = loadSessionPermissionModes();
    let sessionModelModes = loadSessionModelModes();
    let sessionEffortLevels = loadSessionEffortLevels();
    return {
        settings,
        settingsVersion: version,
        localSettings,
        profile,
        sessions: {},
        machines: {},
        artifacts: {},  // Initialize artifacts
        friends: {},  // Initialize relationships cache
        users: {},  // Initialize global user cache
        feedItems: [],  // Initialize feed items list
        feedHead: null,
        feedTail: null,
        feedHasMore: false,
        feedLoaded: false,  // Initialize as false
        friendsLoaded: false,  // Initialize as false
        sessionsData: null,  // Legacy - to be removed
        sessionListViewData: null,
        sessionMessages: {},
        sessionViewStates: {},
        sessionResourceAccess: {},
        releasedSessionResources: {},
        sessionStreams: {},
        sessionGitStatus: {},
        sessionGitStatusFiles: {},
        sessionFileCache: {},
        realtimeStatus: 'disconnected',
        realtimeMode: 'idle',
        socketStatus: 'disconnected',
        socketLastConnectedAt: null,
        socketLastDisconnectedAt: null,
        isDataReady: false,
        nativeUpdateStatus: null,
        isMutableToolCall: (sessionId: string, callId: string) => {
            const sessionMessages = get().sessionMessages[sessionId];
            if (!sessionMessages) {
                return true;
            }
            const toolCall = sessionMessages.reducerState.toolIdToMessageId.get(callId);
            if (!toolCall) {
                return true;
            }
            const toolCallMessage = sessionMessages.messagesMap[toolCall];
            if (!toolCallMessage || toolCallMessage.kind !== 'tool-call') {
                return true;
            }
            return toolCallMessage.tool?.name ? isMutableTool(toolCallMessage.tool?.name) : true;
        },
        touchSessionResources: (sessionId) => set((state) => {
            const session = state.sessions[sessionId];
            const draft = session && !state.sessionResourceAccess[sessionId] ? loadSessionDrafts()[sessionId] : session?.draft;
            return {
                sessionResourceAccess: { ...state.sessionResourceAccess, [sessionId]: Date.now() },
                releasedSessionResources: { ...state.releasedSessionResources, [sessionId]: false },
                ...(session && draft !== session.draft ? { sessions: { ...state.sessions, [sessionId]: { ...session, draft, hasDraft: !!draft } } } : {}),
            };
        }),
        saveSessionScrollAnchor: (sessionId, anchor) => set((state) => ({
            sessionViewStates: { ...state.sessionViewStates, [sessionId]: { ...state.sessionViewStates[sessionId], anchor } },
        })),
        setSessionHistoryState: (sessionId, view) => set((state) => ({
            sessionViewStates: { ...state.sessionViewStates, [sessionId]: { ...state.sessionViewStates[sessionId], ...view } },
        })),
        unloadSessionResources: (sessionId) => {
            set((state) => {
                const page = state.sessionMessages[sessionId];
                const raw = Object.values(page?.rawMessagesMap ?? {});
                const seqs = raw.flatMap((message) => typeof message.seq === 'number' ? [message.seq] : []);
                const omit = <T,>(map: Record<string, T>) => Object.fromEntries(Object.entries(map).filter(([id]) => id !== sessionId));
                const session = state.sessions[sessionId];
                const lightweight = session ? { ...session, hasDraft: !!session.draft || !!session.hasDraft, draft: null, metadata: lightweightMetadata(session.metadata), agentState: lightweightAgentState(session.agentState) } : undefined;
                return {
                    sessionMessages: omit(state.sessionMessages), sessionStreams: omit(state.sessionStreams),
                    sessionFileCache: omit(state.sessionFileCache), sessionGitStatusFiles: omit(state.sessionGitStatusFiles),
                    sessionGitStatus: omit(state.sessionGitStatus), sessionResourceAccess: omit(state.sessionResourceAccess),
                    releasedSessionResources: { ...state.releasedSessionResources, [sessionId]: true },
                    sessionViewStates: { ...state.sessionViewStates, [sessionId]: {
                        ...state.sessionViewStates[sessionId],
                        ...(page ? { hasOlder: page.hasOlder, hasNewer: page.hasNewer, wasLoaded: page.isLoaded } : {}),
                        ...(seqs.length ? { oldestSeq: Math.min(...seqs), newestSeq: Math.max(...seqs) } : {}),
                    } },
                    ...(lightweight ? {
                        sessions: { ...state.sessions, [sessionId]: lightweight },
                        sessionsData: state.sessionsData?.map((item) => typeof item !== 'string' && item.id === sessionId ? lightweight : item) ?? null,
                        sessionListViewData: buildSessionListViewData({ ...state.sessions, [sessionId]: lightweight }),
                    } : {}),
                };
            });
            sessionResources.release(sessionId);
        },
        enforceSessionCacheBudget: (protectedSessionId) => {
            const state = get();
            const ids = new Set([...Object.keys(state.sessionMessages), ...Object.keys(state.sessionStreams), ...Object.keys(state.sessionFileCache)]);
            const sizes = [...ids].map((id) => ({ id, bytes: estimateRetainedBytes([
                state.sessionMessages[id], state.sessionStreams[id], state.sessionFileCache[id], state.sessionGitStatusFiles[id],
            ]), at: state.sessionResourceAccess[id] ?? 0 }));
            let bytes = sizes.reduce((total, item) => total + item.bytes, 0);
            for (const item of sizes.sort((a, b) => a.at - b.at)) {
                if (bytes <= MAX_SESSION_CACHE_BYTES) break;
                if (item.id === protectedSessionId) continue;
                get().unloadSessionResources(item.id);
                bytes -= item.bytes;
            }
        },
        applySessionStream: (sessionId, stream) => { set((state) => {
            if (state.releasedSessionResources[sessionId]) return state;
            const current = state.sessionStreams[sessionId] ?? createSessionStreamState();
            const next = acceptSessionStream(current, stream);
            if (next === current) return state;
            const existing = state.sessionMessages[sessionId] ?? {
                messages: [], messagesMap: {}, rawMessagesMap: {}, reducerState: createReducer(), isLoaded: false,
            };
            const messagesMap = projectSessionStreams(existing.messagesMap, next, existing.reducerState.toolIdToMessageId, existing.reducerState.sidechainToolIdToMessageId);
            return {
                ...state,
                sessionStreams: { ...state.sessionStreams, [sessionId]: next },
                sessionMessages: {
                    ...state.sessionMessages,
                    [sessionId]: { ...existing, messagesMap, messages: Object.values(messagesMap).sort((a, b) => b.createdAt - a.createdAt) },
                },
            };
        }); get().enforceSessionCacheBudget(sessionId); },
        clearSessionStream: (sessionId, turnId) => set((state) => {
            const current = state.sessionStreams[sessionId];
            if (!current) return state;
            const next = {
                ...current,
                pending: Object.fromEntries(Object.entries(current.pending).filter(([, stream]) => turnId && stream.turnId !== turnId)),
            };
            const existing = state.sessionMessages[sessionId];
            const messagesMap = existing ? projectSessionStreams(existing.messagesMap, next, existing.reducerState.toolIdToMessageId, existing.reducerState.sidechainToolIdToMessageId) : {};
            return {
                ...state,
                sessionStreams: { ...state.sessionStreams, [sessionId]: next },
                ...(existing ? { sessionMessages: { ...state.sessionMessages, [sessionId]: {
                    ...existing, messagesMap, messages: Object.values(messagesMap).sort((a, b) => b.createdAt - a.createdAt),
                } } } : {}),
            };
        }),
        getActiveSessions: () => {
            const state = get();
            return Object.values(state.sessions).filter(s => s.active);
        },
        applySessions: (sessions: (Omit<Session, 'presence'> & { presence?: "online" | number })[]) => set((state) => {
            // Historical rows can arrive after the initial batch; hydrate each arriving row.
            const savedDrafts = loadSessionDrafts();
            const savedPermissionModes = loadSessionPermissionModes();
            const savedModelModes = loadSessionModelModes();
            const savedEffortLevels = loadSessionEffortLevels();
            const savedCodexPreferences = loadSessionCodexPreferences();

            // Merge new sessions with existing ones
            const mergedSessions: Record<string, Session> = { ...state.sessions };

            // Update sessions with calculated presence using centralized resolver
            sessions.forEach(session => {
                // Use centralized resolver for consistent state management
                const presence = resolveSessionOnlineState(session);

                // Preserve existing draft and permission mode if they exist, or load from saved data
                const existingDraft = state.sessions[session.id]?.draft;
                const savedDraft = savedDrafts[session.id];
                const existingPermissionMode = state.sessions[session.id]?.permissionMode;
                const savedPermissionMode = savedPermissionModes[session.id];
                const existingModelMode = state.sessions[session.id]?.modelMode;
                const savedModelMode = savedModelModes[session.id];
                const existingEffortLevel = state.sessions[session.id]?.effortLevel;
                const savedEffortLevel = savedEffortLevels[session.id];
                const defaultPermissionMode = defaultPermissionModeForSession(session.metadata);
                const resolvedPermissionMode: PermissionModeKey =
                    existingPermissionMode ?? savedPermissionMode ?? session.permissionMode ??
                    defaultPermissionMode;

                mergedSessions[session.id] = {
                    ...session,
                    ...mergeSessionQuestionState(state.sessions[session.id], session),
                    ...(state.sessions[session.id] && session.metadataVersion < state.sessions[session.id].metadataVersion ? {
                        metadata: state.sessions[session.id].metadata,
                        metadataVersion: state.sessions[session.id].metadataVersion,
                    } : {}),
                    ...(state.sessions[session.id] && session.agentStateVersion < state.sessions[session.id].agentStateVersion ? {
                        agentState: state.sessions[session.id].agentState,
                        agentStateVersion: state.sessions[session.id].agentStateVersion,
                    } : {}),
                    presence,
                    draft: existingDraft || savedDraft || session.draft || null,
                    hasDraft: state.sessions[session.id]?.hasDraft ?? !!(existingDraft || savedDraft || session.draft),
                    permissionMode: resolvedPermissionMode,
                    modelMode: existingModelMode || savedModelMode || session.modelMode,
                    effortLevel: existingEffortLevel || savedEffortLevel || session.effortLevel,
                    codexPreferences: state.sessions[session.id]?.codexPreferences ?? savedCodexPreferences[session.id] ?? session.codexPreferences,
                };
                if (!state.sessionResourceAccess[session.id] && !state.sessionMessages[session.id]) {
                    mergedSessions[session.id].agentState = lightweightAgentState(mergedSessions[session.id].agentState);
                    mergedSessions[session.id].metadata = lightweightMetadata(mergedSessions[session.id].metadata);
                    mergedSessions[session.id].draft = null;
                }
            });

            // A canonical encrypted record owns preferences across runtime replacements and devices.
            for (const session of Object.values(mergedSessions)) {
                if (sync.hasPendingSessionConfiguration?.(session.id)) continue;
                const owner = configurationOwner(session, mergedSessions);
                mergedSessions[session.id] = { ...session, ...projectSessionConfiguration(session, mergedSessions[owner]?.metadata?.executionConfiguration) };
            }

            // Build active set from all sessions (including existing ones)
            const activeSet = new Set<string>();
            Object.values(mergedSessions).forEach(session => {
                if (isSessionActive(session)) {
                    activeSet.add(session.id);
                }
            });

            // Separate active and inactive sessions
            const activeSessions: Session[] = [];
            const inactiveSessions: Session[] = [];

            // Process all sessions from merged set
            Object.values(mergedSessions).forEach(session => {
                if (activeSet.has(session.id)) {
                    activeSessions.push(session);
                } else {
                    inactiveSessions.push(session);
                }
            });

            activeSessions.sort(compareSessionQuestions);
            inactiveSessions.sort(compareSessionQuestions);

            // Build flat list data for FlashList
            const listData: SessionListItem[] = [];

            if (activeSessions.length > 0) {
                listData.push('online');
                listData.push(...activeSessions);
            }

            // Legacy sessionsData - to be removed
            // Machines are now integrated into sessionListViewData

            if (inactiveSessions.length > 0) {
                listData.push('offline');
                listData.push(...inactiveSessions);
            }

            // console.log(`📊 Storage: applySessions called with ${sessions.length} sessions, active: ${activeSessions.length}, inactive: ${inactiveSessions.length}`);

            // Process AgentState updates for sessions that already have messages loaded
            const updatedSessionMessages = { ...state.sessionMessages };

            sessions.forEach(session => {
                const oldSession = state.sessions[session.id];
                const newSession = mergedSessions[session.id];

                // Check if sessionMessages exists AND agentStateVersion is newer
                const existingSessionMessages = updatedSessionMessages[session.id];
                if (existingSessionMessages && newSession.agentState &&
                    (!oldSession || newSession.agentStateVersion > (oldSession.agentStateVersion || 0))) {

                    // Process new AgentState through reducer
                    const reducerResult = reducer(existingSessionMessages.reducerState, [], newSession.agentState);
                    const processedMessages = reducerResult.messages;

                    // Always update the session messages, even if no new messages were created
                    // This ensures the reducer state is updated with the new AgentState
                    let mergedMessagesMap = { ...existingSessionMessages.messagesMap };
                    processedMessages.forEach(message => {
                        mergedMessagesMap[message.id] = message;
                    });
                    mergedMessagesMap = projectSessionStreams(mergedMessagesMap,
                        state.sessionStreams[session.id] ?? createSessionStreamState(), existingSessionMessages.reducerState.toolIdToMessageId, existingSessionMessages.reducerState.sidechainToolIdToMessageId);

                    const messagesArray = Object.values(mergedMessagesMap)
                        .sort((a, b) => b.createdAt - a.createdAt);

                    updatedSessionMessages[session.id] = {
                        ...existingSessionMessages,
                        messages: messagesArray,
                        messagesMap: mergedMessagesMap,
                        reducerState: existingSessionMessages.reducerState, // The reducer modifies state in-place, so this has the updates
                        isLoaded: existingSessionMessages.isLoaded
                    };

                    // IMPORTANT: Copy latestUsage from reducerState to Session for immediate availability
                    if (existingSessionMessages.reducerState.latestUsage) {
                        mergedSessions[session.id] = {
                            ...mergedSessions[session.id],
                            latestUsage: { ...existingSessionMessages.reducerState.latestUsage }
                        };
                    }
                }
            });

            // Build new unified list view data
            const sessionListViewData = buildSessionListViewData(
                mergedSessions
            );

            // Update project manager with current sessions and machines
            const machineMetadataMap = new Map<string, any>();
            Object.values(state.machines).forEach(machine => {
                if (machine.metadata) {
                    machineMetadataMap.set(machine.id, machine.metadata);
                }
            });
            projectManager.updateSessions(Object.values(mergedSessions), machineMetadataMap);

            return {
                ...state,
                sessions: mergedSessions,
                sessionsData: listData,  // Legacy - to be removed
                sessionListViewData,
                sessionMessages: updatedSessionMessages
            };
        }),
        applyLoaded: () => set((state) => {
            const result = {
                ...state,
                sessionsData: []
            };
            return result;
        }),
        applyReady: () => set((state) => ({
            ...state,
            isDataReady: true
        })),
        applyMessages: (sessionId: string, messages: NormalizedMessage[], options = {}) => {
            if (get().releasedSessionResources[sessionId]) return { changed: [], hasReadyEvent: false };
            let changed = new Set<string>();
            let hasReadyEvent = false;

            // Track plan mode transitions through the batch in order.
            // Set true on EnterPlanMode, false on ExitPlanMode. The final value
            // tells us whether the batch ends with an unresolved plan entry.
            // This prevents history replays (which contain both Enter + Exit) from
            // re-triggering plan mode, while still catching real-time EnterPlanMode.
            let shouldEnterPlanMode = false;
            for (const msg of messages) {
                if (msg.role === 'agent') {
                    for (const c of msg.content) {
                        if (c.type === 'tool-call') {
                            if (c.name === 'EnterPlanMode' || c.name === 'enter_plan_mode') {
                                shouldEnterPlanMode = true;
                            } else if (c.name === 'ExitPlanMode' || c.name === 'exit_plan_mode') {
                                shouldEnterPlanMode = false;
                            }
                        }
                    }
                }
            }

            set((state) => {

                // Resolve session messages state
                const existingSession = state.sessionMessages[sessionId] || {
                    messages: [],
                    messagesMap: {},
                    rawMessagesMap: {},
                    reducerState: createReducer(),
                    isLoaded: false
                };

                // Get the session's agentState if available
                const session = state.sessions[sessionId];
                const agentState = session?.agentState;

                const window = mergeMessageWindow(existingSession.rawMessagesMap ?? {}, messages, options);
                const rawMessagesMap = window.map;
                const rawMessages = window.messages;
                const trimmed = window.trimmed;
                const rebuild = options.rebuild || options.replace || trimmed;
                const normalizedMessages = rebuild
                    ? rawMessages
                    : messages.map((message) => rawMessagesMap[message.id]).filter((message): message is NormalizedMessage => !!message);
                const activeReducerState = rebuild ? createReducer() : existingSession.reducerState;

                // Run reducer with agentState
                const reducerResult = reducer(activeReducerState, normalizedMessages, agentState);
                const processedMessages = reducerResult.messages;
                for (let message of processedMessages) {
                    changed.add(message.id);
                }
                if (!rebuild && reducerResult.hasReadyEvent) {
                    hasReadyEvent = true;
                }

                // Merge messages
                let mergedMessagesMap: Record<string, Message> = rebuild ? {} : { ...existingSession.messagesMap };
                const preserveTurnPreview = (message: Message, prior: Message | undefined): void => {
                    if (message.kind !== 'tool-call' || prior?.kind !== 'tool-call') return;
                    if (message.tool.completedByTurn && typeof prior.tool.result === 'object' && prior.tool.result !== null) {
                        message.tool.result = { ...prior.tool.result, ...message.tool.result };
                    }
                    const priorChildren = new Map(prior.children.map((child) => [child.id, child]));
                    message.children.forEach((child) => preserveTurnPreview(child, priorChildren.get(child.id)));
                };
                processedMessages.forEach(message => {
                    preserveTurnPreview(message, existingSession.messagesMap[message.id]);
                    mergedMessagesMap[message.id] = message;
                });
                const streams = commitSessionStreams(state.sessionStreams[sessionId] ?? createSessionStreamState(), normalizedMessages);
                mergedMessagesMap = projectSessionStreams(mergedMessagesMap, streams, activeReducerState.toolIdToMessageId, activeReducerState.sidechainToolIdToMessageId);

                // Convert to array and sort by createdAt
                const messagesArray = Object.values(mergedMessagesMap)
                    .sort((a, b) => b.createdAt - a.createdAt);

                // Update session with todos and latestUsage
                // IMPORTANT: We extract latestUsage from the mutable reducerState and copy it to the Session object
                // This ensures latestUsage is available immediately on load, even before messages are fully loaded
                let updatedSessions = state.sessions;
                const needsUpdate = (reducerResult.todos !== undefined || activeReducerState.latestUsage || shouldEnterPlanMode) && session;

                if (needsUpdate) {
                    updatedSessions = {
                        ...state.sessions,
                        [sessionId]: {
                            ...session,
                            ...(reducerResult.todos !== undefined && { todos: reducerResult.todos }),
                            // Copy latestUsage from reducerState to make it immediately available
                            latestUsage: activeReducerState.latestUsage ? {
                                ...activeReducerState.latestUsage
                            } : session.latestUsage,
                            // Auto-switch to plan mode when EnterPlanMode tool call is detected
                            ...(shouldEnterPlanMode && { permissionMode: 'plan' })
                        }
                    };
                }

                return {
                    ...state,
                    sessions: updatedSessions,
                    sessionStreams: { ...state.sessionStreams, [sessionId]: streams },
                    sessionMessages: {
                        ...state.sessionMessages,
                        [sessionId]: {
                            ...existingSession,
                            messages: messagesArray,
                            messagesMap: mergedMessagesMap,
                            rawMessagesMap,
                            cachedEventCount: Object.keys(rawMessagesMap).length,
                            cachedBytes: window.bytes,
                            ...(trimmed && options.keep === 'oldest' ? { hasNewer: true } : {}),
                            ...(trimmed && options.keep !== 'oldest' ? { hasOlder: true } : {}),
                            reducerState: activeReducerState,
                            isLoaded: true
                        }
                    }
                };
            });

            // Persist plan mode change
            if (shouldEnterPlanMode) {
                const allModes: Record<string, string> = {};
                const currentState = get();
                Object.entries(currentState.sessions).forEach(([id, sess]) => {
                    if (sess.permissionMode) {
                        allModes[id] = sess.permissionMode;
                    }
                });
                saveSessionPermissionModes(allModes);
            }

            get().enforceSessionCacheBudget(sessionId);
            return { changed: Array.from(changed), hasReadyEvent };
        },
        applyMessagesLoaded: (sessionId: string) => set((state) => {
            if (state.releasedSessionResources[sessionId]) return state;
            const existingSession = state.sessionMessages[sessionId];
            let result: StorageState;

            if (!existingSession) {
                // First time loading - check for AgentState
                const session = state.sessions[sessionId];
                const agentState = session?.agentState;

                // Create new reducer state
                const reducerState = createReducer();

                // Process AgentState if it exists
                let messages: Message[] = [];
                let messagesMap: Record<string, Message> = {};

                if (agentState) {
                    // Process AgentState through reducer to get initial permission messages
                    const reducerResult = reducer(reducerState, [], agentState);
                    const processedMessages = reducerResult.messages;

                    processedMessages.forEach(message => {
                        messagesMap[message.id] = message;
                    });

                    messages = Object.values(messagesMap)
                        .sort((a, b) => b.createdAt - a.createdAt);
                }

                // Extract latestUsage from reducerState if available and update session
                let updatedSessions = state.sessions;
                if (session && reducerState.latestUsage) {
                    updatedSessions = {
                        ...state.sessions,
                        [sessionId]: {
                            ...session,
                            latestUsage: { ...reducerState.latestUsage }
                        }
                    };
                }

                result = {
                    ...state,
                    sessions: updatedSessions,
                    sessionMessages: {
                        ...state.sessionMessages,
                        [sessionId]: {
                            reducerState,
                            messages,
                            messagesMap,
                            rawMessagesMap: {},
                            cachedEventCount: 0,
                            isLoaded: true
                        } satisfies SessionMessages
                    }
                };
            } else {
                result = {
                    ...state,
                    sessionMessages: {
                        ...state.sessionMessages,
                        [sessionId]: {
                            ...existingSession,
                            isLoaded: true
                        } satisfies SessionMessages
                    }
                };
            }

            return result;
        }),
        applyMessagePageState: (sessionId, page) => set((state) => {
            if (state.releasedSessionResources[sessionId]) return state;
            const existingSession = state.sessionMessages[sessionId] ?? {
                reducerState: createReducer(),
                messages: [],
                messagesMap: {},
                rawMessagesMap: {},
                isLoaded: false,
            };
            return {
                ...state,
                sessionMessages: {
                    ...state.sessionMessages,
                    [sessionId]: { ...existingSession, ...page },
                },
            };
        }),
        applySettingsLocal: (settings: Partial<Settings>) => set((state) => {
            saveSettings(applySettings(state.settings, settings), state.settingsVersion ?? 0);
            return {
                ...state,
                settings: applySettings(state.settings, settings)
            };
        }),
        applySettings: (settings: Settings, version: number) => set((state) => {
            if (state.settingsVersion === null || state.settingsVersion < version) {
                saveSettings(settings, version);
                return {
                    ...state,
                    settings,
                    settingsVersion: version
                };
            } else {
                return state;
            }
        }),
        applyLocalSettings: (delta: Partial<LocalSettings>) => set((state) => {
            const updatedLocalSettings = applyLocalSettings(state.localSettings, delta);
            saveLocalSettings(updatedLocalSettings);
            return {
                ...state,
                localSettings: updatedLocalSettings
            };
        }),
        applyProfile: (profile: Profile) => set((state) => {
            // Always save and update profile
            saveProfile(profile);
            return {
                ...state,
                profile
            };
        }),
        applyGitStatus: (sessionId: string, status: GitStatus | null) => set((state) => {
            if (state.releasedSessionResources[sessionId]) return state;
            // Update project git status as well
            projectManager.updateSessionProjectGitStatus(sessionId, status);

            return {
                ...state,
                sessionGitStatus: {
                    ...state.sessionGitStatus,
                    [sessionId]: status
                }
            };
        }),
        applyGitStatusFiles: (sessionId: string, files: GitStatusFiles | null) => set((state) => ({
            ...state,
            sessionGitStatusFiles: {
                ...state.sessionGitStatusFiles,
                ...(!state.releasedSessionResources[sessionId] ? { [sessionId]: files } : {}),
            }
        })),
        applyFileCache: (sessionId: string, filePath: string, content: string | null, diff: string | null, isBinary: boolean, metadata) => { set((state) => {
            if (state.releasedSessionResources[sessionId]) return state;
            const nextSessionCache = {
                ...(state.sessionFileCache[sessionId] || {}),
                [filePath]: { content, diff, isBinary, cachedAt: Date.now(), ...metadata },
            };
            const entries = Object.entries(nextSessionCache);
            const MAX_FILES_PER_SESSION = 24;
            if (entries.length > MAX_FILES_PER_SESSION) {
                entries
                    .sort(([, left], [, right]) => right.cachedAt - left.cachedAt)
                    .slice(MAX_FILES_PER_SESSION)
                    .forEach(([stalePath]) => delete nextSessionCache[stalePath]);
            }
            let bytes = estimateRetainedBytes(nextSessionCache);
            for (const [path, entry] of Object.entries(nextSessionCache).sort(([, a], [, b]) => a.cachedAt - b.cachedAt)) {
                if (bytes <= 2 * 1024 * 1024) break;
                bytes -= estimateRetainedBytes(entry) + path.length * 2 + 8;
                delete nextSessionCache[path];
            }
            return {
                ...state,
                sessionFileCache: {
                    ...state.sessionFileCache,
                    [sessionId]: nextSessionCache,
                },
            };
        }); get().enforceSessionCacheBudget(sessionId); },
        applyNativeUpdateStatus: (status: { available: boolean; updateUrl?: string } | null) => set((state) => ({
            ...state,
            nativeUpdateStatus: status
        })),
        setRealtimeStatus: (status: 'disconnected' | 'connecting' | 'connected' | 'error') => set((state) => ({
            ...state,
            realtimeStatus: status
        })),
        setRealtimeMode: (mode: 'idle' | 'agent-speaking' | 'user-speaking', immediate?: boolean) => {
            if (immediate) {
                // Clear any pending debounce and set immediately
                if (realtimeModeDebounceTimer) {
                    clearTimeout(realtimeModeDebounceTimer);
                    realtimeModeDebounceTimer = null;
                }
                set((state) => ({ ...state, realtimeMode: mode }));
            } else {
                // Debounce mode changes to avoid flickering
                if (realtimeModeDebounceTimer) {
                    clearTimeout(realtimeModeDebounceTimer);
                }
                realtimeModeDebounceTimer = setTimeout(() => {
                    realtimeModeDebounceTimer = null;
                    set((state) => ({ ...state, realtimeMode: mode }));
                }, REALTIME_MODE_DEBOUNCE_MS);
            }
        },
        clearRealtimeModeDebounce: () => {
            if (realtimeModeDebounceTimer) {
                clearTimeout(realtimeModeDebounceTimer);
                realtimeModeDebounceTimer = null;
            }
        },
        setSocketStatus: (status: 'disconnected' | 'connecting' | 'connected' | 'error') => set((state) => {
            const now = Date.now();
            const updates: Partial<StorageState> = {
                socketStatus: status,
            };

            // Update timestamp based on status
            if (status === 'connected') {
                updates.socketLastConnectedAt = now;
            } else if (status === 'disconnected' || status === 'error') {
                updates.socketLastDisconnectedAt = now;
            }

            return {
                ...state,
                ...updates
            };
        }),
        updateSessionDraft: (sessionId: string, draft: string | null) => set((state) => {
            const session = state.sessions[sessionId];
            if (!session) return state;

            // Don't store empty strings, convert to null
            const normalizedDraft = draft?.trim() ? draft : null;

            // Sleeping sessions retain their drafts only in persistent storage.
            const allDrafts = loadSessionDrafts();
            if (normalizedDraft) allDrafts[sessionId] = normalizedDraft;
            else delete allDrafts[sessionId];

            // Persist drafts
            saveSessionDrafts(allDrafts);

            const updatedSessions = {
                ...state.sessions,
                [sessionId]: {
                    ...session,
                    hasDraft: !!normalizedDraft,
                    draft: state.releasedSessionResources[sessionId] ? null : normalizedDraft
                }
            };

            return {
                ...state,
                sessions: updatedSessions,
                sessionListViewData: buildSessionListViewData(updatedSessions)
            };
        }),
        updateSessionPermissionMode: (sessionId: string, mode: string) => set((state) => {
            const session = state.sessions[sessionId];
            if (!session) return state;
            sync.queueSessionConfiguration?.(sessionId, { permissionMode: mode as any });

            // Update the session with the new permission mode
            const updatedSessions = {
                ...state.sessions,
                [sessionId]: {
                    ...session,
                    permissionMode: mode
                }
            };

            // Collect all permission modes for persistence
            const allModes: Record<string, string> = {};
            Object.entries(updatedSessions).forEach(([id, sess]) => {
                if (sess.permissionMode) {
                    allModes[id] = sess.permissionMode;
                }
            });

            // Persist permission modes (only non-default values to save space)
            saveSessionPermissionModes(allModes);

            // No need to rebuild sessionListViewData since permission mode doesn't affect the list display
            return {
                ...state,
                sessions: updatedSessions
            };
        }),
        updateSessionModelMode: (sessionId: string, mode: string) => set((state) => {
            const session = state.sessions[sessionId];
            if (!session) return state;
            sync.queueSessionConfiguration?.(sessionId, { model: mode === 'default' ? null : mode });

            // Update the session with the new model mode
            const updatedSessions = {
                ...state.sessions,
                [sessionId]: {
                    ...session,
                    modelMode: mode
                }
            };

            const allModes: Record<string, string> = {};
            Object.entries(updatedSessions).forEach(([id, sess]) => {
                if (sess.modelMode && sess.modelMode !== 'default') allModes[id] = sess.modelMode;
            });
            saveSessionModelModes(allModes);

            // No need to rebuild sessionListViewData since model mode doesn't affect the list display
            return {
                ...state,
                sessions: updatedSessions
            };
        }),
        updateSessionCodexPreferences: (sessionId, preferences) => set(state => {
            const session = state.sessions[sessionId];
            if (!session) return state;
            sync.queueSessionConfiguration?.(sessionId, preferencesPatch(preferences));
            const merged = { verbosity: 'default' as const, serviceTier: 'default', collaborationMode: 'default' as const, ...session.codexPreferences, ...preferences };
            saveSessionCodexPreferences({ ...loadSessionCodexPreferences(), [sessionId]: merged });
            return { sessions: { ...state.sessions, [sessionId]: { ...session, codexPreferences: merged } } };
        }),
        updateSessionEffortLevel: (sessionId: string, level: string) => set((state) => {
            const session = state.sessions[sessionId];
            if (!session) return state;
            sync.queueSessionConfiguration?.(sessionId, { effort: level === 'default' ? null : level });

            const updatedSessions = {
                ...state.sessions,
                [sessionId]: {
                    ...session,
                    effortLevel: level
                }
            };

            const allLevels: Record<string, string> = {};
            Object.entries(updatedSessions).forEach(([id, sess]) => {
                if (sess.effortLevel) allLevels[id] = sess.effortLevel;
            });
            saveSessionEffortLevels(allLevels);

            return {
                ...state,
                sessions: updatedSessions
            };
        }),
        // Project management methods
        getProjects: () => projectManager.getProjects(),
        getProject: (projectId: string) => projectManager.getProject(projectId),
        getProjectForSession: (sessionId: string) => projectManager.getProjectForSession(sessionId),
        getProjectSessions: (projectId: string) => projectManager.getProjectSessions(projectId),
        // Project git status methods
        getProjectGitStatus: (projectId: string) => projectManager.getProjectGitStatus(projectId),
        getSessionProjectGitStatus: (sessionId: string) => projectManager.getSessionProjectGitStatus(sessionId),
        updateSessionProjectGitStatus: (sessionId: string, status: GitStatus | null) => {
            projectManager.updateSessionProjectGitStatus(sessionId, status);
            // Trigger a state update to notify hooks
            set((state) => ({ ...state }));
        },
        applyMachines: (machines: Machine[], replace: boolean = false) => set((state) => {
            // Either replace all machines or merge updates
            let mergedMachines: Record<string, Machine>;

            if (replace) {
                // Replace entire machine state (used by fetchMachines)
                mergedMachines = {};
                machines.forEach(machine => {
                    mergedMachines[machine.id] = machine;
                });
            } else {
                // Merge individual updates (used by update-machine)
                mergedMachines = { ...state.machines };
                machines.forEach(machine => {
                    mergedMachines[machine.id] = machine;
                });
            }

            // Rebuild sessionListViewData to reflect machine changes
            const sessionListViewData = buildSessionListViewData(
                state.sessions
            );

            return {
                ...state,
                machines: mergedMachines,
                sessionListViewData
            };
        }),
        deleteMachine: (machineId: string) => set((state) => {
            if (!state.machines[machineId]) {
                return state;
            }
            const { [machineId]: _removed, ...remaining } = state.machines;
            return {
                ...state,
                machines: remaining,
                sessionListViewData: buildSessionListViewData(state.sessions)
            };
        }),
        // Artifact methods
        applyArtifacts: (artifacts: DecryptedArtifact[]) => set((state) => {
            console.log(`🗂️ Storage.applyArtifacts: Applying ${artifacts.length} artifacts`);
            const mergedArtifacts = { ...state.artifacts };
            artifacts.forEach(artifact => {
                mergedArtifacts[artifact.id] = artifact;
            });
            console.log(`🗂️ Storage.applyArtifacts: Total artifacts after merge: ${Object.keys(mergedArtifacts).length}`);
            
            return {
                ...state,
                artifacts: mergedArtifacts
            };
        }),
        addArtifact: (artifact: DecryptedArtifact) => set((state) => {
            const updatedArtifacts = {
                ...state.artifacts,
                [artifact.id]: artifact
            };
            
            return {
                ...state,
                artifacts: updatedArtifacts
            };
        }),
        updateArtifact: (artifact: DecryptedArtifact) => set((state) => {
            const updatedArtifacts = {
                ...state.artifacts,
                [artifact.id]: artifact
            };
            
            return {
                ...state,
                artifacts: updatedArtifacts
            };
        }),
        deleteArtifact: (artifactId: string) => set((state) => {
            const { [artifactId]: _, ...remainingArtifacts } = state.artifacts;
            
            return {
                ...state,
                artifacts: remainingArtifacts
            };
        }),
        deleteSession: (sessionId: string) => { get().unloadSessionResources(sessionId); set((state) => {
            // Remove session from sessions
            const { [sessionId]: deletedSession, ...remainingSessions } = state.sessions;
            
            // Remove session messages if they exist
            const { [sessionId]: deletedMessages, ...remainingSessionMessages } = state.sessionMessages;
            const { [sessionId]: _streams, ...remainingSessionStreams } = state.sessionStreams;
            
            // Remove session git status if it exists
            const { [sessionId]: deletedGitStatus, ...remainingGitStatus } = state.sessionGitStatus;
            const { [sessionId]: _gitStatusFiles, ...remainingGitStatusFiles } = state.sessionGitStatusFiles;
            const { [sessionId]: _fileCache, ...remainingFileCache } = state.sessionFileCache;

            // Clear drafts and permission modes from persistent storage
            const drafts = loadSessionDrafts();
            delete drafts[sessionId];
            saveSessionDrafts(drafts);
            
            const modes = loadSessionPermissionModes();
            delete modes[sessionId];
            saveSessionPermissionModes(modes);

            const modelModes = loadSessionModelModes();
            delete modelModes[sessionId];
            saveSessionModelModes(modelModes);

            const effortLevels = loadSessionEffortLevels();
            delete effortLevels[sessionId];
            saveSessionEffortLevels(effortLevels);

            const codexPreferences = loadSessionCodexPreferences();
            delete codexPreferences[sessionId];
            saveSessionCodexPreferences(codexPreferences);
            
            // Rebuild sessionListViewData without the deleted session
            const sessionListViewData = buildSessionListViewData(remainingSessions);
            
            return {
                ...state,
                sessions: remainingSessions,
                sessionMessages: remainingSessionMessages,
                sessionStreams: remainingSessionStreams,
                sessionGitStatus: remainingGitStatus,
                sessionGitStatusFiles: remainingGitStatusFiles,
                sessionFileCache: remainingFileCache,
                sessionViewStates: Object.fromEntries(Object.entries(state.sessionViewStates).filter(([id]) => id !== sessionId)),
                sessionResourceAccess: Object.fromEntries(Object.entries(state.sessionResourceAccess).filter(([id]) => id !== sessionId)),
                sessionListViewData
            };
        }); },
        // Friend management methods
        applyFriends: (friends: UserProfile[]) => set((state) => {
            const mergedFriends = { ...state.friends };
            friends.forEach(friend => {
                mergedFriends[friend.id] = friend;
            });
            return {
                ...state,
                friends: mergedFriends,
                friendsLoaded: true  // Mark as loaded after first fetch
            };
        }),
        applyRelationshipUpdate: (event: RelationshipUpdatedEvent) => set((state) => {
            const { fromUserId, toUserId, status, action, fromUser, toUser } = event;
            const currentUserId = state.profile.id;
            
            // Update friends cache
            const updatedFriends = { ...state.friends };
            
            // Determine which user profile to update based on perspective
            const otherUserId = fromUserId === currentUserId ? toUserId : fromUserId;
            const otherUser = fromUserId === currentUserId ? toUser : fromUser;
            
            if (action === 'deleted' || status === 'none') {
                // Remove from friends if deleted or status is none
                delete updatedFriends[otherUserId];
            } else if (otherUser) {
                // Update or add the user profile with current status
                updatedFriends[otherUserId] = otherUser;
            }
            
            return {
                ...state,
                friends: updatedFriends
            };
        }),
        getFriend: (userId: string) => {
            return get().friends[userId];
        },
        getAcceptedFriends: () => {
            const friends = get().friends;
            return Object.values(friends).filter(friend => friend.status === 'friend');
        },
        // User cache methods
        applyUsers: (users: Record<string, UserProfile | null>) => set((state) => ({
            ...state,
            users: { ...state.users, ...users }
        })),
        getUser: (userId: string) => {
            return get().users[userId];  // Returns UserProfile | null | undefined
        },
        assumeUsers: async (userIds: string[]) => {
            // This will be implemented in sync.ts as it needs access to credentials
            // Just a placeholder here for the interface
            const { sync } = await import('./sync');
            return sync.assumeUsers(userIds);
        },
        // Feed methods
        applyFeedItems: (items: FeedItem[]) => set((state) => {
            // Always mark feed as loaded even if empty
            if (items.length === 0) {
                return {
                    ...state,
                    feedLoaded: true  // Mark as loaded even when empty
                };
            }

            // Create a map of existing items for quick lookup
            const existingMap = new Map<string, FeedItem>();
            state.feedItems.forEach(item => {
                existingMap.set(item.id, item);
            });

            // Process new items
            const updatedItems = [...state.feedItems];
            let head = state.feedHead;
            let tail = state.feedTail;

            items.forEach(newItem => {
                // Remove items with same repeatKey if it exists
                if (newItem.repeatKey) {
                    const indexToRemove = updatedItems.findIndex(item =>
                        item.repeatKey === newItem.repeatKey
                    );
                    if (indexToRemove !== -1) {
                        updatedItems.splice(indexToRemove, 1);
                    }
                }

                // Add new item if it doesn't exist
                if (!existingMap.has(newItem.id)) {
                    updatedItems.push(newItem);
                }

                // Update head/tail cursors
                if (!head || newItem.counter > parseInt(head.substring(2), 10)) {
                    head = newItem.cursor;
                }
                if (!tail || newItem.counter < parseInt(tail.substring(2), 10)) {
                    tail = newItem.cursor;
                }
            });

            // Sort by counter (desc - newest first)
            updatedItems.sort((a, b) => b.counter - a.counter);

            return {
                ...state,
                feedItems: updatedItems,
                feedHead: head,
                feedTail: tail,
                feedLoaded: true  // Mark as loaded after first fetch
            };
        }),
        clearFeed: () => set((state) => ({
            ...state,
            feedItems: [],
            feedHead: null,
            feedTail: null,
            feedHasMore: false,
            feedLoaded: false,  // Reset loading flag
            friendsLoaded: false  // Reset loading flag
        })),
    }
});

export function useSessions() {
    return storage(useShallow((state) => state.isDataReady ? state.sessionsData : null));
}

export function useSession(id: string): Session | null {
    return storage(useShallow((state) => state.sessions[id] ?? null));
}

const emptyArray: unknown[] = [];

export function useSessionMessages(sessionId: string): { messages: Message[], isLoaded: boolean, hasOlder: boolean, hasNewer: boolean, isLoadingOlder: boolean, isLoadingLatest: boolean, cachedEventCount: number } {
    return storage(useShallow((state) => {
        const session = state.sessionMessages[sessionId];
        return {
            messages: session?.messages ?? emptyArray,
            isLoaded: session?.isLoaded ?? false,
            hasOlder: session?.hasOlder ?? false,
            hasNewer: session?.hasNewer ?? false,
            isLoadingOlder: session?.isLoadingOlder ?? false,
            isLoadingLatest: session?.isLoadingLatest ?? false,
            cachedEventCount: session?.cachedEventCount ?? 0,
        };
    }));
}

export function useConversationSessionIds(sessionId: string): string[] {
    return storage(useShallow((state) => {
        const current = state.sessions[sessionId];
        if (!current) return [sessionId];
        return conversationHistoryOrder(sessionId, Object.values(state.sessions)
            .filter((candidate) => isSameConversation(current, candidate)))
            .map((candidate) => candidate.id);
    }));
}

export function messageSignature(message: Message): string {
    if (message.kind === 'user-text' && message.meta?.codexInputId) return `input:${message.meta.codexInputId}`;
    if (message.kind === 'user-text' || message.kind === 'agent-text') {
        return `${message.kind}:${message.createdAt}:${message.text}`;
    }
    if (message.kind === 'agent-media') {
        return `${message.kind}:${message.createdAt}:${message.media.map((item) => item.url).join('|')}`;
    }
    if (message.kind === 'tool-call') {
        return `${message.kind}:${message.createdAt}:${message.tool.name}:${JSON.stringify(message.tool.input)}`;
    }
    return `${message.kind}:${message.createdAt}:${JSON.stringify(message.event)}`;
}

export function useConversationMessages(sessionId: string): ReturnType<typeof useSessionMessages> & { sessionIds: string[] } {
    const snapshot = storage(useShallow((state) => ({
        sessions: state.sessions,
        sessionMessages: state.sessionMessages,
        view: state.sessionViewStates[sessionId],
    })));
    return React.useMemo(() => {
        const current = snapshot.sessions[sessionId];
        const related = current
            ? Object.values(snapshot.sessions).filter((candidate) => isSameConversation(current, candidate))
            : [];
        if (related.length === 0) {
            const page = snapshot.sessionMessages[sessionId];
            return {
                sessionIds: [sessionId],
                messages: page?.messages ?? emptyArray as Message[],
                isLoaded: page?.isLoaded ?? false,
                hasOlder: page?.hasOlder ?? false,
                hasNewer: page?.hasNewer ?? false,
                isLoadingOlder: page?.isLoadingOlder ?? false,
                isLoadingLatest: page?.isLoadingLatest ?? false,
                cachedEventCount: page?.cachedEventCount ?? 0,
            };
        }

        const sessionIds = conversationHistoryOrder(sessionId, related).map((item) => item.id);
        const pages = sessionIds.map((id) => snapshot.sessionMessages[id]);
        const unique = new Map<string, Message>();
        for (const page of pages) {
            for (const message of page?.messages ?? []) {
                unique.set(messageSignature(message), message);
            }
        }
        const allMessages = Array.from(unique.values()).sort((left, right) => right.createdAt - left.createdAt);
        const browsingOlderRuntime = snapshot.view?.historyDirection === 'oldest';
        const messages = browsingOlderRuntime ? allMessages.slice(-MAX_ACTIVE_MESSAGE_EVENTS) : allMessages.slice(0, MAX_ACTIVE_MESSAGE_EVENTS);
        const combinedWindowTrimmed = allMessages.length > messages.length;
        return {
            sessionIds,
            messages,
            isLoaded: pages.some((page) => page?.isLoaded),
            hasOlder: (!browsingOlderRuntime && combinedWindowTrimmed) || pages.some((page) => page?.hasOlder)
                || sessionIds.reduce((last, id, index) => snapshot.sessionMessages[id] !== undefined ? index : last, -1) < sessionIds.length - 1,
            hasNewer: (browsingOlderRuntime && combinedWindowTrimmed) || pages.some((page) => page?.hasNewer) || (pages.some(Boolean) && !pages[0]),
            isLoadingOlder: pages.some((page) => page?.isLoadingOlder),
            isLoadingLatest: !!snapshot.view?.historyLoading || pages.some((page) => page?.isLoadingLatest),
            cachedEventCount: pages.reduce((total, page) => total + (page?.cachedEventCount ?? 0), 0),
        };
    }, [sessionId, snapshot.sessionMessages, snapshot.sessions, snapshot.view]);
}

export function useMessage(sessionId: string, messageId: string): Message | null {
    return storage(useShallow((state) => {
        const session = state.sessionMessages[sessionId];
        return session?.messagesMap[messageId] ?? null;
    }));
}

export function useSessionUsage(sessionId: string) {
    return storage(useShallow((state) => {
        const session = state.sessionMessages[sessionId];
        return session?.reducerState?.latestUsage ?? null;
    }));
}

export function useSettings(): Settings {
    return storage(useShallow((state) => state.settings));
}

export function useSettingMutable<K extends keyof Settings>(name: K): [Settings[K], (value: Settings[K]) => void] {
    const setValue = React.useCallback((value: Settings[K]) => {
        sync.applySettings({ [name]: value });
    }, [name]);
    const value = useSetting(name);
    return [value, setValue];
}

export function useSetting<K extends keyof Settings>(name: K): Settings[K] {
    return storage(useShallow((state) => state.settings[name]));
}

export function useLocalSettings(): LocalSettings {
    return storage(useShallow((state) => state.localSettings));
}

export function useAllMachines(options?: { includeOffline?: boolean }): Machine[] {
    const includeOffline = options?.includeOffline ?? false;
    return storage(useShallow((state) => {
        if (!state.isDataReady) return [];
        const machines = Object.values(state.machines).sort((a, b) => b.createdAt - a.createdAt);
        return includeOffline ? machines : machines.filter((v) => v.active);
    }));
}

export function useMachine(machineId: string): Machine | null {
    return storage(useShallow((state) => state.machines[machineId] ?? null));
}

export function useSessionListViewData(): SessionListViewItem[] | null {
    return storage(useDeepEqual((state) => state.isDataReady ? state.sessionListViewData : null));
}

export function useAllSessions(): Session[] {
    return storage(useShallow((state) => {
        if (!state.isDataReady) return [];
        return Object.values(state.sessions).sort(compareSessionQuestions);
    }));
}

export function useLocalSettingMutable<K extends keyof LocalSettings>(name: K): [LocalSettings[K], (value: LocalSettings[K]) => void] {
    const setValue = React.useCallback((value: LocalSettings[K]) => {
        storage.getState().applyLocalSettings({ [name]: value });
    }, [name]);
    const value = useLocalSetting(name);
    return [value, setValue];
}

// Project management hooks
export function useProjects() {
    return storage(useShallow((state) => state.getProjects()));
}

export function useProject(projectId: string | null) {
    return storage(useShallow((state) => projectId ? state.getProject(projectId) : null));
}

export function useProjectForSession(sessionId: string | null) {
    return storage(useShallow((state) => sessionId ? state.getProjectForSession(sessionId) : null));
}

export function useProjectSessions(projectId: string | null) {
    return storage(useShallow((state) => projectId ? state.getProjectSessions(projectId) : []));
}

export function useProjectGitStatus(projectId: string | null) {
    return storage(useShallow((state) => projectId ? state.getProjectGitStatus(projectId) : null));
}

export function useSessionProjectGitStatus(sessionId: string | null) {
    return storage(useShallow((state) => sessionId ? state.getSessionProjectGitStatus(sessionId) : null));
}

export function useLocalSetting<K extends keyof LocalSettings>(name: K): LocalSettings[K] {
    return storage(useShallow((state) => state.localSettings[name]));
}

// Artifact hooks
export function useArtifacts(): DecryptedArtifact[] {
    return storage(useShallow((state) => {
        if (!state.isDataReady) return [];
        // Filter out draft artifacts from the main list
        return Object.values(state.artifacts)
            .filter(artifact => !artifact.draft)
            .sort((a, b) => b.updatedAt - a.updatedAt);
    }));
}

export function useAllArtifacts(): DecryptedArtifact[] {
    return storage(useShallow((state) => {
        if (!state.isDataReady) return [];
        // Return all artifacts including drafts
        return Object.values(state.artifacts).sort((a, b) => b.updatedAt - a.updatedAt);
    }));
}

export function useDraftArtifacts(): DecryptedArtifact[] {
    return storage(useShallow((state) => {
        if (!state.isDataReady) return [];
        // Return only draft artifacts
        return Object.values(state.artifacts)
            .filter(artifact => artifact.draft === true)
            .sort((a, b) => b.updatedAt - a.updatedAt);
    }));
}

export function useArtifact(artifactId: string): DecryptedArtifact | null {
    return storage(useShallow((state) => state.artifacts[artifactId] ?? null));
}

export function useArtifactsCount(): number {
    return storage(useShallow((state) => {
        // Count only non-draft artifacts
        return Object.values(state.artifacts).filter(a => !a.draft).length;
    }));
}

export function useRealtimeStatus(): 'disconnected' | 'connecting' | 'connected' | 'error' {
    return storage(useShallow((state) => state.realtimeStatus));
}

export function useRealtimeMode(): 'idle' | 'agent-speaking' | 'user-speaking' {
    return storage(useShallow((state) => state.realtimeMode));
}

export function useSocketStatus() {
    return storage(useShallow((state) => ({
        status: state.socketStatus,
        lastConnectedAt: state.socketLastConnectedAt,
        lastDisconnectedAt: state.socketLastDisconnectedAt
    })));
}

export function useSessionStream(sessionId: string): SessionStream | null {
    return storage(useShallow((state) => Object.values(state.sessionStreams[sessionId]?.pending ?? {})
        .filter((stream) => stream.kind !== 'tool-output')
        .sort((a, b) => b.updatedAt - a.updatedAt)[0] ?? null));
}

export function useSessionGitStatus(sessionId: string): GitStatus | null {
    return storage(useShallow((state) => state.sessionGitStatus[sessionId] ?? null));
}

export function useSessionGitStatusFiles(sessionId: string): GitStatusFiles | null {
    return storage(useShallow((state) => state.sessionGitStatusFiles[sessionId] ?? null));
}

export function useSessionFileCache(sessionId: string, filePath: string) {
    return storage(useShallow((state) => state.sessionFileCache[sessionId]?.[filePath] ?? null));
}

export function useIsDataReady(): boolean {
    return storage(useShallow((state) => state.isDataReady));
}

export function useProfile() {
    return storage(useShallow((state) => state.profile));
}

export function useFriends() {
    return storage(useShallow((state) => state.friends));
}

export function useFriendRequests() {
    return storage(useShallow((state) => {
        // Filter friends to get pending requests (where status is 'pending')
        return Object.values(state.friends).filter(friend => friend.status === 'pending');
    }));
}

export function useAcceptedFriends() {
    return storage(useShallow((state) => {
        return Object.values(state.friends).filter(friend => friend.status === 'friend');
    }));
}

export function useFeedItems() {
    return storage(useShallow((state) => state.feedItems));
}
export function useFeedLoaded() {
    return storage((state) => state.feedLoaded);
}
export function useFriendsLoaded() {
    return storage((state) => state.friendsLoaded);
}

export function useFriend(userId: string | undefined) {
    return storage(useShallow((state) => userId ? state.friends[userId] : undefined));
}

export function useUser(userId: string | undefined) {
    return storage(useShallow((state) => userId ? state.users[userId] : undefined));
}

export function useRequestedFriends() {
    return storage(useShallow((state) => {
        // Filter friends to get sent requests (where status is 'requested')
        return Object.values(state.friends).filter(friend => friend.status === 'requested');
    }));
}
