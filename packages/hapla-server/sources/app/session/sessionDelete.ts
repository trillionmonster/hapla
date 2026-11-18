import { Context } from "@/context";
import { inTx, afterTx } from "@/storage/inTx";
import { eventRouter, buildDeleteSessionUpdate } from "@/app/events/eventRouter";
import { allocateUserSeq } from "@/storage/seq";
import { randomKeyNaked } from "@/utils/randomKeyNaked";
import { log } from "@/utils/log";
import { activityCache } from "@/app/presence/sessionCache";

/**
 * Delete a session and all its related data.
 * Handles:
 * - Deleting all session messages
 * - Deleting all usage reports for the session
 * - Deleting all access keys for the session
 * - Deleting the session itself
 * - Sending socket notification to all connected clients
 * 
 * @param ctx - Context with user information
 * @param sessionId - ID of the session to delete
 * @returns true if deletion was successful, false if session not found or not owned by user
 */
export async function sessionDelete(ctx: Context, sessionId: string): Promise<boolean> {
    const deletedCount = await sessionDeleteMany(ctx, [sessionId]);
    return deletedCount === 1;
}

/**
 * Delete a logical conversation and every runtime attached to it in one
 * transaction. Unlike the legacy batch endpoint, callers cannot accidentally
 * omit an older runtime: membership is resolved by the database index.
 */
export async function conversationDelete(ctx: Context, conversationId: string): Promise<number | null> {
    return await inTx(async (tx) => {
        const conversation = await tx.conversation.findFirst({
            where: { id: conversationId, accountId: ctx.uid },
            select: { id: true },
        });
        if (!conversation) return null;

        const sessions = await tx.session.findMany({
            where: { conversationId, accountId: ctx.uid },
            select: { id: true },
        });
        const sessionIds = sessions.map((session) => session.id);

        if (sessionIds.length > 0) {
            await tx.sessionMessage.deleteMany({ where: { sessionId: { in: sessionIds } } });
            await tx.usageReport.deleteMany({ where: { sessionId: { in: sessionIds } } });
            await tx.accessKey.deleteMany({ where: { sessionId: { in: sessionIds } } });
            await tx.session.deleteMany({
                where: { conversationId, accountId: ctx.uid },
            });
        }
        await tx.conversation.delete({ where: { id: conversationId } });

        log({
            module: 'conversation-delete',
            userId: ctx.uid,
            conversationId,
            deletedCount: sessionIds.length,
        }, `Logical conversation deleted atomically`);

        afterTx(tx, () => {
            for (const sessionId of sessionIds) activityCache.removeSession(sessionId);
            void (async () => {
                for (const sessionId of sessionIds) {
                    const updSeq = await allocateUserSeq(ctx.uid);
                    const updatePayload = buildDeleteSessionUpdate(sessionId, updSeq, randomKeyNaked(12));
                    eventRouter.emitUpdate({
                        userId: ctx.uid,
                        payload: updatePayload,
                        recipientFilter: { type: 'user-scoped-only' }
                    });
                }
            })();
        });

        return sessionIds.length;
    });
}

/**
 * Atomically delete every runtime record represented by one logical conversation.
 * The caller resolves the encrypted conversation relationship and supplies the IDs;
 * the server verifies ownership of the complete set before deleting anything.
 */
export async function sessionDeleteMany(ctx: Context, requestedSessionIds: string[]): Promise<number | null> {
    const sessionIds = Array.from(new Set(requestedSessionIds));
    if (sessionIds.length === 0) return 0;

    return await inTx(async (tx) => {
        const ownedSessions = await tx.session.findMany({
            where: {
                id: { in: sessionIds },
                accountId: ctx.uid
            },
            select: { id: true }
        });

        if (ownedSessions.length !== sessionIds.length) {
            log({ 
                module: 'session-delete', 
                userId: ctx.uid, 
                requestedCount: sessionIds.length,
                ownedCount: ownedSessions.length,
            }, `Conversation delete rejected because one or more sessions are missing or not owned by user`);
            return null;
        }

        // Delete all related data
        // Note: Order matters to avoid foreign key constraint violations
        
        // 1. Delete session messages
        const deletedMessages = await tx.sessionMessage.deleteMany({
            where: { sessionId: { in: sessionIds } }
        });
        log({ 
            module: 'session-delete', 
            userId: ctx.uid, 
            sessionIds,
            deletedCount: deletedMessages.count
        }, `Deleted ${deletedMessages.count} session messages`);

        // 2. Delete usage reports
        const deletedReports = await tx.usageReport.deleteMany({
            where: { sessionId: { in: sessionIds } }
        });
        log({ 
            module: 'session-delete', 
            userId: ctx.uid, 
            sessionIds,
            deletedCount: deletedReports.count
        }, `Deleted ${deletedReports.count} usage reports`);

        // 3. Delete access keys
        const deletedAccessKeys = await tx.accessKey.deleteMany({
            where: { sessionId: { in: sessionIds } }
        });
        log({ 
            module: 'session-delete', 
            userId: ctx.uid, 
            sessionIds,
            deletedCount: deletedAccessKeys.count
        }, `Deleted ${deletedAccessKeys.count} access keys`);

        // 4. Delete the session itself
        const deletedSessions = await tx.session.deleteMany({
            where: {
                id: { in: sessionIds },
                accountId: ctx.uid,
            }
        });
        log({ 
            module: 'session-delete', 
            userId: ctx.uid, 
            sessionIds,
            deletedCount: deletedSessions.count,
        }, `Conversation runtime records deleted successfully`);

        // Send notification after transaction commits
        afterTx(tx, () => {
            for (const sessionId of sessionIds) activityCache.removeSession(sessionId);
            void (async () => {
                for (const sessionId of sessionIds) {
                    const updSeq = await allocateUserSeq(ctx.uid);
                    const updatePayload = buildDeleteSessionUpdate(sessionId, updSeq, randomKeyNaked(12));

                    eventRouter.emitUpdate({
                        userId: ctx.uid,
                        payload: updatePayload,
                        recipientFilter: { type: 'user-scoped-only' }
                    });
                }
            })();
        });

        return deletedSessions.count;
    });
}
