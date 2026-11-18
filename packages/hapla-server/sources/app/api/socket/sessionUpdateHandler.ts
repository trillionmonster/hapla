import { getMetricsLabelsFromSocket, sessionAliveEventsCounter, websocketEventsCounter } from "@/app/monitoring/metrics2";
import { activityCache } from "@/app/presence/sessionCache";
import { buildNewMessageUpdate, buildSessionActivityEphemeral, buildUpdateSessionUpdate, ClientConnection, eventRouter } from "@/app/events/eventRouter";
import { db } from "@/storage/db";
import { allocateSessionSeqBatch, allocateUserSeq } from "@/storage/seq";
import { AsyncLock } from "@/utils/lock";
import { log } from "@/utils/log";
import { randomKeyNaked } from "@/utils/randomKeyNaked";
import { Socket } from "socket.io";
import { emitQuestionIndex, indexAcceptedMessage, type MessageRoleHint } from '@/app/session/sessionQuestionIndex';

export function sessionUpdateHandler(userId: string, socket: Socket, connection: ClientConnection) {
    const labels = getMetricsLabelsFromSocket(socket);
    socket.on('update-metadata', async (data: any, callback: (response: any) => void) => {
        try {
            const { sid, metadata, expectedVersion } = data;

            // Validate input
            if (!sid || typeof metadata !== 'string' || typeof expectedVersion !== 'number') {
                if (callback) {
                    callback({ result: 'error' });
                }
                return;
            }

            // Resolve session
            const session = await db.session.findUnique({
                where: { id: sid, accountId: userId }
            });
            if (!session) {
                return;
            }

            // Check version
            if (session.metadataVersion !== expectedVersion) {
                callback({ result: 'version-mismatch', version: session.metadataVersion, metadata: session.metadata });
                return null;
            }

            // Update metadata
            const { count } = await db.session.updateMany({
                where: { id: sid, metadataVersion: expectedVersion },
                data: {
                    metadata: metadata,
                    metadataVersion: expectedVersion + 1
                }
            });
            if (count === 0) {
                callback({ result: 'version-mismatch', version: session.metadataVersion, metadata: session.metadata });
                return null;
            }

            // Generate session metadata update
            const updSeq = await allocateUserSeq(userId);
            const metadataUpdate = {
                value: metadata,
                version: expectedVersion + 1
            };
            const updatePayload = buildUpdateSessionUpdate(sid, updSeq, randomKeyNaked(12), metadataUpdate);
            eventRouter.emitUpdate({
                userId,
                payload: updatePayload,
                recipientFilter: { type: 'all-interested-in-session', sessionId: sid }
            });

            // Send success response with new version via callback
            callback({ result: 'success', version: expectedVersion + 1, metadata: metadata });
        } catch (error) {
            log({ module: 'websocket', level: 'error' }, `Error in update-metadata: ${error}`);
            if (callback) {
                callback({ result: 'error' });
            }
        }
    });

    socket.on('update-state', async (data: any, callback: (response: any) => void) => {
        try {
            const { sid, agentState, expectedVersion } = data;

            // Validate input
            if (!sid || (typeof agentState !== 'string' && agentState !== null) || typeof expectedVersion !== 'number') {
                if (callback) {
                    callback({ result: 'error' });
                }
                return;
            }

            // Resolve session
            const session = await db.session.findUnique({
                where: {
                    id: sid,
                    accountId: userId
                }
            });
            if (!session) {
                callback({ result: 'error' });
                return null;
            }

            // Check version
            if (session.agentStateVersion !== expectedVersion) {
                callback({ result: 'version-mismatch', version: session.agentStateVersion, agentState: session.agentState });
                return null;
            }

            // Update agent state
            const { count } = await db.session.updateMany({
                where: { id: sid, agentStateVersion: expectedVersion },
                data: {
                    agentState: agentState,
                    agentStateVersion: expectedVersion + 1
                }
            });
            if (count === 0) {
                callback({ result: 'version-mismatch', version: session.agentStateVersion, agentState: session.agentState });
                return null;
            }

            // Generate session agent state update
            const updSeq = await allocateUserSeq(userId);
            const agentStateUpdate = {
                value: agentState,
                version: expectedVersion + 1
            };
            const updatePayload = buildUpdateSessionUpdate(sid, updSeq, randomKeyNaked(12), undefined, agentStateUpdate);
            eventRouter.emitUpdate({
                userId,
                payload: updatePayload,
                recipientFilter: { type: 'all-interested-in-session', sessionId: sid }
            });

            // Send success response with new version via callback
            callback({ result: 'success', version: expectedVersion + 1, agentState: agentState });
        } catch (error) {
            log({ module: 'websocket', level: 'error' }, `Error in update-state: ${error}`);
            if (callback) {
                callback({ result: 'error' });
            }
        }
    });
    socket.on('session-alive', async (data: {
        sid: string;
        time: number;
        thinking?: boolean;
        activity?: {
            phase?: unknown;
            detail?: unknown;
            itemType?: unknown;
        } | null;
    }) => {
        try {
            // Track metrics
            websocketEventsCounter.inc({ event_type: 'session-alive', ...labels });
            sessionAliveEventsCounter.inc();

            // Basic validation
            if (!data || typeof data.time !== 'number' || !data.sid) {
                return;
            }

            let t = data.time;
            if (t > Date.now()) {
                t = Date.now();
            }
            if (t < Date.now() - 1000 * 60 * 10) {
                return;
            }

            const { sid, thinking } = data;
            const activity = data.activity && typeof data.activity.phase === 'string' && data.activity.phase.trim()
                ? {
                    phase: data.activity.phase.trim().slice(0, 64),
                    ...(typeof data.activity.detail === 'string' && data.activity.detail.trim()
                        ? { detail: data.activity.detail.trim().slice(0, 240) }
                        : {}),
                    ...(typeof data.activity.itemType === 'string' && data.activity.itemType.trim()
                        ? { itemType: data.activity.itemType.trim().slice(0, 80) }
                        : {}),
                }
                : null;

            // Check session validity using cache
            const isValid = await activityCache.isSessionValid(sid, userId);
            if (!isValid) {
                return;
            }

            // Queue database update (will only update if time difference is significant)
            activityCache.queueSessionUpdate(sid, t);

            // Emit session activity update
            const sessionActivity = buildSessionActivityEphemeral(sid, true, t, thinking || false, activity);
            eventRouter.emitEphemeral({
                userId,
                payload: sessionActivity,
                recipientFilter: { type: 'user-scoped-only' }
            });
        } catch (error) {
            log({ module: 'websocket', level: 'error' }, `Error in session-alive: ${error}`);
        }
    });

    socket.on('session-stream', async (data: { sid?: unknown; payload?: unknown }) => {
        try {
            if (typeof data?.sid !== 'string' || typeof data.payload !== 'string' || data.payload.length > 1_500_000) {
                return;
            }
            if (connection.connectionType !== 'session-scoped' || connection.sessionId !== data.sid) {
                return;
            }
            const isValid = await activityCache.isSessionValid(data.sid, userId);
            if (!isValid) return;
            eventRouter.emitEphemeral({
                userId,
                payload: { type: 'session-stream', id: data.sid, payload: data.payload },
                recipientFilter: { type: 'user-scoped-only' },
            });
        } catch (error) {
            log({ module: 'websocket', level: 'error' }, `Error in session-stream: ${error}`);
        }
    });

    const receiveMessageLock = new AsyncLock();
    socket.on('message', async (data: any) => {
        await receiveMessageLock.inLock(async () => {
            try {
                websocketEventsCounter.inc({ event_type: 'message', ...labels });
                const { sid, message, localId } = data;
                if (typeof sid !== 'string' || typeof message !== 'string') return;
                const role: MessageRoleHint | undefined = ['user', 'agent', 'system'].includes(data.role) ? data.role : undefined;

                log({ module: 'websocket' }, `Received message from socket ${socket.id}: sessionId=${sid}, messageLength=${message.length} bytes, connectionType=${connection.connectionType}, connectionSessionId=${connection.connectionType === 'session-scoped' ? connection.sessionId : 'N/A'}`);

                // Resolve session
                const session = await db.session.findUnique({
                    where: { id: sid, accountId: userId }
                });
                if (!session) {
                    return;
                }
                let useLocalId = typeof localId === 'string' ? localId : null;

                // Create encrypted message
                const msgContent: PrismaJson.SessionMessageContent = {
                    t: 'encrypted',
                    c: message
                };

                const accepted = await db.$transaction(async (tx) => {
                    // Allocate and index in one transaction. Duplicate retries
                    // never advance the human question clock or watermark.
                    if (useLocalId) {
                        const existing = await tx.sessionMessage.findFirst({
                            where: { sessionId: sid, localId: useLocalId },
                        });
                        if (existing) return null;
                    }
                    const [seq] = await allocateSessionSeqBatch(sid, 1, tx);
                    const msg = await tx.sessionMessage.create({
                        data: { sessionId: sid, seq, content: msgContent, localId: useLocalId },
                    });
                    const questionIndex = await indexAcceptedMessage(tx, sid, msg, role);
                    return { msg, questionIndex };
                });
                if (!accepted) return;
                const { msg, questionIndex } = accepted;

                // Emit new message update to relevant clients
                const updSeq = await allocateUserSeq(userId);
                const updatePayload = buildNewMessageUpdate(msg, sid, updSeq, randomKeyNaked(12));
                eventRouter.emitUpdate({
                    userId,
                    payload: updatePayload,
                    recipientFilter: { type: 'all-interested-in-session', sessionId: sid },
                    skipSenderConnection: connection
                });
                if (questionIndex) await emitQuestionIndex(userId, sid, questionIndex);
            } catch (error) {
                log({ module: 'websocket', level: 'error' }, `Error in message handler: ${error}`);
            }
        });
    });

    socket.on('session-end', async (data: {
        sid: string;
        time: number;
    }) => {
        try {
            const { sid, time } = data;
            let t = time;
            if (typeof t !== 'number') {
                return;
            }
            if (t > Date.now()) {
                t = Date.now();
            }
            if (t < Date.now() - 1000 * 60 * 10) { // Ignore if time is in the past 10 minutes
                return;
            }

            // Resolve session
            const session = await db.session.findUnique({
                where: { id: sid, accountId: userId }
            });
            if (!session) {
                return;
            }

            // Update last active at
            const updateResult = await db.session.updateMany({
                where: { id: sid, accountId: userId },
                data: { lastActiveAt: new Date(t), active: false }
            });
            if (updateResult.count === 0) {
                return;
            }

            // Emit session activity update
            const sessionActivity = buildSessionActivityEphemeral(sid, false, t, false);
            eventRouter.emitEphemeral({
                userId,
                payload: sessionActivity,
                recipientFilter: { type: 'user-scoped-only' }
            });
        } catch (error) {
            log({ module: 'websocket', level: 'error' }, `Error in session-end: ${error}`);
        }
    });

}
