import type { ApiSessionClient } from '@/api/apiSession';
import type { AgentState, Metadata } from '@/api/types';
import type { RpcHandler } from '@/api/rpc/types';
import { logger } from '@/ui/logger';

const DEFAULT_OFFLINE_BACKLOG_BYTES = 4 * 1024 * 1024;
type BufferedMethod = 'sendSessionProtocolMessage' | 'sendSessionEvent' | 'sendCodexMessage' | 'sendAgentMessage' | 'sendClaudeSessionMessage' | 'closeClaudeSessionTurn';
type PendingMessage = { method: BufferedMethod; args: unknown[]; resolve: () => void; reject: (error: unknown) => void };

export type OfflineSessionStub = ApiSessionClient & { reconnect: (session: ApiSessionClient) => void };

/** Bootstrap bridge: retain bounded durable messages and handlers until a real session can acknowledge them. */
export function createOfflineSessionStub(sessionTag: string, options: {
    metadata?: Metadata;
    state?: AgentState;
    maxBacklogBytes?: number;
} = {}): OfflineSessionStub {
    let target: ApiSessionClient | null = null;
    let closed = false;
    let metadata = options.metadata ?? null;
    let state = options.state ?? {};
    let metadataChanged = false;
    let stateChanged = false;
    let backlogBytes = 0;
    const pending: PendingMessage[] = [];
    const handlers = new Map<string, RpcHandler>();
    let onUserMessage: Parameters<ApiSessionClient['onUserMessage']>[0] | null = null;
    let lastPresence: Parameters<ApiSessionClient['keepAlive']> | null = null;
    let protocolJournalPath: string | null = null;

    const enqueue = (method: BufferedMethod, args: unknown[]): Promise<void> => {
        const receipt = new Promise<void>((resolve, reject) => {
            if (closed) { reject(new Error('Offline session is closed')); return; }
            const bytes = Buffer.byteLength(JSON.stringify(args), 'utf8');
            if (backlogBytes + bytes > (options.maxBacklogBytes ?? DEFAULT_OFFLINE_BACKLOG_BYTES)) {
                reject(new Error('Offline session message backlog exceeded its byte budget; this message was not persisted'));
                return;
            }
            backlogBytes += bytes;
            pending.push({ method, args, resolve, reject });
        });
        // Legacy senders ignore receipts; report failures without an unhandled rejection.
        void receipt.catch((error) => logger.warn('[OfflineSession] Durable message delivery failed', error));
        return receipt;
    };

    const stub = {
        sessionId: `offline-${sessionTag}`,
        authToken: '',
        getMetadata: () => metadata,
        attachCodexProtocolJournal: (path: string) => { protocolJournalPath = path; },
        sendSessionProtocolMessage: (...args: Parameters<ApiSessionClient['sendSessionProtocolMessage']>) => enqueue('sendSessionProtocolMessage', args),
        sendSessionEvent: (...args: Parameters<ApiSessionClient['sendSessionEvent']>) => { void enqueue('sendSessionEvent', args); },
        sendCodexMessage: (...args: Parameters<ApiSessionClient['sendCodexMessage']>) => { void enqueue('sendCodexMessage', args); },
        sendAgentMessage: (...args: Parameters<ApiSessionClient['sendAgentMessage']>) => { void enqueue('sendAgentMessage', args); },
        sendClaudeSessionMessage: (...args: Parameters<ApiSessionClient['sendClaudeSessionMessage']>) => { void enqueue('sendClaudeSessionMessage', args); },
        closeClaudeSessionTurn: (...args: Parameters<ApiSessionClient['closeClaudeSessionTurn']>) => { void enqueue('closeClaudeSessionTurn', args); },
        // Presence and stream snapshots are ephemeral. The durable messages above remain pending.
        keepAlive: (...args: Parameters<ApiSessionClient['keepAlive']>) => { lastPresence = args; },
        sendSessionStream: () => {},
        sendSessionDeath: () => {},
        sendUsageData: () => {},
        flush: async () => {
            if (pending.length > 0 || protocolJournalPath) throw new Error('Cannot flush durable messages while the session is offline');
        },
        close: async () => {
            closed = true;
            for (const message of pending.splice(0)) message.reject(new Error('Session closed before offline messages could be persisted'));
            backlogBytes = 0;
        },
        updateMetadata: (update: Parameters<ApiSessionClient['updateMetadata']>[0]) => {
            if (!metadata) throw new Error('Offline session metadata is unavailable');
            metadata = update(metadata);
            metadataChanged = true;
        },
        updateAgentState: (update: Parameters<ApiSessionClient['updateAgentState']>[0]) => {
            state = update(state);
            stateChanged = true;
        },
        onUserMessage: (handler: Parameters<ApiSessionClient['onUserMessage']>[0]) => { onUserMessage = handler; },
        rpcHandlerManager: {
            registerHandler: (method: string, handler: RpcHandler) => {
                handlers.set(method, handler);
                target?.rpcHandlerManager.registerHandler(method, handler);
            },
            unregisterHandler: (method: string) => {
                handlers.delete(method);
                target?.rpcHandlerManager.unregisterHandler(method);
            },
            hasHandler: (method: string) => target?.rpcHandlerManager.hasHandler(method) ?? handlers.has(method),
            getHandlerCount: () => target?.rpcHandlerManager.getHandlerCount() ?? handlers.size,
        },
        reconnect: (session: ApiSessionClient) => {
            if (closed) throw new Error('Cannot reconnect a closed offline session');
            if (target) throw new Error('Offline session has already reconnected');
            target = session;
            if (protocolJournalPath) session.attachCodexProtocolJournal(protocolJournalPath);
            protocolJournalPath = null;
            for (const [method, handler] of handlers) session.rpcHandlerManager.registerHandler(method, handler);
            handlers.clear();
            if (metadataChanged && metadata) {
                const latestMetadata = metadata;
                session.updateMetadata((remote) => ({ ...remote, ...latestMetadata }));
            }
            if (stateChanged) {
                const latestState = state;
                session.updateAgentState((remote) => ({ ...remote, ...latestState }));
            }
            // Enqueue the entire backlog in its original order before accepting new user messages.
            for (const message of pending.splice(0)) {
                try {
                    const method = session[message.method] as (...args: unknown[]) => unknown;
                    Promise.resolve(method.apply(session, message.args)).then(message.resolve, message.reject);
                } catch (error) { message.reject(error); }
            }
            backlogBytes = 0;
            if (lastPresence) session.keepAlive(...lastPresence);
            if (onUserMessage) session.onUserMessage(onUserMessage);
            metadata = null;
            state = {};
            onUserMessage = null;
            lastPresence = null;
        },
    };

    // Objects holding the original session (MCP server, permission handlers) also follow reconnection.
    return new Proxy(stub, {
        get(local, key) {
            if (target && key !== 'reconnect') {
                const value = Reflect.get(target, key);
                return typeof value === 'function' ? value.bind(target) : value;
            }
            return Reflect.get(local, key);
        },
    }) as unknown as OfflineSessionStub;
}
