import Constants from 'expo-constants';
import { apiSocket, getHaplaClientId } from '@/sync/apiSocket';
import { AuthCredentials } from '@/auth/tokenStorage';
import { ensureMediaAccess } from '@/auth/mediaAccess';
import { Encryption } from '@/sync/encryption/encryption';
import { decodeBase64, encodeBase64 } from '@/encryption/base64';
import { storage } from './storage';
import { ApiEphemeralUpdateSchema, ApiMessage, ApiUpdateContainerSchema } from './apiTypes';
import type { ApiEphemeralActivityUpdate } from './apiTypes';
import { Session, Machine } from './storageTypes';
import { InvalidateSync } from '@/utils/sync';
import { ActivityUpdateAccumulator } from './reducer/activityUpdateAccumulator';
import * as Notifications from './notifications';
import { Platform, AppState, type AppStateStatus } from 'react-native';
import { isRunningOnMac } from '@/utils/platform';
import { randomId } from '@/utils/randomId';
import { NormalizedMessage, normalizeRawMessage, RawRecord } from './typesRaw';
import { applySettings, Settings, settingsDefaults, settingsParse, SUPPORTED_SCHEMA_VERSION } from './settings';
import { Profile, profileParse } from './profile';
import { loadPendingSettings, savePendingSettings } from './persistence';
import { parseToken } from '@/utils/parseToken';
import { getServerUrl } from './serverConfig';
import { config } from '@/config';
import { log } from '@/log';
import { gitStatusSync } from './gitStatusSync';
import { projectManager } from './projectManager';
import { AsyncLock } from '@/utils/lock';
import { EncryptionCache } from './encryption/encryptionCache';
import type { SessionEncryption } from './encryption/sessionEncryption';
import { systemPrompt } from './prompt/systemPrompt';
import { fetchArtifact, fetchArtifacts, createArtifact, updateArtifact } from './apiArtifacts';
import { DecryptedArtifact, Artifact, ArtifactCreateRequest, ArtifactUpdateRequest } from './artifactTypes';
import { ArtifactEncryption } from './encryption/artifactEncryption';
import { uploadChatImages } from './apiUploads';
import { FeedItem } from './feedTypes';
import { UserProfile } from './friendTypes';
import { resolveMessageModeMeta, resolveMessageCodexPreferenceMeta } from './messageMeta';
import { getConversationRuntimeIds, type ConversationSessionRef } from './conversationSessions';
import { SessionRequestEpochs } from './sessionRequestEpoch';
import { sessionResources } from './sessionResources';
import { SessionStreamBatcher } from './sessionStreamBatcher';
import { advanceConversationHistoryCursor, historyPagePath, initialHistorySession, loadConversationHistoryWindow, LATEST_HISTORY_CURSOR, olderHistorySession, type ConversationHistoryCursor } from './sessionHistory';
import { SessionQuestionBackfill } from './sessionQuestionBackfill';
import { forEachSessionIndexPage } from './sessionIndexPages';

type V3GetSessionMessagesResponse = {
    messages: ApiMessage[];
    hasMore: boolean;
    direction?: 'forward' | 'backward';
};

type V3PostSessionMessagesResponse = {
    messages: Array<{
        id: string;
        seq: number;
        localId: string | null;
        createdAt: number;
        updatedAt: number;
    }>;
};

type OutboxMessage = {
    localId: string;
    content: string;
};

type SendMessageOptions = {
    displayText?: string;
    source?: 'chat' | 'new_session' | 'option' | 'question';
    images?: Array<{ data: string; mediaType: string; previewData?: string }>;
    branchId?: string;
    asyncQuestionResponse?: { id: string; answers: string[] };
};

class Sync {
    private static readonly BACKGROUND_SEND_TIMEOUT_MS = 30_000;
    encryption!: Encryption;
    serverID!: string;
    anonID!: string;
    private credentials!: AuthCredentials;
    public encryptionCache = new EncryptionCache();
    private sessionsSync: InvalidateSync;
    private messagesSync = new Map<string, InvalidateSync>();
    private sendSync = new Map<string, InvalidateSync>();
    private sendAbortControllers = new Map<string, AbortController>();
    private sessionLastSeq = new Map<string, number>();
    private sessionOldestSeq = new Map<string, number>();
    private pendingOutbox = new Map<string, OutboxMessage[]>();
    private sessionMessageQueue = new Map<string, NormalizedMessage[]>();
    private sessionQueueProcessing = new Set<string>();
    private sessionMessageLocks = new Map<string, AsyncLock>();
    private sessionRequestEpochs = new SessionRequestEpochs();
    private conversationHistoryEpochs = new SessionRequestEpochs();
    private visibleSessions = new Map<string, number>();
    private registeredSessionResources = new Set<string>();
    private streamBatcher = new SessionStreamBatcher((id, stream) => storage.getState().applySessionStream(id, stream),
        () => typeof document !== 'undefined' && document.hidden ? 250 : 50);
    private sessionDataKeys = new Map<string, Uint8Array>(); // Store session data encryption keys internally
    private machineDataKeys = new Map<string, Uint8Array>(); // Store machine data encryption keys internally
    private artifactDataKeys = new Map<string, Uint8Array>(); // Store artifact data encryption keys internally
    private settingsSync: InvalidateSync;
    private profileSync: InvalidateSync;
    private machinesSync: InvalidateSync;
    private nativeUpdateSync: InvalidateSync;
    private artifactsSync: InvalidateSync;
    private activityAccumulator: ActivityUpdateAccumulator;
    private pendingSettings: Partial<Settings> = loadPendingSettings();
    private appState: AppStateStatus = AppState.currentState;
    private backgroundSendTimeout: ReturnType<typeof setTimeout> | null = null;
    private backgroundSendNotificationId: string | null = null;
    private backgroundSendStartedAt: number | null = null;
    private questionBackfill = new SessionQuestionBackfill({
        fetchPage: async (sessionId, before, limit, signal) => {
            const response = await apiSocket.request(`/v3/sessions/${encodeURIComponent(sessionId)}/messages?before_seq=${before}&limit=${limit}`, { signal });
            if (!response.ok) throw new Error(`Question history request failed: ${response.status}`);
            return await response.json() as V3GetSessionMessagesResponse;
        },
        decrypt: async (sessionId, message) => {
            const encryption = this.encryption.getSessionEncryption(sessionId);
            if (!encryption || message.content.t !== 'encrypted') return null;
            return encryption.decryptRaw(message.content.c);
        },
        save: async (sessionId, result, signal) => {
            const response = await apiSocket.request(`/v1/sessions/${encodeURIComponent(sessionId)}/last-user-message`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(result), signal,
            });
            if (!response.ok) throw new Error(`Question history index failed: ${response.status}`);
            const index = await response.json() as { lastUserMessageAt: number | null; lastUserMessageIndexedSeq: number };
            if (signal.aborted) return;
            const session = storage.getState().sessions[sessionId];
            if (session) this.applySessions([{ ...session, ...index }]);
        },
        isCurrent: task => Boolean(storage.getState().sessions[task.id] && this.encryption?.getSessionEncryption(task.id)),
    });
    // Generic locking mechanism
    private recalculationLockCount = 0;
    private lastRecalculationTime = 0;

    constructor() {
        this.sessionsSync = new InvalidateSync(this.fetchSessions);
        this.settingsSync = new InvalidateSync(this.syncSettings);
        this.profileSync = new InvalidateSync(this.fetchProfile);
        this.machinesSync = new InvalidateSync(this.fetchMachines);
        this.nativeUpdateSync = new InvalidateSync(this.fetchNativeUpdate);
        this.artifactsSync = new InvalidateSync(this.fetchArtifactsList);

        this.activityAccumulator = new ActivityUpdateAccumulator(this.flushActivityUpdates.bind(this), 2000);

        AppState.addEventListener('change', (nextAppState) => {
            this.appState = nextAppState;
            if (nextAppState === 'active') {
                const shouldFailAfterResume = this.backgroundSendStartedAt !== null
                    && this.hasPendingOutboxMessages()
                    && (Date.now() - this.backgroundSendStartedAt) >= Sync.BACKGROUND_SEND_TIMEOUT_MS;
                void this.cancelBackgroundSendTimeoutNotification();
                this.clearBackgroundSendWatchdog();
                if (shouldFailAfterResume) {
                    void this.notifyMessageSendFailed();
                    this.failPendingOutboxMessages('Message failed to send in background after 30s. Please retry.');
                }
                log.log('📱 App became active');
                this.profileSync.invalidate();
                this.machinesSync.invalidate();
                this.sessionsSync.invalidate();
                this.nativeUpdateSync.invalidate();
                log.log('📱 App became active: Invalidating artifacts sync');
                this.artifactsSync.invalidate();
            } else {
                log.log(`📱 App state changed to: ${nextAppState}`);
                this.maybeStartBackgroundSendWatchdog();
            }
        });
    }

    async create(credentials: AuthCredentials, encryption: Encryption) {
        this.credentials = credentials;
        this.encryption = encryption;
        this.anonID = encryption.anonID;
        this.serverID = parseToken(credentials.token);
        await this.#init();

        // Await settings sync to have fresh settings
        await this.settingsSync.awaitQueue();

        // Await profile sync to have fresh profile
        await this.profileSync.awaitQueue();

    }

    stopQuestionBackfill(): void { this.questionBackfill.stop(); }

    async restore(credentials: AuthCredentials, encryption: Encryption) {
        // NOTE: No awaiting anything here, we're restoring from a disk (ie app restarted)
        this.credentials = credentials;
        this.encryption = encryption;
        this.anonID = encryption.anonID;
        this.serverID = parseToken(credentials.token);
        await this.#init();
    }

    async #init() {

        // Subscribe to updates
        this.subscribeToUpdates();

        // Invalidate sync
        log.log('🔄 #init: Invalidating all syncs');
        this.sessionsSync.invalidate();
        this.settingsSync.invalidate();
        this.profileSync.invalidate();
        this.machinesSync.invalidate();
        this.nativeUpdateSync.invalidate();
        this.artifactsSync.invalidate();
        log.log('🔄 #init: All syncs invalidated, including artifacts');

        // Wait for both sessions and machines to load, then mark as ready
        Promise.all([
            this.sessionsSync.awaitQueue(),
            this.machinesSync.awaitQueue()
        ]).then(() => {
            storage.getState().applyReady();
        }).catch((error) => {
            console.error('Failed to load initial data:', error);
        });
    }


    onSessionVisible = (sessionId: string) => {
        if (!this.visibleSessions.has(sessionId)) return;
        this.getMessagesSync(sessionId).invalidate();
    }

    retainVisibleSessions = (sessionIds: string[], viewSessionId = sessionIds[0]): (() => void) => {
        const ids = [...new Set(sessionIds)];
        if (!ids.length || !ids.includes(viewSessionId)) return () => {};
        for (const id of ids) {
            this.visibleSessions.set(id, (this.visibleSessions.get(id) ?? 0) + 1);
        }
        const state = storage.getState();
        const anchor = state.sessionViewStates[viewSessionId]?.anchor;
        const restoring = !!anchor && anchor.offset > 0 && Number.isSafeInteger(anchor.seq)
            && ids.includes(anchor.sourceSessionId ?? viewSessionId)
            && (anchor.branchId ?? 'main') === (state.sessions[viewSessionId]?.metadata?.activeCodexBranchId ?? 'main');
        const target = initialHistorySession(ids, restoring ? state.sessionViewStates : {}, viewSessionId)!;
        this.conversationHistoryEpochs.invalidate(viewSessionId);
        const epochCurrent = this.conversationHistoryEpochs.capture(viewSessionId);
        const encryption = this.encryption;
        let released = false;
        const isCurrent = () => !released && epochCurrent() && this.encryption === encryption && this.visibleSessions.has(viewSessionId);
        state.setSessionHistoryState(viewSessionId, { historyDirection: restoring ? 'oldest' : 'newest', historyLoading: true });
        for (const id of ids) {
            if (id === target || id === viewSessionId) {
                // The visible route still owns live controls/streams, even
                // when a different runtime owns the latest saved question.
                this.ensureSessionResources(id);
            } else if (!state.sessionMessages[id]) storage.getState().unloadSessionResources(id);
        }
        if (restoring && anchor) storage.getState().saveSessionScrollAnchor(target, anchor);
        void loadConversationHistoryWindow(restoring ? [target] : ids, async id => {
            this.ensureSessionResources(id);
            const page = storage.getState().sessionMessages[id];
            const saved = storage.getState().sessionViewStates[id]?.anchor;
            if (!restoring && (page?.hasNewer || (saved?.offset ?? 0) > 0)) {
                await this.returnToLatestMessages(id);
            } else {
                this.onSessionVisible(id);
                await this.getMessagesSync(id).awaitQueue();
            }
            const loaded = storage.getState().sessionMessages[id];
            return { count: loaded?.cachedEventCount ?? 0, hasOlder: loaded?.hasOlder ?? false };
        }, isCurrent).catch(error => {
            if (isCurrent()) console.warn('Failed to load conversation history window', error);
        }).finally(() => {
            if (isCurrent()) storage.getState().setSessionHistoryState(viewSessionId, { historyLoading: false });
        });
        this.sessionsSync.invalidate(); // Restore full pending request arguments for the visible session.
        return () => {
            if (released) return;
            released = true;
            if (epochCurrent()) {
                this.conversationHistoryEpochs.invalidate(viewSessionId);
                storage.getState().setSessionHistoryState(viewSessionId, { historyLoading: false });
            }
            for (const id of ids) {
                const count = (this.visibleSessions.get(id) ?? 1) - 1;
                if (count > 0) this.visibleSessions.set(id, count);
                else {
                    this.visibleSessions.delete(id);
                    // Focus can transfer between the chat and its message detail in one commit.
                    queueMicrotask(() => { if (!this.visibleSessions.has(id)) storage.getState().unloadSessionResources(id); });
                }
            }
        };
    }

    private ensureSessionResources(sessionId: string): void {
        storage.getState().touchSessionResources(sessionId);
        if (this.registeredSessionResources.has(sessionId)) return;
        this.registeredSessionResources.add(sessionId);
        sessionResources.register(sessionId, () => {
            this.registeredSessionResources.delete(sessionId);
            this.sessionRequestEpochs.invalidate(sessionId);
            this.messagesSync.get(sessionId)?.stop();
            this.messagesSync.delete(sessionId);
            this.sessionMessageQueue.delete(sessionId);
            this.streamBatcher.clear(sessionId);
            this.sessionLastSeq.delete(sessionId);
            this.sessionOldestSeq.delete(sessionId);
            this.sessionMessageLocks.delete(sessionId);
            this.encryption?.clearSessionCache(sessionId);
            this.encryptionCache.clearSessionCache(sessionId);
            gitStatusSync.stop(sessionId);
        });
    }

    private async fetchMessagePage(sessionId: string, path: string): Promise<V3GetSessionMessagesResponse> {
        const controller = new AbortController();
        const unregister = sessionResources.register(sessionId, () => controller.abort());
        try {
            const response = await apiSocket.request(path, { signal: controller.signal });
            if (!response.ok) throw new Error(`Failed to fetch messages for ${sessionId}: ${response.status}`);
            return await response.json() as V3GetSessionMessagesResponse;
        } finally { unregister(); }
    }

    loadOlderMessages = async (sessionId: string) => {
        if (!this.visibleSessions.has(sessionId)) return;
        this.ensureSessionResources(sessionId);
        const pageState = storage.getState().sessionMessages[sessionId];
        if (!pageState) { await this.fetchMessages(sessionId); return; }
        if (!pageState.hasOlder || pageState.isLoadingOlder) return;
        storage.getState().applyMessagePageState(sessionId, { isLoadingOlder: true });
        const isCurrent = this.captureSessionRequest(sessionId);
        const lock = this.getSessionMessageLock(sessionId);
        try {
            await lock.inLock(async () => {
                if (!isCurrent()) return;
                const encryption = this.encryption.getSessionEncryption(sessionId);
                if (!encryption) throw new Error(`Session encryption not ready for ${sessionId}`);
                const beforeSeq = this.sessionOldestSeq.get(sessionId);
                if (beforeSeq === undefined) return;
                const data = await this.fetchMessagePage(sessionId, historyPagePath(sessionId, { before: beforeSeq }));
                const normalizedMessages = await this.normalizeApiMessages(encryption, data.messages);
                if (!isCurrent()) return;
                if (normalizedMessages.length > 0) {
                    this.applyMessages(sessionId, normalizedMessages, { rebuild: true, keep: 'oldest' });
                }
                const oldest = data.messages.reduce((value, message) => Math.min(value, message.seq), beforeSeq);
                this.sessionOldestSeq.set(sessionId, oldest);
                storage.getState().applyMessagePageState(sessionId, { hasOlder: data.hasMore });
            });
        } catch (error) {
            if (isCurrent()) throw error;
        } finally {
            if (isCurrent()) storage.getState().applyMessagePageState(sessionId, { isLoadingOlder: false });
        }
    }

    returnToLatestMessages = async (sessionId: string) => {
        if (!this.visibleSessions.has(sessionId)) return;
        this.ensureSessionResources(sessionId);
        storage.getState().saveSessionScrollAnchor(sessionId, { offset: 0 });
        const pageState = storage.getState().sessionMessages[sessionId];
        if (pageState?.isLoadingLatest) return;
        this.sessionRequestEpochs.invalidate(sessionId);
        this.sessionMessageQueue.delete(sessionId);
        const isCurrent = this.captureSessionRequest(sessionId);
        storage.getState().applyMessagePageState(sessionId, { isLoadingLatest: true, isLoadingOlder: false });
        try {
            this.sessionLastSeq.delete(sessionId);
            this.sessionOldestSeq.delete(sessionId);
            // Keep the current window visible until its replacement has been decrypted.
            await this.fetchMessages(sessionId, true);
        } catch (error) {
            if (isCurrent()) throw error;
        } finally {
            if (isCurrent()) storage.getState().applyMessagePageState(sessionId, { isLoadingLatest: false });
        }
    }

    /** Scan visible history without moving the live raw window or its cursors. */
    readConversationHistoryPage = async (
        sessionIds: string[],
        cursor?: ConversationHistoryCursor,
    ): Promise<{ sessionId: string; messages: NormalizedMessage[]; next: ConversationHistoryCursor | null }> => {
        const ids = [...sessionIds];
        const cancelled = () => new DOMException('History view changed', 'AbortError');
        if (ids.length === 0 || ids.some(id => typeof id !== 'string' || !id) || new Set(ids).size !== ids.length) throw cancelled();
        if (cursor && (!ids.includes(cursor.sessionId) || !Number.isSafeInteger(cursor.before) || cursor.before <= 0)) throw cancelled();
        if (!this.encryption || !this.visibleSessions.has(ids[0])) throw cancelled();
        const target = cursor?.sessionId ?? olderHistorySession(ids, storage.getState().sessionMessages);
        if (!target) return { sessionId: ids[ids.length - 1], messages: [], next: null };
        if (!this.visibleSessions.has(target) || !this.visibleSessions.has(ids[0])) throw cancelled();
        this.ensureSessionResources(target);
        const retained = this.captureSessionRequest(target);
        const conversationRetained = target === ids[0] ? retained : this.captureSessionRequest(ids[0]);
        const isCurrent = () => retained() && conversationRetained()
            && this.visibleSessions.has(target) && this.visibleSessions.has(ids[0]);
        const encryption = this.encryption?.getSessionEncryption(target);
        if (!encryption || !isCurrent()) throw cancelled();
        const selected = { sessionId: target, before: cursor?.before ?? this.sessionOldestSeq.get(target) ?? LATEST_HISTORY_CURSOR };
        if (!Number.isSafeInteger(selected.before) || selected.before <= 0) throw cancelled();
        try {
            const data = await this.fetchMessagePage(target, historyPagePath(target, { before: selected.before }));
            if (!isCurrent()) throw cancelled();
            if (!Array.isArray(data.messages) || typeof data.hasMore !== 'boolean') throw new Error('历史记录返回了无效页面，请重试');
            const next = advanceConversationHistoryCursor(ids, selected, data.messages.map(message => message?.seq), data.hasMore);
            const messages = await this.normalizeApiMessages(encryption, data.messages);
            if (!isCurrent()) throw cancelled();
            return { sessionId: target, messages, next };
        } catch (problem) {
            if (!isCurrent()) throw cancelled();
            throw problem;
        }
    }

    loadOlderConversationMessages = async (sessionIds: string[], viewSessionId = sessionIds[0], direction: 'oldest' | 'newest' = 'oldest') => {
        const target = olderHistorySession(sessionIds, storage.getState().sessionMessages);
        if (!target || !this.visibleSessions.has(target)) return false;
        storage.getState().setSessionHistoryState(viewSessionId, { historyDirection: direction });
        const before = this.sessionOldestSeq.get(target);
        await this.loadOlderMessages(target);
        if (!storage.getState().sessionMessages[target]?.isLoaded) return false;
        // Keep the adjacent page as the visible boundary anchor. Older runtimes
        // are opened only on demand and share the same global byte LRU budget.
        storage.getState().enforceSessionCacheBudget(target);
        // A server repeating a cursor must not turn viewport filling into a
        // request loop. Unsupported events still count if the raw cursor moved.
        return this.sessionOldestSeq.get(target) !== before
            || !storage.getState().sessionMessages[target]?.hasOlder;
    }

    returnToLatestConversationMessages = async (sessionIds: string[], viewSessionId = sessionIds[0]) => {
        const target = sessionIds[0];
        if (!target || !this.visibleSessions.has(viewSessionId)) return;
        this.conversationHistoryEpochs.invalidate(viewSessionId);
        const epochCurrent = this.conversationHistoryEpochs.capture(viewSessionId);
        const encryption = this.encryption;
        const isCurrent = () => epochCurrent() && this.encryption === encryption && this.visibleSessions.has(viewSessionId);
        storage.getState().saveSessionScrollAnchor(viewSessionId, { offset: 0 });
        storage.getState().setSessionHistoryState(viewSessionId, { historyDirection: 'newest', historyLoading: true });
        try {
            const loaded = await loadConversationHistoryWindow(sessionIds, async id => {
                await this.returnToLatestMessages(id);
                const page = storage.getState().sessionMessages[id];
                if (!page?.isLoaded) throw new Error('Conversation history view changed');
                return { count: page.cachedEventCount ?? 0, hasOlder: page.hasOlder ?? false };
            }, isCurrent);
            if (!isCurrent() || !loaded.length) return;
            // Keep every page used to fill the latest window, including short
            // failed continuations. They contain acknowledged user messages.
            for (const id of sessionIds) if (!loaded.includes(id) && storage.getState().sessionMessages[id]) storage.getState().unloadSessionResources(id);
            this.ensureSessionResources(viewSessionId);
        } finally {
            if (isCurrent()) storage.getState().setSessionHistoryState(viewSessionId, { historyLoading: false });
        }
    }

    private captureSessionRequest(sessionId: string): () => boolean {
        const isCurrent = this.sessionRequestEpochs.capture(sessionId);
        const resourcesCurrent = sessionResources.capture(sessionId);
        const encryption = this.encryption.getSessionEncryption(sessionId);
        const branchId = storage.getState().sessions[sessionId]?.metadata?.activeCodexBranchId;
        return () => isCurrent() && resourcesCurrent()
            && encryption === this.encryption.getSessionEncryption(sessionId)
            && branchId === storage.getState().sessions[sessionId]?.metadata?.activeCodexBranchId;
    }

    private getMessagesSync(sessionId: string): InvalidateSync {
        let sync = this.messagesSync.get(sessionId);
        if (!sync) {
            sync = new InvalidateSync(() => this.fetchMessages(sessionId));
            this.messagesSync.set(sessionId, sync);
        }
        return sync;
    }

    private getSendSync(sessionId: string): InvalidateSync {
        let sync = this.sendSync.get(sessionId);
        if (!sync) {
            sync = new InvalidateSync(() => this.flushOutbox(sessionId));
            this.sendSync.set(sessionId, sync);
        }
        return sync;
    }

    private enqueueMessages(sessionId: string, messages: NormalizedMessage[]) {
        if (messages.length === 0) {
            return;
        }

        let queue = this.sessionMessageQueue.get(sessionId);
        if (!queue) {
            queue = [];
            this.sessionMessageQueue.set(sessionId, queue);
        }
        queue.push(...messages);

        this.scheduleQueuedMessagesProcessing(sessionId);
    }

    private getSessionMessageLock(sessionId: string): AsyncLock {
        let lock = this.sessionMessageLocks.get(sessionId);
        if (!lock) {
            lock = new AsyncLock();
            this.sessionMessageLocks.set(sessionId, lock);
        }
        return lock;
    }

    private scheduleQueuedMessagesProcessing(sessionId: string) {
        if (this.sessionQueueProcessing.has(sessionId)) {
            return;
        }

        this.sessionQueueProcessing.add(sessionId);
        const isCurrent = this.captureSessionRequest(sessionId);
        const lock = this.getSessionMessageLock(sessionId);
        void lock.inLock(() => {
            if (!isCurrent()) return;
            while (true) {
                const pending = this.sessionMessageQueue.get(sessionId);
                if (!pending || pending.length === 0) {
                    break;
                }
                const batch = pending.splice(0, pending.length);
                this.applyMessages(sessionId, batch);
            }
        }).finally(() => {
            this.sessionQueueProcessing.delete(sessionId);
            const pending = this.sessionMessageQueue.get(sessionId);
            if (pending && pending.length > 0) {
                this.scheduleQueuedMessagesProcessing(sessionId);
            }
        });
    }

    private hasPendingOutboxMessages() {
        if (this.sendAbortControllers.size > 0) {
            return true;
        }
        for (const messages of this.pendingOutbox.values()) {
            if (messages.length > 0) {
                return true;
            }
        }
        return false;
    }

    private maybeStartBackgroundSendWatchdog() {
        if (Platform.OS === 'web' || this.appState === 'active') {
            return;
        }
        if (!this.hasPendingOutboxMessages() || this.backgroundSendTimeout) {
            return;
        }

        log.log('📨 Pending messages detected in background. Starting 30s send watchdog.');
        this.backgroundSendStartedAt = Date.now();
        this.backgroundSendTimeout = setTimeout(() => {
            this.backgroundSendTimeout = null;
            void this.handleBackgroundSendTimeout();
        }, Sync.BACKGROUND_SEND_TIMEOUT_MS);
        void this.scheduleBackgroundSendTimeoutNotification();
    }

    private clearBackgroundSendWatchdog() {
        if (this.backgroundSendTimeout) {
            clearTimeout(this.backgroundSendTimeout);
            this.backgroundSendTimeout = null;
        }
        this.backgroundSendStartedAt = null;
    }

    private async scheduleBackgroundSendTimeoutNotification() {
        if (Platform.OS === 'web' || this.backgroundSendNotificationId) {
            return;
        }
        try {
            this.backgroundSendNotificationId = await Notifications.scheduleNotificationAsync({
                content: {
                    title: 'Message not sent',
                    body: 'A message is still sending in the background. It will fail in 30 seconds if not delivered.',
                    sound: true
                },
                trigger: {
                    type: Notifications.SchedulableTriggerInputTypes.TIME_INTERVAL,
                    seconds: Math.ceil(Sync.BACKGROUND_SEND_TIMEOUT_MS / 1000)
                }
            });
        } catch (error) {
            log.log(`Failed to schedule background send timeout notification: ${error}`);
        }
    }

    private async cancelBackgroundSendTimeoutNotification() {
        if (!this.backgroundSendNotificationId) {
            return;
        }
        try {
            await Notifications.cancelScheduledNotificationAsync(this.backgroundSendNotificationId);
        } catch (error) {
            log.log(`Failed to cancel background send timeout notification: ${error}`);
        } finally {
            this.backgroundSendNotificationId = null;
        }
    }

    private async notifyMessageSendFailed() {
        if (Platform.OS === 'web') {
            return;
        }
        try {
            await Notifications.scheduleNotificationAsync({
                content: {
                    title: 'Message failed',
                    body: 'A message failed to send while the app was in background. Open Hapla and retry.',
                    sound: true
                },
                trigger: null
            });
        } catch (error) {
            log.log(`Failed to schedule message failure notification: ${error}`);
        }
    }

    private failPendingOutboxMessages(reasonText: string) {
        for (const controller of this.sendAbortControllers.values()) {
            controller.abort();
        }
        this.sendAbortControllers.clear();

        const now = Date.now();
        const sessionIds: string[] = [];
        for (const [sessionId, pending] of this.pendingOutbox) {
            if (pending.length === 0) {
                continue;
            }
            pending.length = 0;
            this.pendingOutbox.delete(sessionId);
            sessionIds.push(sessionId);
        }

        for (const sessionId of sessionIds) {
            this.enqueueMessages(sessionId, [{
                id: randomId(),
                localId: null,
                createdAt: now,
                role: 'event',
                isSidechain: false,
                content: {
                    type: 'message',
                    message: reasonText
                }
            }]);
        }
    }

    private async handleBackgroundSendTimeout() {
        if (!this.hasPendingOutboxMessages()) {
            await this.cancelBackgroundSendTimeoutNotification();
            this.backgroundSendStartedAt = null;
            return;
        }

        await this.cancelBackgroundSendTimeoutNotification();
        await this.notifyMessageSendFailed();
        this.failPendingOutboxMessages('Message failed to send in background after 30s. Please retry.');
        this.backgroundSendStartedAt = null;
    }

    async sendMessage(sessionId: string, text: string, options?: SendMessageOptions) {
        if (this.visibleSessions.has(sessionId)) this.ensureSessionResources(sessionId);

        // Get encryption
        const encryption = this.encryption.getSessionEncryption(sessionId);
        if (!encryption) { // Should never happen
            throw new Error(`Session ${sessionId} encryption is not ready`);
        }

        // Get session data from storage
        const session = storage.getState().sessions[sessionId];
        if (!session) {
            throw new Error(`Session ${sessionId} not found in storage`);
        }

        const machine = session.metadata?.machineId ? storage.getState().machines[session.metadata.machineId] : undefined;
        const { permissionMode, model, effort } = resolveMessageModeMeta(session, machine?.metadata);
        const { displayText } = options ?? {};

        // Generate local ID
        const localId = randomId();

        // Determine sentFrom based on platform
        let sentFrom: string;
        if (Platform.OS === 'web') {
            sentFrom = 'web';
        } else if (Platform.OS === 'android') {
            sentFrom = 'android';
        } else if (Platform.OS === 'ios') {
            // Check if running on Mac (Catalyst or Designed for iPad on Mac)
            if (isRunningOnMac()) {
                sentFrom = 'mac';
            } else {
                sentFrom = 'ios';
            }
        } else {
            sentFrom = 'web'; // fallback
        }

        const fallbackModel: string | null = null;

        const { images } = options ?? {};
        const messageMeta = {
            sentFrom,
            permissionMode,
            model,
            effort,
            ...(session.metadata?.flavor === 'codex' ? resolveMessageCodexPreferenceMeta(session, machine?.metadata) : {}),
            fallbackModel,
            appendSystemPrompt: systemPrompt,
            branchId: options?.branchId ?? session.metadata?.activeCodexBranchId,
            ...(options?.asyncQuestionResponse ? { asyncQuestionResponse: options.asyncQuestionResponse } : {}),
            ...(displayText && { displayText })
        };

        // Image payloads can be very large. Avoid mirroring the full base64
        // payload into the local store before the server roundtrip, which can
        // overflow stack/persist/render paths on mobile browsers and native.
        const shouldUseLightweightLocalEcho = !!images?.length;
        const localEchoContent: RawRecord = shouldUseLightweightLocalEcho
            ? {
                role: 'user',
                content: {
                    type: 'multimodal',
                    parts: [
                        ...(images?.map((img) => ({
                            type: 'image' as const,
                            source: {
                                type: 'base64' as const,
                                media_type: img.mediaType,
                                data: img.previewData ?? img.data,
                            },
                        })) ?? []),
                        ...(text.trim() ? [{ type: 'text' as const, text }] : []),
                    ],
                },
                meta: messageMeta,
            }
            : {
                role: 'user',
                content: { type: 'text', text },
                meta: messageMeta,
            };

        // Add to messages - normalize the raw record
        const createdAt = Date.now();
        const normalizedMessage = normalizeRawMessage(localId, localId, createdAt, localEchoContent);
        if (normalizedMessage) {
            this.enqueueMessages(sessionId, [normalizedMessage]);
        }

        let messageContent: any;
        try {
            if (images && images.length > 0) {
                const uploadedImages = Platform.OS === 'web'
                    ? await uploadChatImages(images.map((img) => ({ mediaType: img.mediaType, data: img.data })))
                    : null;
                const parts: any[] = [];

                for (const [index, img] of images.entries()) {
                    const uploadedImage = uploadedImages?.[index];
                    if (uploadedImage) {
                        parts.push({
                            type: 'image',
                            source: {
                                type: 'url',
                                media_type: uploadedImage.mediaType,
                                url: uploadedImage.url,
                            }
                        });
                    } else {
                        parts.push({
                            type: 'image',
                            source: { type: 'base64', media_type: img.mediaType, data: img.data }
                        });
                    }
                }

                if (text.trim()) {
                    parts.push({ type: 'text', text });
                }
                messageContent = { type: 'multimodal', parts };
            } else {
                messageContent = { type: 'text', text };
            }
        } catch (error) {
            console.error('Failed to upload images before sending message', error);
            this.enqueueMessages(sessionId, [{
                id: randomId(),
                localId: null,
                createdAt: Date.now(),
                role: 'event',
                isSidechain: false,
                content: {
                    type: 'message',
                    message: 'Image upload failed. Please retry.'
                }
            }]);
            return;
        }

        const content: RawRecord = {
            role: 'user',
            content: messageContent,
            meta: messageMeta,
        };
        const encryptedRawRecord = await encryption.encryptRawRecord(content);

        let pending = this.pendingOutbox.get(sessionId);
        if (!pending) {
            pending = [];
            this.pendingOutbox.set(sessionId, pending);
        }
        pending.push({
            localId,
            content: encryptedRawRecord
        });
        this.getSendSync(sessionId).invalidate();
        this.maybeStartBackgroundSendWatchdog();
    }

    /** Server sent us settings — merge any pending local changes on top, then apply as one update. */
    private applyServerSettings = (serverSettings: Settings, version: number) => {
        const merged = Object.keys(this.pendingSettings).length > 0
            ? applySettings(serverSettings, this.pendingSettings)
            : serverSettings;
        storage.getState().applySettings(merged, version);
    }

    applySettings = (delta: Partial<Settings>) => {
        storage.getState().applySettingsLocal(delta);

        // Save pending settings
        this.pendingSettings = { ...this.pendingSettings, ...delta };
        savePendingSettings(this.pendingSettings);

        // Invalidate settings sync
        this.settingsSync.invalidate();
    }

    refreshProfile = async () => {
        await this.profileSync.invalidateAndAwait();
    }

    /**
     * Resolve every runtime record belonging to a logical conversation, not
     * merely the recent records currently rendered by the home screen.
     *
     * Only encrypted metadata is paged in. Messages, agent state and media are
     * deliberately excluded, and decrypted metadata is immediately reduced to
     * the small set of identity fields needed for grouping.
     */
    ensureConversationIdentity = async (targetSessionId: string): Promise<{
        conversationId: string;
        runtimeIds: string[];
    }> => {
        if (!this.credentials || !this.encryption) {
            throw new Error('Session encryption is not ready');
        }

        const loadedSessions = Object.values(storage.getState().sessions);
        const loadedTarget = loadedSessions.find((session) => session.id === targetSessionId);
        if (loadedTarget?.conversationId) {
            return {
                conversationId: loadedTarget.conversationId,
                runtimeIds: loadedSessions
                    .filter((session) => session.conversationId === loadedTarget.conversationId)
                    .map((session) => session.id),
            };
        }

        const loadedIds = new Set(loadedSessions.map((session) => session.id));
        const transientEncryptionIds = new Set<string>();
        const refs: ConversationSessionRef[] = [];
        const serverUrl = getServerUrl();
        let cursor: string | null = null;
        let scanned = 0;

        try {
            do {
                const query = new URLSearchParams({ limit: '200' });
                if (cursor) query.set('cursor', cursor);
                const response = await fetch(`${serverUrl}/v1/sessions/deletion-scan?${query.toString()}`, {
                    headers: {
                        'Authorization': `Bearer ${this.credentials.token}`,
                        'Content-Type': 'application/json',
                        'X-Hapla-Client': getHaplaClientId(),
                    },
                });
                if (!response.ok) {
                    throw new Error(`Failed to scan conversation runtimes: ${response.status}`);
                }

                const data = await response.json() as {
                    sessions: Array<{
                        id: string;
                        conversationId: string | null;
                        metadata: string;
                        metadataVersion: number;
                        dataEncryptionKey: string | null;
                    }>;
                    nextCursor: string | null;
                    hasNext: boolean;
                };
                if (!Array.isArray(data.sessions)) {
                    throw new Error('Invalid deletion scan response');
                }

                const keys = new Map<string, Uint8Array | null>();
                for (const session of data.sessions) {
                    if (session.dataEncryptionKey) {
                        const key = await this.encryption.decryptEncryptionKey(session.dataEncryptionKey);
                        if (!key) throw new Error(`Unable to open session key for ${session.id}`);
                        keys.set(session.id, key);
                    } else {
                        keys.set(session.id, null);
                    }
                    if (!loadedIds.has(session.id)) transientEncryptionIds.add(session.id);
                }
                await this.encryption.initializeSessions(keys);

                for (const session of data.sessions) {
                    const sessionEncryption = this.encryption.getSessionEncryption(session.id);
                    if (!sessionEncryption) throw new Error(`Session encryption missing for ${session.id}`);
                    const metadata = await sessionEncryption.decryptMetadata(
                        session.metadataVersion,
                        session.metadata,
                    );
                    if (!metadata) throw new Error(`Unable to decrypt session metadata for ${session.id}`);
                    refs.push({
                        id: session.id,
                        conversationId: session.conversationId,
                        metadata: {
                            conversationRootSessionId: metadata.conversationRootSessionId,
                            continuedFromSessionId: metadata.continuedFromSessionId,
                            codexThreadId: metadata.codexThreadId,
                            claudeSessionId: metadata.claudeSessionId,
                            flavor: metadata.flavor,
                        },
                    });
                }

                scanned += data.sessions.length;
                if (scanned > 20_000) {
                    throw new Error('Deletion scan safety limit exceeded');
                }
                if (data.hasNext && (!data.nextCursor || data.nextCursor === cursor)) {
                    throw new Error('Deletion scan cursor did not advance');
                }
                cursor = data.hasNext ? data.nextCursor : null;
            } while (cursor);

            if (!refs.some((session) => session.id === targetSessionId)) {
                throw new Error('Session is no longer available');
            }
            const runtimeIds = getConversationRuntimeIds(refs, targetSessionId);
            if (runtimeIds.length > 10_000) {
                throw new Error('Conversation contains too many runtime records to delete safely');
            }
            const existingConversationIds = new Set(
                refs
                    .filter((session) => runtimeIds.includes(session.id))
                    .map((session) => session.conversationId)
                    .filter((id): id is string => Boolean(id)),
            );
            if (existingConversationIds.size > 1) {
                throw new Error('Conversation identity conflict');
            }
            const requestedConversationId = existingConversationIds.values().next().value as string | undefined;
            const bindResponse = await fetch(`${serverUrl}/v1/conversations/bind`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${this.credentials.token}`,
                    'Content-Type': 'application/json',
                    'X-Hapla-Client': getHaplaClientId(),
                },
                body: JSON.stringify({
                    sessionIds: runtimeIds,
                    conversationId: requestedConversationId ?? null,
                }),
            });
            if (!bindResponse.ok) {
                throw new Error(`Failed to bind legacy conversation: ${bindResponse.status}`);
            }
            const binding = await bindResponse.json() as { conversationId: string };
            if (!binding.conversationId) throw new Error('Invalid conversation binding response');

            storage.setState((state) => ({
                sessions: Object.fromEntries(Object.entries(state.sessions).map(([id, session]) => [
                    id,
                    runtimeIds.includes(id) ? { ...session, conversationId: binding.conversationId } : session,
                ])),
            }));
            return { conversationId: binding.conversationId, runtimeIds };
        } finally {
            for (const sessionId of transientEncryptionIds) {
                this.encryption.removeSessionEncryption(sessionId);
            }
        }
    }

    /** Compatibility wrapper for older callers and focused tests. */
    resolveConversationRuntimeIdsForDeletion = async (targetSessionId: string): Promise<string[]> => {
        const identity = await this.ensureConversationIdentity(targetSessionId);
        return identity.runtimeIds;
    }

    async assumeUsers(userIds: string[]): Promise<void> {
        if (userIds.length === 0) return;
        
        const state = storage.getState();
        // Filter out users we already have in cache (including null for 404s)
        const missingIds = userIds.filter(id => !(id in state.users));
        
        if (missingIds.length === 0) return;
        
        // Social profile endpoints are not part of the lightweight server. Keep
        // legacy event references cacheable without issuing requests to removed
        // `/v1/user` routes.
        const usersMap: Record<string, UserProfile | null> = Object.fromEntries(
            missingIds.map((id) => [id, null]),
        );
        storage.getState().applyUsers(usersMap);
    }

    //
    // Private
    //

    private fetchSessions = async () => {
        if (!this.credentials) return;
        const isCurrent = this.sessionRequestEpochs.snapshot();
        const requestEncryption = this.encryption;

        const API_ENDPOINT = getServerUrl();
        type RemoteSession = {
            id: string;
            conversationId: string | null;
            tag: string;
            seq: number;
            metadata: string;
            metadataVersion: number;
            agentState: string | null;
            agentStateVersion: number;
            dataEncryptionKey: string | null;
            active: boolean;
            activeAt: number;
            createdAt: number;
            updatedAt: number;
            lastUserMessageAt?: number | null;
            lastUserMessageIndexedSeq?: number;
            lastMessage?: ApiMessage | null;
        };
        let processedCount = 0;
        await forEachSessionIndexPage<RemoteSession>(async (cursor, limit) => {
            if (requestEncryption !== this.encryption) throw new DOMException('Account changed', 'AbortError');
            const response = await fetch(`${API_ENDPOINT}/v2/sessions?limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, {
                headers: {
                    'Authorization': `Bearer ${this.credentials.token}`,
                    'Content-Type': 'application/json',
                    'X-Hapla-Client': getHaplaClientId(),
                },
            });
            if (!response.ok) throw new Error(`Failed to fetch sessions: ${response.status}`);
            return await response.json() as { sessions: RemoteSession[]; hasNext: boolean; nextCursor: string | null };
        }, async sessions => {

            // Initialize all session encryptions first
            const sessionKeys = new Map<string, Uint8Array | null>();
            for (const session of sessions) {
                if (!isCurrent(session.id) || requestEncryption !== this.encryption) continue;
                if (session.dataEncryptionKey) {
                    let decrypted = await this.encryption.decryptEncryptionKey(session.dataEncryptionKey);
                    if (!decrypted) {
                        console.error(`Failed to decrypt data encryption key for session ${session.id}`);
                        continue;
                    }
                    sessionKeys.set(session.id, decrypted);
                } else {
                    sessionKeys.set(session.id, null);
                }
            }
            await this.encryption.initializeSessions(sessionKeys);

            // Decrypt sessions
            let decryptedSessions: (Omit<Session, 'presence'> & { presence?: "online" | number })[] = [];
            for (const session of sessions) {
                if (!isCurrent(session.id) || requestEncryption !== this.encryption) continue;
                // Get session encryption (should always exist after initialization)
                const sessionEncryption = this.encryption.getSessionEncryption(session.id);
                if (!sessionEncryption) {
                    console.error(`Session encryption not found for ${session.id} - this should never happen`);
                    continue;
                }

                // Decrypt metadata using session-specific encryption
                let metadata = await sessionEncryption.decryptMetadata(session.metadataVersion, session.metadata);

                // Decrypt agent state using session-specific encryption
                let agentState = await sessionEncryption.decryptAgentState(session.agentStateVersion, session.agentState);
                if (!isCurrent(session.id) || requestEncryption !== this.encryption) continue;

                // Put it all together
                const processedSession = {
                    ...session,
                    thinking: storage.getState().sessions[session.id]?.thinking ?? false,
                    thinkingAt: storage.getState().sessions[session.id]?.thinkingAt ?? 0,
                    metadata,
                    agentState
                };
                decryptedSessions.push(processedSession);
            }

            // Apply to storage
            this.applySessions(decryptedSessions.filter((session) => isCurrent(session.id) && requestEncryption === this.encryption));
            processedCount += decryptedSessions.length;
        });
        log.log(`📥 fetchSessions completed - processed ${processedCount} sessions`);

    }

    public refreshMachines = async () => {
        return this.fetchMachines();
    }

    public refreshSessions = async () => {
        return this.sessionsSync.invalidateAndAwait();
    }

    public getCredentials() {
        return this.credentials;
    }

    // Artifact methods
    public fetchArtifactsList = async (): Promise<void> => {
        log.log('📦 fetchArtifactsList: Starting artifact sync');
        if (!this.credentials) {
            log.log('📦 fetchArtifactsList: No credentials, skipping');
            return;
        }

        try {
            log.log('📦 fetchArtifactsList: Fetching artifacts from server');
            const artifacts = await fetchArtifacts(this.credentials);
            log.log(`📦 fetchArtifactsList: Received ${artifacts.length} artifacts from server`);
            const decryptedArtifacts: DecryptedArtifact[] = [];

            for (const artifact of artifacts) {
                try {
                    // Decrypt the data encryption key
                    const decryptedKey = await this.encryption.decryptEncryptionKey(artifact.dataEncryptionKey);
                    if (!decryptedKey) {
                        console.error(`Failed to decrypt key for artifact ${artifact.id}`);
                        continue;
                    }

                    // Store the decrypted key in memory
                    this.artifactDataKeys.set(artifact.id, decryptedKey);

                    // Create artifact encryption instance
                    const artifactEncryption = new ArtifactEncryption(decryptedKey);

                    // Decrypt header
                    const header = await artifactEncryption.decryptHeader(artifact.header);
                    
                    decryptedArtifacts.push({
                        id: artifact.id,
                        title: header?.title || null,
                        sessions: header?.sessions,  // Include sessions from header
                        draft: header?.draft,        // Include draft flag from header
                        body: undefined, // Body not loaded in list
                        headerVersion: artifact.headerVersion,
                        bodyVersion: artifact.bodyVersion,
                        seq: artifact.seq,
                        createdAt: artifact.createdAt,
                        updatedAt: artifact.updatedAt,
                        isDecrypted: !!header,
                    });
                } catch (err) {
                    console.error(`Failed to decrypt artifact ${artifact.id}:`, err);
                    // Add with decryption failed flag
                    decryptedArtifacts.push({
                        id: artifact.id,
                        title: null,
                        body: undefined,
                        headerVersion: artifact.headerVersion,
                        seq: artifact.seq,
                        createdAt: artifact.createdAt,
                        updatedAt: artifact.updatedAt,
                        isDecrypted: false,
                    });
                }
            }

            log.log(`📦 fetchArtifactsList: Successfully decrypted ${decryptedArtifacts.length} artifacts`);
            storage.getState().applyArtifacts(decryptedArtifacts);
            log.log('📦 fetchArtifactsList: Artifacts applied to storage');
        } catch (error) {
            log.log(`📦 fetchArtifactsList: Error fetching artifacts: ${error}`);
            console.error('Failed to fetch artifacts:', error);
            throw error;
        }
    }

    public async fetchArtifactWithBody(artifactId: string): Promise<DecryptedArtifact | null> {
        if (!this.credentials) return null;

        try {
            const artifact = await fetchArtifact(this.credentials, artifactId);

            // Decrypt the data encryption key
            const decryptedKey = await this.encryption.decryptEncryptionKey(artifact.dataEncryptionKey);
            if (!decryptedKey) {
                console.error(`Failed to decrypt key for artifact ${artifactId}`);
                return null;
            }

            // Store the decrypted key in memory
            this.artifactDataKeys.set(artifact.id, decryptedKey);

            // Create artifact encryption instance
            const artifactEncryption = new ArtifactEncryption(decryptedKey);

            // Decrypt header and body
            const header = await artifactEncryption.decryptHeader(artifact.header);
            const body = artifact.body ? await artifactEncryption.decryptBody(artifact.body) : null;

            return {
                id: artifact.id,
                title: header?.title || null,
                sessions: header?.sessions,  // Include sessions from header
                draft: header?.draft,        // Include draft flag from header
                body: body?.body || null,
                headerVersion: artifact.headerVersion,
                bodyVersion: artifact.bodyVersion,
                seq: artifact.seq,
                createdAt: artifact.createdAt,
                updatedAt: artifact.updatedAt,
                isDecrypted: !!header,
            };
        } catch (error) {
            console.error(`Failed to fetch artifact ${artifactId}:`, error);
            return null;
        }
    }

    public async createArtifact(
        title: string | null, 
        body: string | null,
        sessions?: string[],
        draft?: boolean
    ): Promise<string> {
        if (!this.credentials) {
            throw new Error('Not authenticated');
        }

        try {
            // Generate unique artifact ID
            const artifactId = this.encryption.generateId();

            // Generate data encryption key
            const dataEncryptionKey = ArtifactEncryption.generateDataEncryptionKey();
            
            // Store the decrypted key in memory
            this.artifactDataKeys.set(artifactId, dataEncryptionKey);
            
            // Encrypt the data encryption key with user's key
            const encryptedKey = await this.encryption.encryptEncryptionKey(dataEncryptionKey);
            
            // Create artifact encryption instance
            const artifactEncryption = new ArtifactEncryption(dataEncryptionKey);
            
            // Encrypt header and body
            const encryptedHeader = await artifactEncryption.encryptHeader({ title, sessions, draft });
            const encryptedBody = await artifactEncryption.encryptBody({ body });
            
            // Create the request
            const request: ArtifactCreateRequest = {
                id: artifactId,
                header: encryptedHeader,
                body: encryptedBody,
                dataEncryptionKey: encodeBase64(encryptedKey, 'base64'),
            };
            
            // Send to server
            const artifact = await createArtifact(this.credentials, request);
            
            // Add to local storage
            const decryptedArtifact: DecryptedArtifact = {
                id: artifact.id,
                title,
                sessions,
                draft,
                body,
                headerVersion: artifact.headerVersion,
                bodyVersion: artifact.bodyVersion,
                seq: artifact.seq,
                createdAt: artifact.createdAt,
                updatedAt: artifact.updatedAt,
                isDecrypted: true,
            };
            
            storage.getState().addArtifact(decryptedArtifact);
            
            return artifactId;
        } catch (error) {
            console.error('Failed to create artifact:', error);
            throw error;
        }
    }

    public async updateArtifact(
        artifactId: string, 
        title: string | null, 
        body: string | null,
        sessions?: string[],
        draft?: boolean
    ): Promise<void> {
        if (!this.credentials) {
            throw new Error('Not authenticated');
        }

        try {
            // Get current artifact to get versions and encryption key
            const currentArtifact = storage.getState().artifacts[artifactId];
            if (!currentArtifact) {
                throw new Error('Artifact not found');
            }

            // Get the data encryption key from memory or fetch it
            let dataEncryptionKey = this.artifactDataKeys.get(artifactId);
            
            // Fetch full artifact if we don't have version info or encryption key
            let headerVersion = currentArtifact.headerVersion;
            let bodyVersion = currentArtifact.bodyVersion;
            
            if (headerVersion === undefined || bodyVersion === undefined || !dataEncryptionKey) {
                const fullArtifact = await fetchArtifact(this.credentials, artifactId);
                headerVersion = fullArtifact.headerVersion;
                bodyVersion = fullArtifact.bodyVersion;
                
                // Decrypt and store the data encryption key if we don't have it
                if (!dataEncryptionKey) {
                    const decryptedKey = await this.encryption.decryptEncryptionKey(fullArtifact.dataEncryptionKey);
                    if (!decryptedKey) {
                        throw new Error('Failed to decrypt encryption key');
                    }
                    this.artifactDataKeys.set(artifactId, decryptedKey);
                    dataEncryptionKey = decryptedKey;
                }
            }

            // Create artifact encryption instance
            const artifactEncryption = new ArtifactEncryption(dataEncryptionKey);

            // Prepare update request
            const updateRequest: ArtifactUpdateRequest = {};
            
            // Check if header needs updating (title, sessions, or draft changed)
            if (title !== currentArtifact.title || 
                JSON.stringify(sessions) !== JSON.stringify(currentArtifact.sessions) ||
                draft !== currentArtifact.draft) {
                const encryptedHeader = await artifactEncryption.encryptHeader({ 
                    title, 
                    sessions, 
                    draft 
                });
                updateRequest.header = encryptedHeader;
                updateRequest.expectedHeaderVersion = headerVersion;
            }

            // Only update body if it changed
            if (body !== currentArtifact.body) {
                const encryptedBody = await artifactEncryption.encryptBody({ body });
                updateRequest.body = encryptedBody;
                updateRequest.expectedBodyVersion = bodyVersion;
            }

            // Skip if no changes
            if (Object.keys(updateRequest).length === 0) {
                return;
            }

            // Send update to server
            const response = await updateArtifact(this.credentials, artifactId, updateRequest);
            
            if (!response.success) {
                // Handle version mismatch
                if (response.error === 'version-mismatch') {
                    throw new Error('Artifact was modified by another client. Please refresh and try again.');
                }
                throw new Error('Failed to update artifact');
            }

            // Update local storage
            const updatedArtifact: DecryptedArtifact = {
                ...currentArtifact,
                title,
                sessions,
                draft,
                body,
                headerVersion: response.headerVersion !== undefined ? response.headerVersion : headerVersion,
                bodyVersion: response.bodyVersion !== undefined ? response.bodyVersion : bodyVersion,
                updatedAt: Date.now(),
            };
            
            storage.getState().updateArtifact(updatedArtifact);
        } catch (error) {
            console.error('Failed to update artifact:', error);
            throw error;
        }
    }

    private fetchMachines = async () => {
        if (!this.credentials) return;

        console.log('📊 Sync: Fetching machines...');
        const API_ENDPOINT = getServerUrl();
        const response = await fetch(`${API_ENDPOINT}/v1/machines`, {
            headers: {
                'Authorization': `Bearer ${this.credentials.token}`,
                'Content-Type': 'application/json',
                'X-Hapla-Client': getHaplaClientId(),
            }
        });

        if (!response.ok) {
            console.error(`Failed to fetch machines: ${response.status}`);
            return;
        }

        const data = await response.json();
        console.log(`📊 Sync: Fetched ${Array.isArray(data) ? data.length : 0} machines from server`);
        const machines = data as Array<{
            id: string;
            metadata: string;
            metadataVersion: number;
            daemonState?: string | null;
            daemonStateVersion?: number;
            dataEncryptionKey?: string | null; // Add support for per-machine encryption keys
            seq: number;
            active: boolean;
            activeAt: number;  // Changed from lastActiveAt
            createdAt: number;
            updatedAt: number;
        }>;

        // First, collect and decrypt encryption keys for all machines
        const machineKeysMap = new Map<string, Uint8Array | null>();
        for (const machine of machines) {
            if (machine.dataEncryptionKey) {
                const decryptedKey = await this.encryption.decryptEncryptionKey(machine.dataEncryptionKey);
                if (!decryptedKey) {
                    console.error(`Failed to decrypt data encryption key for machine ${machine.id}`);
                    continue;
                }
                machineKeysMap.set(machine.id, decryptedKey);
                this.machineDataKeys.set(machine.id, decryptedKey);
            } else {
                machineKeysMap.set(machine.id, null);
            }
        }

        // Initialize machine encryptions
        await this.encryption.initializeMachines(machineKeysMap);

        // Process all machines first, then update state once
        const decryptedMachines: Machine[] = [];

        for (const machine of machines) {
            // Get machine-specific encryption (might exist from previous initialization)
            const machineEncryption = this.encryption.getMachineEncryption(machine.id);
            if (!machineEncryption) {
                console.error(`Machine encryption not found for ${machine.id} - this should never happen`);
                continue;
            }

            try {

                // Use machine-specific encryption (which handles fallback internally)
                const metadata = machine.metadata
                    ? await machineEncryption.decryptMetadata(machine.metadataVersion, machine.metadata)
                    : null;

                const daemonState = machine.daemonState
                    ? await machineEncryption.decryptDaemonState(machine.daemonStateVersion || 0, machine.daemonState)
                    : null;

                decryptedMachines.push({
                    id: machine.id,
                    seq: machine.seq,
                    createdAt: machine.createdAt,
                    updatedAt: machine.updatedAt,
                    active: machine.active,
                    activeAt: machine.activeAt,
                    metadata,
                    metadataVersion: machine.metadataVersion,
                    daemonState,
                    daemonStateVersion: machine.daemonStateVersion || 0
                });
            } catch (error) {
                console.error(`Failed to decrypt machine ${machine.id}:`, error);
                // Still add the machine with null metadata
                decryptedMachines.push({
                    id: machine.id,
                    seq: machine.seq,
                    createdAt: machine.createdAt,
                    updatedAt: machine.updatedAt,
                    active: machine.active,
                    activeAt: machine.activeAt,
                    metadata: null,
                    metadataVersion: machine.metadataVersion,
                    daemonState: null,
                    daemonStateVersion: 0
                });
            }
        }

        // Replace entire machine state with fetched machines
        storage.getState().applyMachines(decryptedMachines, true);
        log.log(`🖥️ fetchMachines completed - processed ${decryptedMachines.length} machines`);
    }

    private syncSettings = async () => {
        if (!this.credentials) return;

        const API_ENDPOINT = getServerUrl();
        const maxRetries = 3;
        let retryCount = 0;

        // Apply pending settings
        if (Object.keys(this.pendingSettings).length > 0) {

            while (retryCount < maxRetries) {
                // Snapshot what we're about to send so we can detect concurrent changes
                const sentPending = { ...this.pendingSettings };
                let version = storage.getState().settingsVersion;
                let settings = applySettings(storage.getState().settings, this.pendingSettings);
                const response = await fetch(`${API_ENDPOINT}/v1/account/settings`, {
                    method: 'POST',
                    body: JSON.stringify({
                        settings: await this.encryption.encryptRaw(settings),
                        expectedVersion: version ?? 0
                    }),
                    headers: {
                        'Authorization': `Bearer ${this.credentials.token}`,
                        'Content-Type': 'application/json',
                        'X-Hapla-Client': getHaplaClientId(),
                    }
                });
                const data = await response.json() as {
                    success: false,
                    error: string,
                    currentVersion: number,
                    currentSettings: string | null
                } | {
                    success: true
                };
                if (data.success) {
                    // Only clear keys we actually sent — preserve any settings
                    // added by applySettings() calls during the POST roundtrip
                    const newPending: Partial<Settings> = {};
                    for (const key of Object.keys(this.pendingSettings) as (keyof Settings)[]) {
                        if (!(key in sentPending) || this.pendingSettings[key] !== sentPending[key]) {
                            (newPending as any)[key] = this.pendingSettings[key];
                        }
                    }
                    this.pendingSettings = newPending;
                    savePendingSettings(this.pendingSettings);
                    break;
                }
                if (data.error === 'version-mismatch') {
                    // Parse server settings
                    const serverSettings = data.currentSettings
                        ? settingsParse(await this.encryption.decryptRaw(data.currentSettings))
                        : { ...settingsDefaults };

                    // Merge: server base + our pending changes (our changes win)
                    const mergedSettings = applySettings(serverSettings, this.pendingSettings);

                    // Update local storage with merged result at server's version
                    this.applyServerSettings(mergedSettings, data.currentVersion);

                    // Log and retry
                    console.log('settings version-mismatch, retrying', {
                        serverVersion: data.currentVersion,
                        retry: retryCount + 1,
                        pendingKeys: Object.keys(this.pendingSettings)
                    });
                    retryCount++;
                    continue;
                } else {
                    throw new Error(`Failed to sync settings: ${data.error}`);
                }
            }
        }

        // If exhausted retries, throw to trigger outer backoff delay
        if (retryCount >= maxRetries) {
            throw new Error(`Settings sync failed after ${maxRetries} retries due to version conflicts`);
        }

        // Run request
        const response = await fetch(`${API_ENDPOINT}/v1/account/settings`, {
            headers: {
                'Authorization': `Bearer ${this.credentials.token}`,
                'Content-Type': 'application/json',
                'X-Hapla-Client': getHaplaClientId(),
            }
        });
        if (!response.ok) {
            throw new Error(`Failed to fetch settings: ${response.status}`);
        }
        const data = await response.json() as {
            settings: string | null,
            settingsVersion: number
        };

        // Parse response
        let parsedSettings: Settings;
        if (data.settings) {
            parsedSettings = settingsParse(await this.encryption.decryptRaw(data.settings));
        } else {
            parsedSettings = { ...settingsDefaults };
        }

        // Log
        console.log('settings', JSON.stringify({
            settings: parsedSettings,
            version: data.settingsVersion
        }));

        // Apply settings to storage, re-layering any pending local changes on top
        this.applyServerSettings(parsedSettings, data.settingsVersion);

    }

    private fetchProfile = async () => {
        if (!this.credentials) return;

        const API_ENDPOINT = getServerUrl();
        const response = await fetch(`${API_ENDPOINT}/v1/account/profile`, {
            headers: {
                'Authorization': `Bearer ${this.credentials.token}`,
                'Content-Type': 'application/json',
                'X-Hapla-Client': getHaplaClientId(),
            }
        });

        if (!response.ok) {
            throw new Error(`Failed to fetch profile: ${response.status}`);
        }

        const data = await response.json();
        const parsedProfile = profileParse(data);

        // Log profile data for debugging
        console.log('profile', JSON.stringify({
            id: parsedProfile.id,
            timestamp: parsedProfile.timestamp,
            firstName: parsedProfile.firstName,
            lastName: parsedProfile.lastName,
            hasAvatar: !!parsedProfile.avatar,
            hasGitHub: !!parsedProfile.github
        }));

        // Apply profile to storage
        storage.getState().applyProfile(parsedProfile);
    }

    private fetchNativeUpdate = async () => {
        try {
            // Skip in development
            if ((Platform.OS !== 'android' && Platform.OS !== 'ios') || !Constants.expoConfig?.version) {
                return;
            }
            if (Platform.OS === 'ios' && !Constants.expoConfig?.ios?.bundleIdentifier) {
                return;
            }
            if (Platform.OS === 'android' && !Constants.expoConfig?.android?.package) {
                return;
            }

            const serverUrl = getServerUrl();

            // Get platform and app identifiers
            const platform = Platform.OS;
            const version = Constants.expoConfig?.version!;
            const appId = (Platform.OS === 'ios' ? Constants.expoConfig?.ios?.bundleIdentifier! : Constants.expoConfig?.android?.package!);

            const response = await fetch(`${serverUrl}/v1/version`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Hapla-Client': getHaplaClientId(),
                },
                body: JSON.stringify({
                    platform,
                    version,
                    app_id: appId,
                }),
            });

            if (!response.ok) {
                console.log(`[fetchNativeUpdate] Request failed: ${response.status}`);
                return;
            }

            const data = await response.json();
            console.log('[fetchNativeUpdate] Data:', data);

            // Apply update status to storage
            if (data.update_required && data.update_url) {
                storage.getState().applyNativeUpdateStatus({
                    available: true,
                    updateUrl: data.update_url
                });
            } else {
                storage.getState().applyNativeUpdateStatus({
                    available: false
                });
            }
        } catch (error) {
            console.log('[fetchNativeUpdate] Error:', error);
            storage.getState().applyNativeUpdateStatus(null);
        }
    }

    private flushOutbox = async (sessionId: string) => {
        const pending = this.pendingOutbox.get(sessionId);
        if (!pending || pending.length === 0) {
            if (!this.hasPendingOutboxMessages()) {
                this.clearBackgroundSendWatchdog();
                await this.cancelBackgroundSendTimeoutNotification();
                this.backgroundSendStartedAt = null;
            }
            return;
        }

        const batch = pending.slice();
        const controller = new AbortController();
        this.sendAbortControllers.set(sessionId, controller);
        const requestBody = JSON.stringify({
            messages: batch.map((message) => ({
                localId: message.localId,
                content: message.content,
                role: 'user',
            }))
        });
        try {
            if (Platform.OS === 'web' && requestBody.length > 2_500_000) {
                console.warn('Large web message payload before upload', {
                    sessionId,
                    pendingCount: batch.length,
                    requestBytes: requestBody.length,
                });
            }
            const response = await apiSocket.request(`/v3/sessions/${sessionId}/messages`, {
                method: 'POST',
                body: requestBody,
                headers: {
                    'Content-Type': 'application/json'
                },
                signal: controller.signal
            });
            if (!response.ok) {
                throw new Error(`Failed to send messages for ${sessionId}: ${response.status}`);
            }

            const data = await response.json() as V3PostSessionMessagesResponse;
            pending.splice(0, batch.length);
            const acknowledgedQuestionAt = data.messages.reduce((latest, message) => Math.max(latest, message.createdAt), 0);
            const session = storage.getState().sessions[sessionId];
            if (session && acknowledgedQuestionAt > 0) this.applySessions([{ ...session, lastUserMessageAt: acknowledgedQuestionAt }]);
            // A send acknowledgement does not prove we have read preceding events.
            // Advancing the read cursor here can permanently skip an assistant reply.
            if (Array.isArray(data.messages) && data.messages.length > 0) this.getMessagesSync(sessionId).invalidate();
        } catch (error) {
            console.error('Failed to flush outbox for session message:', {
                sessionId,
                pendingCount: batch.length,
                error,
            });
            this.maybeStartBackgroundSendWatchdog();
            throw error;
        } finally {
            this.sendAbortControllers.delete(sessionId);
        }

        if (pending.length === 0) {
            this.pendingOutbox.delete(sessionId);
        }
        if (!this.hasPendingOutboxMessages()) {
            this.clearBackgroundSendWatchdog();
            await this.cancelBackgroundSendTimeoutNotification();
            this.backgroundSendStartedAt = null;
        } else if (this.appState !== 'active') {
            this.maybeStartBackgroundSendWatchdog();
        }
    }

    private normalizeApiMessages = async (encryption: SessionEncryption, messages: ApiMessage[]): Promise<NormalizedMessage[]> => {
        const decryptedMessages = await encryption.decryptMessages(messages);
        const normalizedMessages: NormalizedMessage[] = [];
        for (let index = 0; index < decryptedMessages.length; index += 1) {
            const decrypted = decryptedMessages[index];
            if (!decrypted) continue;
            const normalized = normalizeRawMessage(decrypted.id, decrypted.localId, decrypted.createdAt, decrypted.content);
            if (normalized) normalizedMessages.push({ ...normalized, seq: messages[index]?.seq });
        }
        return normalizedMessages;
    }

    private fetchMessages = async (sessionId: string, replace: boolean = false) => {
        if (!this.visibleSessions.has(sessionId) || storage.getState().releasedSessionResources[sessionId]) return;
        log.log(`💬 fetchMessages starting for session ${sessionId} - acquiring lock`);
        const lock = this.getSessionMessageLock(sessionId);
        const isCurrent = this.captureSessionRequest(sessionId);
        await lock.inLock(async () => {
            if (!isCurrent()) return;
            const encryption = this.encryption.getSessionEncryption(sessionId);
            if (!encryption) {
                log.log(`💬 fetchMessages: Session encryption not ready for ${sessionId}, will retry`);
                throw new Error(`Session encryption not ready for ${sessionId}`);
            }

            const knownLastSeq = this.sessionLastSeq.get(sessionId);
            if (knownLastSeq === undefined || replace) {
                const view = storage.getState().sessionViewStates[sessionId];
                const restoreAnchor = !replace && view?.anchor && view.anchor.offset > 0 && typeof view.anchor.seq === 'number'
                    && (view.anchor.branchId ?? 'main') === (storage.getState().sessions[sessionId]?.metadata?.activeCodexBranchId ?? 'main');
                const beforeSeq = restoreAnchor ? view.anchor!.seq! + 41 : 2147483647;
                const data = await this.fetchMessagePage(sessionId, historyPagePath(sessionId, { before: beforeSeq }));
                const messages = Array.isArray(data.messages) ? data.messages : [];
                const normalizedMessages = await this.normalizeApiMessages(encryption, messages);
                if (!isCurrent()) return;
                if (normalizedMessages.length > 0 || replace) this.applyMessages(sessionId, normalizedMessages, replace ? { replace: true, rebuild: true } : undefined);
                const oldestSeq = messages.reduce((value, message) => Math.min(value, message.seq), Number.MAX_SAFE_INTEGER);
                const newestSeq = messages.reduce((value, message) => Math.max(value, message.seq), 0);
                this.sessionOldestSeq.set(sessionId, oldestSeq);
                this.sessionLastSeq.set(sessionId, newestSeq);
                storage.getState().applyMessagePageState(sessionId, {
                    hasOlder: data.hasMore,
                    hasNewer: Boolean(restoreAnchor),
                    cachedEventCount: normalizedMessages.length,
                });
                storage.getState().applyMessagesLoaded(sessionId);
                log.log(`💬 fetchMessages completed initial page for session ${sessionId} - processed ${normalizedMessages.length} messages`);
                return;
            }

            let afterSeq = knownLastSeq;
            let hasMore = true;
            let totalNormalized = 0;
            const browsingHistoricalWindow = storage.getState().sessionMessages[sessionId]?.hasNewer === true;
            if (browsingHistoricalWindow) return;

            while (hasMore) {
                const data = await this.fetchMessagePage(sessionId, historyPagePath(sessionId, { after: afterSeq }));
                const messages = Array.isArray(data.messages) ? data.messages : [];

                let maxSeq = afterSeq;
                for (const message of messages) {
                    if (message.seq > maxSeq) {
                        maxSeq = message.seq;
                    }
                }

                const normalizedMessages = await this.normalizeApiMessages(encryption, messages);
                if (!isCurrent()) return;

                if (normalizedMessages.length > 0 && !browsingHistoricalWindow) {
                    totalNormalized += normalizedMessages.length;
                    this.applyMessages(sessionId, normalizedMessages);
                } else if (normalizedMessages.length > 0) {
                    storage.getState().applyMessagePageState(sessionId, { hasNewer: true });
                }

                this.sessionLastSeq.set(sessionId, Math.max(this.sessionLastSeq.get(sessionId) ?? 0, maxSeq));
                hasMore = !!data.hasMore;
                if (hasMore) {
                    // A long reconnect gap must not download the entire transcript.
                    // Rebuild a bounded latest page; older history remains cursor-accessible.
                    const latest = await this.fetchMessagePage(sessionId, historyPagePath(sessionId, {}));
                    const latestMessages = await this.normalizeApiMessages(encryption, latest.messages);
                    if (!isCurrent()) return;
                    this.applyMessages(sessionId, latestMessages, { replace: true, rebuild: true });
                    this.sessionLastSeq.set(sessionId, latest.messages.reduce((seq, message) => Math.max(seq, message.seq), maxSeq));
                    storage.getState().applyMessagePageState(sessionId, { hasOlder: latest.hasMore, hasNewer: false });
                    break;
                }
                if (hasMore && maxSeq === afterSeq) {
                    log.log(`💬 fetchMessages: pagination stalled for ${sessionId}, stopping to avoid infinite loop`);
                    break;
                }
                afterSeq = maxSeq;
            }

            storage.getState().applyMessagesLoaded(sessionId);
            log.log(`💬 fetchMessages completed for session ${sessionId} - processed ${totalNormalized} messages`);
        }).catch((error) => { if (isCurrent()) throw error; });
    }

    private subscribeToUpdates = () => {
        // Subscribe to message updates
        apiSocket.onMessage('update', this.handleUpdate.bind(this));
        apiSocket.onMessage('ephemeral', this.handleEphemeralUpdate.bind(this));

        // Subscribe to connection state changes
        apiSocket.onReconnected(() => {
            log.log('🔌 Socket reconnected');
            this.sessionsSync.invalidate();
            this.machinesSync.invalidate();
            log.log('🔌 Socket reconnected: Invalidating artifacts sync');
            this.artifactsSync.invalidate();
            for (const id of this.visibleSessions.keys()) this.onSessionVisible(id);
            // Messages are fetched lazily per-session via onSessionVisible (called by SessionView
            // when realtimeStatus changes). Session metadata + agentState (including permission
            // requests) are already refreshed by sessionsSync.invalidate() above.
            for (const sync of this.sendSync.values()) {
                sync.invalidate();
            }
        });
    }

    private handleUpdate = async (update: unknown) => {
        const validatedUpdate = ApiUpdateContainerSchema.safeParse(update);
        if (!validatedUpdate.success) {
            console.log('❌ Sync: Invalid update received:', validatedUpdate.error);
            console.error('❌ Sync: Invalid update data:', update);
            return;
        }
        const updateData = validatedUpdate.data;
        console.log(`🔄 Sync: Validated update type: ${updateData.body.t}`);

        if (updateData.body.t === 'new-message') {
            if (!this.visibleSessions.has(updateData.body.sid) || storage.getState().releasedSessionResources[updateData.body.sid]) {
                const session = storage.getState().sessions[updateData.body.sid];
                if (session) this.applySessions([{ ...session, seq: Math.max(session.seq, updateData.body.message.seq), updatedAt: updateData.createdAt }]);
                return;
            }
            const isCurrent = this.captureSessionRequest(updateData.body.sid);

            // Get encryption
            const encryption = this.encryption.getSessionEncryption(updateData.body.sid);
            if (!encryption) { // Should never happen
                console.error(`Session ${updateData.body.sid} not found`);
                this.fetchSessions(); // Just fetch sessions again
                return;
            }

            // Decrypt message
            let lastMessage: NormalizedMessage | null = null;
            if (updateData.body.message) {
                const decrypted = await encryption.decryptMessage(updateData.body.message);
                if (!isCurrent()) return;
                if (decrypted) {
                    const normalized = normalizeRawMessage(decrypted.id, decrypted.localId, decrypted.createdAt, decrypted.content);
                    lastMessage = normalized ? { ...normalized, seq: updateData.body.message.seq } : null;

                    // Check for task lifecycle events to update thinking state
                    // This ensures UI updates even if volatile activity updates are lost
                    const rawContent = decrypted.content as {
                        role?: string;
                        content?: {
                            type?: string;
                            data?: {
                                type?: string;
                                ev?: { t?: string };
                            }
                        }
                    } | null;
                    const contentType = rawContent?.content?.type;
                    const dataType = rawContent?.content?.data?.type;
                    const sessionEventType = rawContent?.content?.data?.ev?.t;
                    
                    // Debug logging to trace lifecycle events
                    if (dataType === 'task_complete' || dataType === 'turn_aborted' || dataType === 'task_started' || sessionEventType === 'turn-start' || sessionEventType === 'turn-end') {
                        console.log(`🔄 [Sync] Lifecycle event detected: contentType=${contentType}, dataType=${dataType}, sessionEventType=${sessionEventType}`);
                    }
                    
                    const isTaskComplete = 
                        ((contentType === 'acp' || contentType === 'codex') && 
                            (dataType === 'task_complete' || dataType === 'turn_aborted')) ||
                        (contentType === 'session' && sessionEventType === 'turn-end');
                    
                    const isTaskStarted = 
                        ((contentType === 'acp' || contentType === 'codex') && dataType === 'task_started') ||
                        (contentType === 'session' && sessionEventType === 'turn-start');

                    if (isTaskComplete || isTaskStarted) {
                        console.log(`🔄 [Sync] Updating thinking state: isTaskComplete=${isTaskComplete}, isTaskStarted=${isTaskStarted}`);
                    }

                    // Update session
                    const session = storage.getState().sessions[updateData.body.sid];
                    if (session) {
                        this.applySessions([{
                            ...session,
                            updatedAt: updateData.createdAt,
                            seq: Math.max(session.seq, updateData.body.message.seq),
                            // Update thinking state based on task lifecycle events
                            ...(isTaskComplete ? { thinking: false, activity: null } : {}),
                            ...(isTaskStarted ? { thinking: true, activity: null } : {})
                        }])
                    } else {
                        // Fetch sessions again if we don't have this session
                        this.fetchSessions();
                    }

                    // Fast-path only on consecutive seq values, otherwise fetch from server.
                    const currentLastSeq = this.sessionLastSeq.get(updateData.body.sid);
                    const incomingSeq = updateData.body.message.seq;
                    const browsingHistoricalWindow = storage.getState().sessionMessages[updateData.body.sid]?.hasNewer === true;
                    if (lastMessage && browsingHistoricalWindow) {
                        this.sessionLastSeq.set(updateData.body.sid, Math.max(currentLastSeq ?? 0, incomingSeq));
                        storage.getState().applyMessagePageState(updateData.body.sid, { hasNewer: true });
                    } else if (lastMessage && currentLastSeq !== undefined && incomingSeq === currentLastSeq + 1) {
                        this.applyMessages(updateData.body.sid, [lastMessage]);
                        this.sessionLastSeq.set(updateData.body.sid, incomingSeq);
                        let hasMutableTool = false;
                        if (lastMessage.role === 'agent' && lastMessage.content[0] && lastMessage.content[0].type === 'tool-result') {
                            hasMutableTool = storage.getState().isMutableToolCall(updateData.body.sid, lastMessage.content[0].tool_use_id);
                        }
                        if (hasMutableTool) {
                            gitStatusSync.invalidate(updateData.body.sid);
                        }
                    } else {
                        this.getMessagesSync(updateData.body.sid).invalidate();
                    }
                }
            }

            // Ping session
            this.onSessionVisible(updateData.body.sid);

        } else if (updateData.body.t === 'new-session') {
            log.log('🆕 New session update received');
            this.sessionsSync.invalidate();
        } else if (updateData.body.t === 'delete-session') {
            log.log('🗑️ Delete session update received');
            const sessionId = updateData.body.sid;
            this.sessionRequestEpochs.invalidate(sessionId);

            // Remove session from storage
            storage.getState().deleteSession(sessionId);

            // Remove encryption keys from memory
            this.encryption.removeSessionEncryption(sessionId);

            // Remove from project manager
            projectManager.removeSession(sessionId);

            // Clear any cached git status
            gitStatusSync.clearForSession(sessionId);
            this.messagesSync.delete(sessionId);
            this.sendSync.delete(sessionId);
            this.pendingOutbox.delete(sessionId);
            this.sessionLastSeq.delete(sessionId);
            this.sessionOldestSeq.delete(sessionId);
            this.sessionMessageLocks.delete(sessionId);
            this.sessionMessageQueue.delete(sessionId);
            this.sessionQueueProcessing.delete(sessionId);

            log.log(`🗑️ Session ${sessionId} deleted from local storage`);
        } else if (updateData.body.t === 'update-session') {
            const session = storage.getState().sessions[updateData.body.id];
            if (session) {
                // Get session encryption
                const sessionEncryption = this.encryption.getSessionEncryption(updateData.body.id);
                if (!sessionEncryption) {
                    console.error(`Session encryption not found for ${updateData.body.id} - this should never happen`);
                    return;
                }

                const agentState = updateData.body.agentState && sessionEncryption
                    ? await sessionEncryption.decryptAgentState(updateData.body.agentState.version, updateData.body.agentState.value)
                    : session.agentState;
                const metadata = updateData.body.metadata && sessionEncryption
                    ? await sessionEncryption.decryptMetadata(updateData.body.metadata.version, updateData.body.metadata.value)
                    : session.metadata;

                // Deleting a session while decryption is pending must not recreate it.
                if (!storage.getState().sessions[session.id]
                    || this.encryption.getSessionEncryption(session.id) !== sessionEncryption) return;

                this.applySessions([{
                    ...session,
                    agentState,
                    agentStateVersion: updateData.body.agentState
                        ? updateData.body.agentState.version
                        : session.agentStateVersion,
                    metadata,
                    metadataVersion: updateData.body.metadata
                        ? updateData.body.metadata.version
                        : session.metadataVersion,
                    updatedAt: updateData.createdAt,
                    lastUserMessageAt: updateData.body.lastUserMessageAt ?? session.lastUserMessageAt,
                    lastUserMessageIndexedSeq: updateData.body.lastUserMessageIndexedSeq ?? session.lastUserMessageIndexedSeq,
                }]);

                // Invalidate git status when agent state changes (files may have been modified)
                if (updateData.body.agentState) {
                    gitStatusSync.invalidate(updateData.body.id);

                    // Re-fetch messages when control returns to mobile (local -> remote mode switch)
                    // This catches up on any messages that were exchanged while desktop had control
                    const wasControlledByUser = session.agentState?.controlledByUser;
                    const isNowControlledByUser = agentState?.controlledByUser;
                    if (!wasControlledByUser && isNowControlledByUser) {
                        log.log(`🔄 Control returned to mobile for session ${updateData.body.id}, re-fetching messages`);
                        this.onSessionVisible(updateData.body.id);
                    }
                }
            }
        } else if (updateData.body.t === 'update-account') {
            const accountUpdate = updateData.body;
            const currentProfile = storage.getState().profile;

            // Build updated profile with new data
            const updatedProfile: Profile = {
                ...currentProfile,
                firstName: accountUpdate.firstName !== undefined ? accountUpdate.firstName : currentProfile.firstName,
                lastName: accountUpdate.lastName !== undefined ? accountUpdate.lastName : currentProfile.lastName,
                avatar: accountUpdate.avatar !== undefined ? accountUpdate.avatar : currentProfile.avatar,
                github: accountUpdate.github !== undefined ? accountUpdate.github : currentProfile.github,
                timestamp: updateData.createdAt // Update timestamp to latest
            };

            // Apply the updated profile to storage
            storage.getState().applyProfile(updatedProfile);

            // Handle settings updates (new for profile sync)
            if (accountUpdate.settings?.value) {
                try {
                    const decryptedSettings = await this.encryption.decryptRaw(accountUpdate.settings.value);
                    const parsedSettings = settingsParse(decryptedSettings);

                    // Version compatibility check
                    const settingsSchemaVersion = parsedSettings.schemaVersion ?? 1;
                    if (settingsSchemaVersion > SUPPORTED_SCHEMA_VERSION) {
                        console.warn(
                            `⚠️ Received settings schema v${settingsSchemaVersion}, ` +
                            `we support v${SUPPORTED_SCHEMA_VERSION}. Update app for full functionality.`
                        );
                    }

                    this.applyServerSettings(parsedSettings, accountUpdate.settings.version);
                    log.log(`📋 Settings synced from server (schema v${settingsSchemaVersion}, version ${accountUpdate.settings.version})`);
                } catch (error) {
                    console.error('❌ Failed to process settings update:', error);
                    // Don't crash on settings sync errors, just log
                }
            }
        } else if (updateData.body.t === 'new-machine') {
            await this.machinesSync.invalidateAndAwait();
        } else if (updateData.body.t === 'update-machine') {
            const machineUpdate = updateData.body;
            const machineId = machineUpdate.machineId;  // Changed from .id to .machineId
            const machine = storage.getState().machines[machineId];

            // Create or update machine with all required fields
            const updatedMachine: Machine = {
                id: machineId,
                seq: updateData.seq,
                createdAt: machine?.createdAt ?? updateData.createdAt,
                updatedAt: updateData.createdAt,
                active: machineUpdate.active ?? true,
                activeAt: machineUpdate.activeAt ?? updateData.createdAt,
                metadata: machine?.metadata ?? null,
                metadataVersion: machine?.metadataVersion ?? 0,
                daemonState: machine?.daemonState ?? null,
                daemonStateVersion: machine?.daemonStateVersion ?? 0
            };

            // Get machine-specific encryption (might not exist if machine wasn't initialized)
            let machineEncryption = this.encryption.getMachineEncryption(machineId);
            if (!machineEncryption) {
                await this.machinesSync.invalidateAndAwait();
                machineEncryption = this.encryption.getMachineEncryption(machineId);
                if (!machineEncryption) {
                    console.warn(`Machine ${machineId} is not available after refresh`);
                    return;
                }
            }

            // If metadata is provided, decrypt and update it
            const metadataUpdate = machineUpdate.metadata;
            if (metadataUpdate) {
                try {
                    const metadata = await machineEncryption.decryptMetadata(metadataUpdate.version, metadataUpdate.value);
                    updatedMachine.metadata = metadata;
                    updatedMachine.metadataVersion = metadataUpdate.version;
                } catch (error) {
                    console.error(`Failed to decrypt machine metadata for ${machineId}:`, error);
                }
            }

            // If daemonState is provided, decrypt and update it
            const daemonStateUpdate = machineUpdate.daemonState;
            if (daemonStateUpdate) {
                try {
                    const daemonState = await machineEncryption.decryptDaemonState(daemonStateUpdate.version, daemonStateUpdate.value);
                    updatedMachine.daemonState = daemonState;
                    updatedMachine.daemonStateVersion = daemonStateUpdate.version;
                } catch (error) {
                    console.error(`Failed to decrypt machine daemonState for ${machineId}:`, error);
                }
            }

            // Update storage using applyMachines which rebuilds sessionListViewData
            storage.getState().applyMachines([updatedMachine]);
        } else if (updateData.body.t === 'delete-machine') {
            const machineId = updateData.body.machineId;
            log.log(`🗑️ Delete machine update received for ${machineId}`);
            if (!storage.getState().machines[machineId]) {
                log.log(`Machine ${machineId} not in storage, skipping delete`);
            } else {
                storage.getState().deleteMachine(machineId);
                this.encryption.removeMachineEncryption(machineId);
                this.machineDataKeys.delete(machineId);
            }
        } else if (updateData.body.t === 'relationship-updated') {
            log.log('👥 Received relationship-updated update');
            const relationshipUpdate = updateData.body;
            
            // Apply the relationship update to storage
            storage.getState().applyRelationshipUpdate({
                fromUserId: relationshipUpdate.fromUserId,
                toUserId: relationshipUpdate.toUserId,
                status: relationshipUpdate.status,
                action: relationshipUpdate.action,
                fromUser: relationshipUpdate.fromUser,
                toUser: relationshipUpdate.toUser,
                timestamp: relationshipUpdate.timestamp
            });
            
        } else if (updateData.body.t === 'new-artifact') {
            log.log('📦 Received new-artifact update');
            const artifactUpdate = updateData.body;
            const artifactId = artifactUpdate.artifactId;
            
            try {
                // Decrypt the data encryption key
                const decryptedKey = await this.encryption.decryptEncryptionKey(artifactUpdate.dataEncryptionKey);
                if (!decryptedKey) {
                    console.error(`Failed to decrypt key for new artifact ${artifactId}`);
                    return;
                }
                
                // Store the decrypted key in memory
                this.artifactDataKeys.set(artifactId, decryptedKey);
                
                // Create artifact encryption instance
                const artifactEncryption = new ArtifactEncryption(decryptedKey);
                
                // Decrypt header
                const header = await artifactEncryption.decryptHeader(artifactUpdate.header);
                
                // Decrypt body if provided
                let decryptedBody: string | null | undefined = undefined;
                if (artifactUpdate.body && artifactUpdate.bodyVersion !== undefined) {
                    const body = await artifactEncryption.decryptBody(artifactUpdate.body);
                    decryptedBody = body?.body || null;
                }
                
                // Add to storage
                const decryptedArtifact: DecryptedArtifact = {
                    id: artifactId,
                    title: header?.title || null,
                    body: decryptedBody,
                    headerVersion: artifactUpdate.headerVersion,
                    bodyVersion: artifactUpdate.bodyVersion,
                    seq: artifactUpdate.seq,
                    createdAt: artifactUpdate.createdAt,
                    updatedAt: artifactUpdate.updatedAt,
                    isDecrypted: !!header,
                };
                
                storage.getState().addArtifact(decryptedArtifact);
                log.log(`📦 Added new artifact ${artifactId} to storage`);
            } catch (error) {
                console.error(`Failed to process new artifact ${artifactId}:`, error);
            }
        } else if (updateData.body.t === 'update-artifact') {
            log.log('📦 Received update-artifact update');
            const artifactUpdate = updateData.body;
            const artifactId = artifactUpdate.artifactId;
            
            // Get existing artifact
            const existingArtifact = storage.getState().artifacts[artifactId];
            if (!existingArtifact) {
                console.error(`Artifact ${artifactId} not found in storage`);
                // Fetch all artifacts to sync
                this.artifactsSync.invalidate();
                return;
            }
            
            try {
                // Get the data encryption key from memory
                let dataEncryptionKey = this.artifactDataKeys.get(artifactId);
                if (!dataEncryptionKey) {
                    console.error(`Encryption key not found for artifact ${artifactId}, fetching artifacts`);
                    this.artifactsSync.invalidate();
                    return;
                }
                
                // Create artifact encryption instance
                const artifactEncryption = new ArtifactEncryption(dataEncryptionKey);
                
                // Update artifact with new data  
                const updatedArtifact: DecryptedArtifact = {
                    ...existingArtifact,
                    seq: updateData.seq,
                    updatedAt: updateData.createdAt,
                };
                
                // Decrypt and update header if provided
                if (artifactUpdate.header) {
                    const header = await artifactEncryption.decryptHeader(artifactUpdate.header.value);
                    updatedArtifact.title = header?.title || null;
                    updatedArtifact.sessions = header?.sessions;
                    updatedArtifact.draft = header?.draft;
                    updatedArtifact.headerVersion = artifactUpdate.header.version;
                }
                
                // Decrypt and update body if provided
                if (artifactUpdate.body) {
                    const body = await artifactEncryption.decryptBody(artifactUpdate.body.value);
                    updatedArtifact.body = body?.body || null;
                    updatedArtifact.bodyVersion = artifactUpdate.body.version;
                }
                
                storage.getState().updateArtifact(updatedArtifact);
                log.log(`📦 Updated artifact ${artifactId} in storage`);
            } catch (error) {
                console.error(`Failed to process artifact update ${artifactId}:`, error);
            }
        } else if (updateData.body.t === 'delete-artifact') {
            log.log('📦 Received delete-artifact update');
            const artifactUpdate = updateData.body;
            const artifactId = artifactUpdate.artifactId;
            
            // Remove from storage
            storage.getState().deleteArtifact(artifactId);
            
            // Remove encryption key from memory
            this.artifactDataKeys.delete(artifactId);
        } else if (updateData.body.t === 'new-feed-post') {
            log.log('📰 Received new-feed-post update');
            const feedUpdate = updateData.body;
            
            // Convert to FeedItem with counter from cursor
            const feedItem: FeedItem = {
                id: feedUpdate.id,
                body: feedUpdate.body,
                cursor: feedUpdate.cursor,
                createdAt: feedUpdate.createdAt,
                repeatKey: feedUpdate.repeatKey,
                counter: parseInt(feedUpdate.cursor.substring(2), 10)
            };
            
            // Check if we need to fetch user for friend-related items
            if (feedItem.body && (feedItem.body.kind === 'friend_request' || feedItem.body.kind === 'friend_accepted')) {
                await this.assumeUsers([feedItem.body.uid]);
                
                // Check if user fetch failed (404) - don't store item if user not found
                const users = storage.getState().users;
                const userProfile = users[feedItem.body.uid];
                if (userProfile === null || userProfile === undefined) {
                    // User was not found or 404, don't store this item
                    log.log(`📰 Skipping feed item ${feedItem.id} - user ${feedItem.body.uid} not found`);
                    return;
                }
            }
            
            // Apply to storage (will handle repeatKey replacement)
            storage.getState().applyFeedItems([feedItem]);
        }
    }

    private flushActivityUpdates = (updates: Map<string, ApiEphemeralActivityUpdate>) => {
        // log.log(`🔄 Flushing activity updates for ${updates.size} sessions - acquiring lock`);


        const sessions: Session[] = [];

        for (const [sessionId, update] of updates) {
            const session = storage.getState().sessions[sessionId];
            if (session) {
                sessions.push({
                    ...session,
                    active: update.active,
                    activeAt: update.activeAt,
                    thinking: update.thinking ?? false,
                    thinkingAt: update.activeAt, // Always use activeAt for consistency
                    activity: update.thinking ? update.activity ?? session.activity ?? null : null,
                });
            }
        }

        if (sessions.length > 0) {
            // console.log('flushing activity updates ' + sessions.length);
            this.applySessions(sessions);
            // log.log(`🔄 Activity updates flushed - updated ${sessions.length} sessions`);
        }
    }

    private handleEphemeralUpdate = (update: unknown) => {
        const validatedUpdate = ApiEphemeralUpdateSchema.safeParse(update);
        if (!validatedUpdate.success) {
            console.log('Invalid ephemeral update received:', validatedUpdate.error);
            console.error('Invalid ephemeral update received:', update);
            return;
        } else {
            // console.log('Ephemeral update received:', update);
        }
        const updateData = validatedUpdate.data;

        // Process activity updates through smart debounce accumulator
        if (updateData.type === 'activity') {
            // console.log('adding activity update ' + updateData.id);
            this.activityAccumulator.addUpdate(updateData);
        }

        // Handle machine activity updates
        if (updateData.type === 'machine-activity') {
            // Update machine's active status and lastActiveAt
            const machine = storage.getState().machines[updateData.id];
            if (machine) {
                const updatedMachine: Machine = {
                    ...machine,
                    active: updateData.active,
                    activeAt: updateData.activeAt
                };
                storage.getState().applyMachines([updatedMachine]);
            }
        }


        if (updateData.type === 'session-stream') {
            if (!this.visibleSessions.has(updateData.id) || storage.getState().releasedSessionResources[updateData.id]) return;
            const encryption = this.encryption.getSessionEncryption(updateData.id);
            if (!encryption) return;
            const isCurrent = this.captureSessionRequest(updateData.id);
            void encryption.decryptRaw(updateData.payload).then((stream: unknown) => {
                if (!isCurrent()) return;
                if (!stream || typeof stream !== 'object') return;
                const value = stream as Record<string, unknown>;
                if (
                    typeof value.id !== 'string'
                    || typeof value.turnId !== 'string'
                    || typeof value.text !== 'string'
                    || value.text.length > 1_000_000
                    || typeof value.updatedAt !== 'number' || !Number.isFinite(value.updatedAt)
                    || (value.branchId !== undefined && typeof value.branchId !== 'string')
                    || (value.seq !== undefined && (typeof value.seq !== 'number' || !Number.isSafeInteger(value.seq) || value.seq < 0))
                    || (value.epoch !== undefined && typeof value.epoch !== 'string')
                    || (value.kind !== undefined && value.kind !== 'text' && value.kind !== 'tool-output' && value.kind !== 'reasoning-summary')
                    || (value.callId !== undefined && typeof value.callId !== 'string')
                    || (value.truncated !== undefined && typeof value.truncated !== 'boolean')
                    || (value.totalBytes !== undefined && (typeof value.totalBytes !== 'number' || !Number.isSafeInteger(value.totalBytes) || value.totalBytes < 0))
                ) return;
                const runtimeEpoch = storage.getState().sessions[updateData.id]?.agentState?.codexRuntime?.epoch;
                if (typeof value.epoch === 'string' && runtimeEpoch && value.epoch !== runtimeEpoch) return;
                this.streamBatcher.enqueue(updateData.id, {
                    id: value.id,
                    turnId: value.turnId,
                    text: value.text,
                    updatedAt: value.updatedAt,
                    ...(typeof value.branchId === 'string' ? { branchId: value.branchId } : {}),
                    ...(typeof value.seq === 'number' ? { seq: value.seq } : {}),
                    ...(typeof value.epoch === 'string' ? { epoch: value.epoch } : {}),
                    ...(value.kind === 'tool-output' || value.kind === 'reasoning-summary' ? { kind: value.kind } : {}),
                    ...(typeof value.callId === 'string' ? { callId: value.callId } : {}),
                    ...(typeof value.truncated === 'boolean' ? { truncated: value.truncated } : {}),
                    ...(typeof value.totalBytes === 'number' ? { totalBytes: value.totalBytes } : {}),
                });
            }).catch(() => {});
        }

        // daemon-status ephemeral updates are deprecated, machine status is handled via machine-activity
    }

    //
    // Apply store
    //

    private applyMessages = (sessionId: string, messages: NormalizedMessage[], options?: { rebuild?: boolean; replace?: boolean; keep?: 'newest' | 'oldest' }) => {
        this.streamBatcher.flush(sessionId);
        storage.getState().applyMessages(sessionId, messages, options);
        const rawMessages = Object.values(storage.getState().sessionMessages[sessionId]?.rawMessagesMap ?? {});
        const oldestSeq = rawMessages.reduce((value, message) => (
            typeof message.seq === 'number' ? Math.min(value, message.seq) : value
        ), Number.MAX_SAFE_INTEGER);
        if (oldestSeq !== Number.MAX_SAFE_INTEGER) this.sessionOldestSeq.set(sessionId, oldestSeq);
    }

    private applySessions = (sessions: (Omit<Session, "presence"> & {
        presence?: "online" | number;
    })[]) => {
        const previousSessions = new Map(sessions.map((session) => [session.id, storage.getState().sessions[session.id]]));
        const previousBranches = new Map(sessions.map((session) => [
            session.id, storage.getState().sessions[session.id]?.metadata?.activeCodexBranchId,
        ]));
        storage.getState().applySessions(sessions);
        for (const session of sessions) {
            if (previousSessions.get(session.id) && previousSessions.get(session.id)?.metadata?.lifecycleState !== 'sleeping'
                && storage.getState().sessions[session.id]?.metadata?.lifecycleState === 'sleeping') {
                storage.getState().unloadSessionResources(session.id);
            }
            const branchId = storage.getState().sessions[session.id]?.metadata?.activeCodexBranchId;
            if (previousBranches.get(session.id) === branchId) continue;
            this.streamBatcher.clear(session.id);
            storage.getState().saveSessionScrollAnchor(session.id, { offset: 0, branchId });
            this.sessionLastSeq.delete(session.id);
            this.sessionOldestSeq.delete(session.id);
            this.sessionRequestEpochs.invalidate(session.id);
            this.sessionMessageQueue.delete(session.id);
            if (storage.getState().sessionMessages[session.id]) storage.getState().applyMessagePageState(session.id, { isLoadingOlder: false, isLoadingLatest: false });
            if (this.messagesSync.has(session.id)) this.getMessagesSync(session.id).invalidate();
        }
        this.questionBackfill.enqueue(sessions.map(session => {
            const current = storage.getState().sessions[session.id] ?? session;
            return { id: current.id, seq: current.seq, indexedThroughSeq: current.lastUserMessageIndexedSeq };
        }));
    }

}

// Global singleton instance
export const sync = new Sync();

//
// Init sequence
//

let isInitialized = false;
export async function syncCreate(credentials: AuthCredentials) {
    await ensureMediaAccess(credentials);
    if (isInitialized) {
        console.warn('Sync already initialized: ignoring');
        return;
    }
    isInitialized = true;
    await syncInit(credentials, false);
}

export async function syncRestore(credentials: AuthCredentials) {
    await ensureMediaAccess(credentials);
    if (isInitialized) {
        console.warn('Sync already initialized: ignoring');
        return;
    }
    isInitialized = true;
    await syncInit(credentials, true);
}

async function syncInit(credentials: AuthCredentials, restore: boolean) {

    // Initialize sync engine
    const secretKey = decodeBase64(credentials.secret, 'base64url');
    if (secretKey.length !== 32) {
        throw new Error(`Invalid secret key length: ${secretKey.length}, expected 32`);
    }
    const encryption = await Encryption.create(secretKey);

    // Initialize socket connection
    const API_ENDPOINT = getServerUrl();
    apiSocket.initialize({ endpoint: API_ENDPOINT, token: credentials.token }, encryption);

    // Wire socket status to storage
    apiSocket.onStatusChange((status) => {
        storage.getState().setSocketStatus(status);
    });

    // Initialize sessions engine
    if (restore) {
        await sync.restore(credentials, encryption);
    } else {
        await sync.create(credentials, encryption);
    }
}
