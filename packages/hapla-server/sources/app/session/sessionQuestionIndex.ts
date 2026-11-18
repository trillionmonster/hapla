import type { Prisma } from '@prisma/client';
import { buildUpdateSessionUpdate, eventRouter } from '@/app/events/eventRouter';
import { allocateUserSeq } from '@/storage/seq';
import { randomKeyNaked } from '@/utils/randomKeyNaked';

export type MessageRoleHint = 'user' | 'agent' | 'system';
export type SessionQuestionIndex = {
    lastUserMessageAt: Date | null;
    lastUserMessageIndexedSeq: number;
};
type IndexClient = Pick<Prisma.TransactionClient, '$queryRaw'>;

export function questionIndexResponse(index: SessionQuestionIndex) {
    return {
        lastUserMessageAt: index.lastUserMessageAt?.getTime() ?? null,
        lastUserMessageIndexedSeq: index.lastUserMessageIndexedSeq,
    };
}

/** Called in the transaction that accepted the message. The encrypted payload
 * stays opaque: the authenticated author supplies only a role hint. */
export async function indexAcceptedMessage(
    tx: IndexClient,
    sessionId: string,
    message: { seq: number; createdAt: Date },
    role: MessageRoleHint | undefined,
): Promise<SessionQuestionIndex | null> {
    if (!role) return null;
    // A known human question makes all earlier unknown messages irrelevant to
    // finding the last question. Agent/system messages only extend a complete
    // prefix, so old clients cannot accidentally hide unindexed questions.
    const rows = role === 'user'
        ? await tx.$queryRaw<SessionQuestionIndex[]>`
            UPDATE "Session" SET
                "lastUserMessageAt" = GREATEST("lastUserMessageAt", ${message.createdAt}),
                "lastUserMessageIndexedSeq" = GREATEST("lastUserMessageIndexedSeq", ${message.seq})
            WHERE "id" = ${sessionId}
            RETURNING "lastUserMessageAt", "lastUserMessageIndexedSeq"`
        : await tx.$queryRaw<SessionQuestionIndex[]>`
            UPDATE "Session" SET "lastUserMessageIndexedSeq" = ${message.seq}
            WHERE "id" = ${sessionId}
                AND "lastUserMessageIndexedSeq" = ${message.seq - 1}
            RETURNING "lastUserMessageAt", "lastUserMessageIndexedSeq"`;
    return rows[0] ?? null;
}

export class QuestionIndexInputError extends Error {
    constructor(public statusCode: 400 | 404, message: string) { super(message); }
}

/** The browser decrypts history without mounting it, then reports a message id.
 * Resolve that id under the account and use its persisted timestamp. The row
 * lock serializes this with message sequence allocation and other backfills. */
export async function backfillQuestionIndex(
    tx: IndexClient,
    accountId: string,
    sessionId: string,
    input: { messageId: string | null; scannedThroughSeq: number },
): Promise<SessionQuestionIndex> {
    const sessions = await tx.$queryRaw<Array<{ seq: number }>>`
        SELECT "seq" FROM "Session"
        WHERE "id" = ${sessionId} AND "accountId" = ${accountId}
        FOR UPDATE`;
    if (!sessions[0]) throw new QuestionIndexInputError(404, 'Session not found');
    if (input.scannedThroughSeq > sessions[0].seq) {
        throw new QuestionIndexInputError(400, 'Scan exceeds the session message sequence');
    }

    let questionAt: Date | null = null;
    if (input.messageId !== null) {
        const messages = await tx.$queryRaw<Array<{ createdAt: Date; seq: number }>>`
            SELECT "createdAt", "seq" FROM "SessionMessage"
            WHERE "id" = ${input.messageId} AND "sessionId" = ${sessionId}`;
        if (!messages[0]) throw new QuestionIndexInputError(404, 'Message not found');
        if (messages[0].seq > input.scannedThroughSeq) {
            throw new QuestionIndexInputError(400, 'Message is outside the scanned sequence');
        }
        questionAt = messages[0].createdAt;
    }

    const rows = await tx.$queryRaw<SessionQuestionIndex[]>`
        UPDATE "Session" SET
            "lastUserMessageAt" = GREATEST("lastUserMessageAt", ${questionAt}::timestamp),
            "lastUserMessageIndexedSeq" = GREATEST("lastUserMessageIndexedSeq", ${input.scannedThroughSeq})
        WHERE "id" = ${sessionId} AND "accountId" = ${accountId}
        RETURNING "lastUserMessageAt", "lastUserMessageIndexedSeq"`;
    return rows[0];
}

export async function emitQuestionIndex(userId: string, sessionId: string, index: SessionQuestionIndex) {
    const seq = await allocateUserSeq(userId);
    eventRouter.emitUpdate({
        userId,
        payload: buildUpdateSessionUpdate(sessionId, seq, randomKeyNaked(12), undefined, undefined, questionIndexResponse(index)),
        recipientFilter: { type: 'all-interested-in-session', sessionId },
    });
}
