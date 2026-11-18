import { eventRouter, buildNewSessionUpdate, buildSessionActivityEphemeral } from "@/app/events/eventRouter";
import { type Fastify } from "../types";
import { db } from "@/storage/db";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { log } from "@/utils/log";
import { randomKeyNaked } from "@/utils/randomKeyNaked";
import { allocateUserSeq } from "@/storage/seq";
import { conversationDelete, sessionDelete, sessionDeleteMany } from "@/app/session/sessionDelete";
import { SESSION_IDLE_TIMEOUT_MS } from "@/app/presence/timeout";
import { inTx } from "@/storage/inTx";
import { randomUUID } from "node:crypto";
import { backfillQuestionIndex, emitQuestionIndex, QuestionIndexInputError, questionIndexResponse } from '@/app/session/sessionQuestionIndex';

export function sessionRoutes(app: Fastify) {

    app.post('/v1/sessions/:id/last-user-message', {
        preHandler: app.authenticate,
        schema: {
            params: z.object({ id: z.string().min(1) }),
            body: z.object({
                messageId: z.string().min(1).nullable(),
                scannedThroughSeq: z.number().int().min(0).max(2_147_483_647),
            }),
        },
    }, async (request, reply) => {
        try {
            const index = await inTx((tx) => backfillQuestionIndex(tx, request.userId, request.params.id, request.body));
            await emitQuestionIndex(request.userId, request.params.id, index);
            return reply.send(questionIndexResponse(index));
        } catch (error) {
            if (error instanceof QuestionIndexInputError) return reply.code(error.statusCode).send({ error: error.message });
            throw error;
        }
    });

    const deleteConversationBodySchema = z.object({
        sessionIds: z.array(z.string().min(1)).min(1).max(10_000)
    });

    const resolveRequestedConversation = async (
        tx: Prisma.TransactionClient,
        userId: string,
        requestedId: string,
    ): Promise<string | null> => {
        const conversation = await tx.conversation.findUnique({
            where: { id: requestedId },
            select: { accountId: true },
        });
        if (conversation) return conversation.accountId === userId ? requestedId : null;

        // A previous daemon version only knows the source runtime id. Resolve
        // it within the authenticated account instead of forcing a daemon
        // restart during rollout.
        const source = await tx.session.findFirst({
            where: { id: requestedId, accountId: userId },
            select: { id: true, conversationId: true },
        });
        if (!source) return null;
        if (source.conversationId) return source.conversationId;

        await tx.conversation.create({ data: { id: requestedId, accountId: userId } });
        await tx.session.update({
            where: { id: source.id },
            data: { conversationId: requestedId },
        });
        return requestedId;
    };

    // Sessions API
    app.get('/v1/sessions', {
        preHandler: app.authenticate,
    }, async (request, reply) => {
        const userId = request.userId;

        const sessions = await db.session.findMany({
            where: { accountId: userId },
            orderBy: { updatedAt: 'desc' },
            take: 150,
            select: {
                id: true,
                conversationId: true,
                seq: true,
                createdAt: true,
                updatedAt: true,
                metadata: true,
                metadataVersion: true,
                agentState: true,
                agentStateVersion: true,
                dataEncryptionKey: true,
                active: true,
                lastActiveAt: true,
                lastUserMessageAt: true,
                lastUserMessageIndexedSeq: true,
                // messages: {
                //     orderBy: { seq: 'desc' },
                //     take: 1,
                //     select: {
                //         id: true,
                //         seq: true,
                //         content: true,
                //         localId: true,
                //         createdAt: true
                //     }
                // }
            }
        });

        return reply.send({
            sessions: sessions.map((v) => {
                // const lastMessage = v.messages[0];
                const sessionUpdatedAt = v.updatedAt.getTime();
                // const lastMessageCreatedAt = lastMessage ? lastMessage.createdAt.getTime() : 0;

                return {
                    id: v.id,
                    conversationId: v.conversationId,
                    seq: v.seq,
                    createdAt: v.createdAt.getTime(),
                    updatedAt: sessionUpdatedAt,
                    active: v.active,
                    activeAt: v.lastActiveAt.getTime(),
                    ...questionIndexResponse(v),
                    metadata: v.metadata,
                    metadataVersion: v.metadataVersion,
                    agentState: v.agentState,
                    agentStateVersion: v.agentStateVersion,
                    dataEncryptionKey: v.dataEncryptionKey ? Buffer.from(v.dataEncryptionKey).toString('base64') : null,
                    lastMessage: null
                };
            })
        });
    });

    // Lightweight, cursor-paginated index used immediately before deletion.
    // Metadata remains end-to-end encrypted: the server only scopes rows to the
    // authenticated account and never attempts to infer conversation identity.
    app.get('/v1/sessions/deletion-scan', {
        preHandler: app.authenticate,
        schema: {
            querystring: z.object({
                cursor: z.string().optional(),
                limit: z.coerce.number().int().min(1).max(200).default(200),
            }).optional(),
        },
    }, async (request, reply) => {
        const { cursor, limit = 200 } = request.query || {};
        const sessions = await db.session.findMany({
            where: {
                accountId: request.userId,
                ...(cursor ? { id: { lt: cursor } } : {}),
            },
            orderBy: { id: 'desc' },
            take: limit + 1,
            select: {
                id: true,
                conversationId: true,
                metadata: true,
                metadataVersion: true,
                dataEncryptionKey: true,
            },
        });
        const hasNext = sessions.length > limit;
        const page = hasNext ? sessions.slice(0, limit) : sessions;

        return reply.send({
            sessions: page.map((session) => ({
                id: session.id,
                conversationId: session.conversationId,
                metadata: session.metadata,
                metadataVersion: session.metadataVersion,
                dataEncryptionKey: session.dataEncryptionKey
                    ? Buffer.from(session.dataEncryptionKey).toString('base64')
                    : null,
            })),
            nextCursor: hasNext ? page.at(-1)?.id ?? null : null,
            hasNext,
        });
    });

    // V2 Sessions API - Active sessions only
    app.get('/v2/sessions/active', {
        preHandler: app.authenticate,
        schema: {
            querystring: z.object({
                limit: z.coerce.number().int().min(1).max(500).default(150)
            }).optional()
        }
    }, async (request, reply) => {
        const userId = request.userId;
        const limit = request.query?.limit || 150;

        const sessions = await db.session.findMany({
            where: {
                accountId: userId,
                active: true,
                lastActiveAt: { gt: new Date(Date.now() - SESSION_IDLE_TIMEOUT_MS) }
            },
            orderBy: { lastActiveAt: 'desc' },
            take: limit,
            select: {
                id: true,
                conversationId: true,
                seq: true,
                createdAt: true,
                updatedAt: true,
                metadata: true,
                metadataVersion: true,
                agentState: true,
                agentStateVersion: true,
                dataEncryptionKey: true,
                active: true,
                lastActiveAt: true,
                lastUserMessageAt: true,
                lastUserMessageIndexedSeq: true,
            }
        });

        return reply.send({
            sessions: sessions.map((v) => ({
                id: v.id,
                conversationId: v.conversationId,
                seq: v.seq,
                createdAt: v.createdAt.getTime(),
                updatedAt: v.updatedAt.getTime(),
                active: v.active,
                activeAt: v.lastActiveAt.getTime(),
                    ...questionIndexResponse(v),
                metadata: v.metadata,
                metadataVersion: v.metadataVersion,
                agentState: v.agentState,
                agentStateVersion: v.agentStateVersion,
                dataEncryptionKey: v.dataEncryptionKey ? Buffer.from(v.dataEncryptionKey).toString('base64') : null,
            }))
        });
    });

    // V2 Sessions API - Cursor-based pagination with change tracking
    app.get('/v2/sessions', {
        preHandler: app.authenticate,
        schema: {
            querystring: z.object({
                cursor: z.string().optional(),
                limit: z.coerce.number().int().min(1).max(200).default(50),
                changedSince: z.coerce.number().int().positive().optional()
            }).optional()
        }
    }, async (request, reply) => {
        const userId = request.userId;
        const { cursor, limit = 50, changedSince } = request.query || {};

        // Decode cursor - simple ID-based cursor
        let cursorSessionId: string | undefined;
        if (cursor) {
            if (cursor.startsWith('cursor_v1_')) {
                cursorSessionId = cursor.substring(10);
            } else {
                return reply.code(400).send({ error: 'Invalid cursor format' });
            }
        }

        // Build where clause
        const where: Prisma.SessionWhereInput = { accountId: userId };

        // Add changedSince filter (just a filter, doesn't affect pagination)
        if (changedSince) {
            where.updatedAt = {
                gt: new Date(changedSince)
            };
        }

        // Add cursor pagination - always by ID descending (most recent first)
        if (cursorSessionId) {
            where.id = {
                lt: cursorSessionId  // Get sessions with ID less than cursor (for desc order)
            };
        }

        // Always sort by ID descending for consistent pagination
        const orderBy = { id: 'desc' as const };

        const sessions = await db.session.findMany({
            where,
            orderBy,
            take: limit + 1, // Fetch one extra to determine if there are more
            select: {
                id: true,
                conversationId: true,
                seq: true,
                createdAt: true,
                updatedAt: true,
                metadata: true,
                metadataVersion: true,
                agentState: true,
                agentStateVersion: true,
                dataEncryptionKey: true,
                active: true,
                lastActiveAt: true,
                lastUserMessageAt: true,
                lastUserMessageIndexedSeq: true,
            }
        });

        // Check if there are more results
        const hasNext = sessions.length > limit;
        const resultSessions = hasNext ? sessions.slice(0, limit) : sessions;

        // Generate next cursor - simple ID-based cursor
        let nextCursor: string | null = null;
        if (hasNext && resultSessions.length > 0) {
            const lastSession = resultSessions[resultSessions.length - 1];
            nextCursor = `cursor_v1_${lastSession.id}`;
        }

        return reply.send({
            sessions: resultSessions.map((v) => ({
                id: v.id,
                conversationId: v.conversationId,
                seq: v.seq,
                createdAt: v.createdAt.getTime(),
                updatedAt: v.updatedAt.getTime(),
                active: v.active,
                activeAt: v.lastActiveAt.getTime(),
                    ...questionIndexResponse(v),
                metadata: v.metadata,
                metadataVersion: v.metadataVersion,
                agentState: v.agentState,
                agentStateVersion: v.agentStateVersion,
                dataEncryptionKey: v.dataEncryptionKey ? Buffer.from(v.dataEncryptionKey).toString('base64') : null,
            })),
            nextCursor,
            hasNext
        });
    });

    // Create or load session by tag
    app.post('/v1/sessions', {
        schema: {
            body: z.object({
                tag: z.string(),
                metadata: z.string(),
                agentState: z.string().nullish(),
                dataEncryptionKey: z.string().nullish(),
                conversationId: z.string().min(1).nullish(),
            })
        },
        preHandler: app.authenticate
    }, async (request, reply) => {
        const userId = request.userId;
        const { tag, metadata, dataEncryptionKey, conversationId: requestedConversationId } = request.body;

        const session = await db.session.findFirst({
            where: {
                accountId: userId,
                tag: tag
            }
        });
        if (session) {
            let conversationId = session.conversationId;
            if (!conversationId) {
                const bound = await inTx(async (tx) => {
                    const resolved = requestedConversationId
                        ? await resolveRequestedConversation(tx, userId, requestedConversationId)
                        : randomUUID();
                    if (!resolved) return null;
                    if (!requestedConversationId) {
                        await tx.conversation.create({ data: { id: resolved, accountId: userId } });
                    }
                    return tx.session.update({
                        where: { id: session.id },
                        data: { conversationId: resolved },
                    });
                });
                if (!bound) {
                    return reply.code(404).send({ error: 'Conversation not found or not owned by user' });
                }
                Object.assign(session, bound);
                conversationId = bound.conversationId;
            }
            log({ module: 'session-create', sessionId: session.id, userId, tag }, `Found existing session: ${session.id} for tag ${tag}`);
            return reply.send({
                session: {
                    id: session.id,
                    conversationId,
                    seq: session.seq,
                    metadata: session.metadata,
                    metadataVersion: session.metadataVersion,
                    agentState: session.agentState,
                    agentStateVersion: session.agentStateVersion,
                    dataEncryptionKey: session.dataEncryptionKey ? Buffer.from(session.dataEncryptionKey).toString('base64') : null,
                    active: session.active,
                    activeAt: session.lastActiveAt.getTime(),
                    ...questionIndexResponse(session),
                    createdAt: session.createdAt.getTime(),
                    updatedAt: session.updatedAt.getTime(),
                    lastMessage: null
                }
            });
        } else {
            const session = await inTx(async (tx) => {
                const conversationId = requestedConversationId
                    ? await resolveRequestedConversation(tx, userId, requestedConversationId)
                    : randomUUID();
                if (!conversationId) return null;
                if (!requestedConversationId) {
                    await tx.conversation.create({ data: { id: conversationId, accountId: userId } });
                }

                return tx.session.create({ data: {
                    accountId: userId,
                    conversationId,
                    tag: tag,
                    metadata: metadata,
                    dataEncryptionKey: dataEncryptionKey ? new Uint8Array(Buffer.from(dataEncryptionKey, 'base64')) : undefined
                } });
            });
            if (!session) {
                return reply.code(404).send({ error: 'Conversation not found or not owned by user' });
            }

            const updSeq = await allocateUserSeq(userId);
            log({ module: 'session-create', userId, tag }, `Creating new session for user ${userId} with tag ${tag}`);
            log({ module: 'session-create', sessionId: session.id, userId }, `Session created: ${session.id}`);

            // Emit new session update
            const updatePayload = buildNewSessionUpdate(session, updSeq, randomKeyNaked(12));
            log({
                module: 'session-create',
                userId,
                sessionId: session.id,
                updateType: 'new-session',
                updatePayload: JSON.stringify(updatePayload)
            }, `Emitting new-session update to user-scoped connections`);
            eventRouter.emitUpdate({
                userId,
                payload: updatePayload,
                recipientFilter: { type: 'user-scoped-only' }
            });

            return reply.send({
                session: {
                    id: session.id,
                    conversationId: session.conversationId,
                    seq: session.seq,
                    metadata: session.metadata,
                    metadataVersion: session.metadataVersion,
                    agentState: session.agentState,
                    agentStateVersion: session.agentStateVersion,
                    dataEncryptionKey: session.dataEncryptionKey ? Buffer.from(session.dataEncryptionKey).toString('base64') : null,
                    active: session.active,
                    activeAt: session.lastActiveAt.getTime(),
                    ...questionIndexResponse(session),
                    createdAt: session.createdAt.getTime(),
                    updatedAt: session.updatedAt.getTime(),
                    lastMessage: null
                }
            });
        }
    });

    // One-time upgrade path for encrypted legacy rows. The browser is the only
    // party able to infer their relationship; after binding, all operations use
    // the indexed conversation id and no longer scan history.
    app.post('/v1/conversations/bind', {
        schema: {
            body: z.object({
                sessionIds: z.array(z.string().min(1)).min(1).max(10_000),
                conversationId: z.string().min(1).nullish(),
            }),
        },
        preHandler: app.authenticate,
    }, async (request, reply) => {
        const sessionIds = Array.from(new Set(request.body.sessionIds));
        const result = await inTx(async (tx) => {
            const sessions = await tx.session.findMany({
                where: { id: { in: sessionIds }, accountId: request.userId },
                select: { id: true, conversationId: true },
            });
            if (sessions.length !== sessionIds.length) return { kind: 'missing' as const };

            const existingIds = new Set(
                sessions.map((session) => session.conversationId).filter((id): id is string => Boolean(id)),
            );
            if (existingIds.size > 1) return { kind: 'conflict' as const };
            const existingId = existingIds.values().next().value as string | undefined;
            if (request.body.conversationId && existingId && request.body.conversationId !== existingId) {
                return { kind: 'conflict' as const };
            }

            const conversationId = existingId ?? request.body.conversationId ?? randomUUID();
            const conversation = await tx.conversation.findUnique({
                where: { id: conversationId },
                select: { accountId: true },
            });
            if (conversation && conversation.accountId !== request.userId) return { kind: 'conflict' as const };
            if (!conversation) {
                await tx.conversation.create({ data: { id: conversationId, accountId: request.userId } });
            }
            await tx.session.updateMany({
                where: { id: { in: sessionIds }, accountId: request.userId, conversationId: null },
                data: { conversationId },
            });
            return { kind: 'ok' as const, conversationId, boundCount: sessionIds.length };
        });

        if (result.kind === 'missing') return reply.code(404).send({ error: 'Session not found' });
        if (result.kind === 'conflict') return reply.code(409).send({ error: 'Conversation identity conflict' });
        return reply.send(result);
    });

    app.delete('/v1/conversations/:conversationId', {
        schema: { params: z.object({ conversationId: z.string().min(1) }) },
        preHandler: app.authenticate,
    }, async (request, reply) => {
        const deletedCount = await conversationDelete(
            { uid: request.userId },
            request.params.conversationId,
        );
        if (deletedCount === null) {
            return reply.code(404).send({ error: 'Conversation not found or not owned by user' });
        }
        return reply.send({ success: true, deletedCount });
    });

    app.get('/v1/sessions/:sessionId/messages', {
        schema: {
            params: z.object({
                sessionId: z.string()
            })
        },
        preHandler: app.authenticate
    }, async (request, reply) => {
        const userId = request.userId;
        const { sessionId } = request.params;

        // Verify session belongs to user
        const session = await db.session.findFirst({
            where: {
                id: sessionId,
                accountId: userId
            }
        });

        if (!session) {
            return reply.code(404).send({ error: 'Session not found' });
        }

        const messages = await db.sessionMessage.findMany({
            where: { sessionId },
            orderBy: { createdAt: 'desc' },
            take: 150,
            select: {
                id: true,
                seq: true,
                localId: true,
                content: true,
                createdAt: true,
                updatedAt: true
            }
        });

        return reply.send({
            messages: messages.map((v) => ({
                id: v.id,
                seq: v.seq,
                content: v.content,
                localId: v.localId,
                createdAt: v.createdAt.getTime(),
                updatedAt: v.updatedAt.getTime()
            }))
        });
    });

    // Archive session (force deactivate)
    app.post('/v1/sessions/:sessionId/archive', {
        schema: {
            params: z.object({
                sessionId: z.string()
            })
        },
        preHandler: app.authenticate
    }, async (request, reply) => {
        const userId = request.userId;
        const { sessionId } = request.params;

        const result = await db.session.updateMany({
            where: { id: sessionId, accountId: userId },
            data: { active: false, lastActiveAt: new Date() }
        });

        if (result.count === 0) {
            return reply.code(404).send({ error: 'Session not found' });
        }

        // Notify all clients about the session deactivation
        const sessionActivity = buildSessionActivityEphemeral(sessionId, false, Date.now(), false);
        eventRouter.emitEphemeral({
            userId,
            payload: sessionActivity,
            recipientFilter: { type: 'user-scoped-only' }
        });

        return reply.send({ success: true });
    });

    // Delete session
    app.post('/v1/sessions/delete', {
        schema: {
            body: deleteConversationBodySchema
        },
        preHandler: app.authenticate
    }, async (request, reply) => {
        const deletedCount = await sessionDeleteMany(
            { uid: request.userId },
            request.body.sessionIds,
        );

        if (deletedCount === null) {
            return reply.code(404).send({ error: 'One or more sessions were not found or not owned by user' });
        }

        return reply.send({ success: true, deletedCount });
    });

    app.delete('/v1/sessions/:sessionId', {
        schema: {
            params: z.object({
                sessionId: z.string()
            })
        },
        preHandler: app.authenticate
    }, async (request, reply) => {
        const userId = request.userId;
        const { sessionId } = request.params;

        const deleted = await sessionDelete({ uid: userId }, sessionId);

        if (!deleted) {
            return reply.code(404).send({ error: 'Session not found or not owned by user' });
        }

        return reply.send({ success: true });
    });
}
