import { db } from '@/storage/db';
import { z } from 'zod';
import type { Fastify } from '../types';

const PAGE_BYTES = 256 * 1024;
const CIPHER_BYTES = 48 * 1024;
const sequence = z.number().int().min(1).max(2_147_483_647);
const chunkSchema = z.object({
    seq: sequence,
    part: z.number().int().min(0).max(2_147_483_646),
    parts: sequence,
    content: z.string().min(1).max(CIPHER_BYTES).regex(/^[A-Za-z0-9+/]+={0,2}$/),
}).strict().refine(chunk => chunk.part < chunk.parts, 'Invalid chunk index');
const epochParams = z.object({ sessionId: z.string().min(1).max(256), epoch: z.string().uuid() });

class ConflictingChunk extends Error {}

/** Only the owner may read/write opaque ciphertext. Never broadcast raw diagnostics as messages. */
export function sessionProtocolRoutes(app: Fastify) {
    app.get('/v1/sessions/:sessionId/protocol/epochs', {
        preHandler: app.authenticate,
        schema: {
            params: z.object({ sessionId: z.string().min(1).max(256) }),
            querystring: z.object({
                before_at: z.coerce.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
                before_epoch: z.string().uuid().optional(),
                limit: z.coerce.number().int().min(1).max(20).default(10),
            }).refine(q => (q.before_at === undefined) === (q.before_epoch === undefined), 'Incomplete epoch cursor'),
        },
    }, async (request, reply) => {
        const { sessionId } = request.params;
        if (!await db.session.findFirst({ where: { id: sessionId, accountId: request.userId }, select: { id: true } })) {
            return reply.code(404).send({ error: 'Session not found' });
        }
        const { before_at, before_epoch, limit } = request.query;
        const rows = await db.sessionProtocolEpoch.findMany({
            where: { sessionId, ...(before_at !== undefined ? { OR: [
                { epochStartedAt: { lt: before_at } },
                { epochStartedAt: before_at, epoch: { lt: before_epoch } },
            ] } : {}) },
            orderBy: [{ epochStartedAt: 'desc' }, { epoch: 'desc' }],
            take: limit + 1,
            select: { epoch: true, epochStartedAt: true, lastSeq: true },
        });
        reply.header('Cache-Control', 'no-store');
        const epochs = rows.slice(0, limit);
        const last = epochs.at(-1);
        return { epochs, nextCursor: rows.length > limit && last ? { before_at: last.epochStartedAt, before_epoch: last.epoch } : null };
    });

    app.post('/v1/sessions/:sessionId/protocol/:epoch/chunks', {
        preHandler: app.authenticate,
        bodyLimit: PAGE_BYTES,
        schema: {
            params: epochParams,
            body: z.object({
                epochStartedAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
                chunks: z.array(chunkSchema).min(1).max(32),
            }).strict(),
        },
    }, async (request, reply) => {
        const { sessionId, epoch } = request.params;
        if (!await db.session.findFirst({ where: { id: sessionId, accountId: request.userId }, select: { id: true } })) {
            return reply.code(404).send({ error: 'Session not found' });
        }
        const { chunks, epochStartedAt } = request.body;
        const unique = new Map<string, typeof chunks[number]>();
        for (const chunk of chunks) {
            const key = `${chunk.seq}:${chunk.part}`;
            const previous = unique.get(key);
            if (previous && (previous.content !== chunk.content || previous.parts !== chunk.parts)) {
                return reply.code(409).send({ error: 'Conflicting protocol chunk' });
            }
            unique.set(key, chunk);
        }
        try {
            await db.$transaction(async tx => {
                const record = await tx.sessionProtocolEpoch.upsert({
                    where: { sessionId_epoch: { sessionId, epoch } },
                    create: { sessionId, epoch, epochStartedAt }, update: {},
                });
                if (record.epochStartedAt !== epochStartedAt) throw new ConflictingChunk();
                await tx.sessionProtocolChunk.createMany({
                    data: [...unique.values()].map(chunk => ({ sessionId, epoch, ...chunk })), skipDuplicates: true,
                });
                const persisted = await tx.sessionProtocolChunk.findMany({
                    where: { sessionId, epoch, OR: [...unique.values()].map(({ seq, part }) => ({ seq, part })) },
                });
                for (const chunk of persisted) {
                    const sent = unique.get(`${chunk.seq}:${chunk.part}`)!;
                    if (chunk.content !== sent.content || chunk.parts !== sent.parts) throw new ConflictingChunk();
                }
                const lastSeq = Math.max(...chunks.map(chunk => chunk.seq));
                await tx.sessionProtocolEpoch.updateMany({
                    where: { sessionId, epoch, lastSeq: { lt: lastSeq } }, data: { lastSeq },
                });
            });
        } catch (error) {
            if (error instanceof ConflictingChunk) return reply.code(409).send({ error: 'Conflicting protocol chunk' });
            throw error;
        }
        return { accepted: [...unique.values()].map(({ seq, part }) => ({ seq, part })) };
    });

    app.get('/v1/sessions/:sessionId/protocol/:epoch/chunks', {
        preHandler: app.authenticate,
        schema: {
            params: epochParams,
            querystring: z.object({
                after_seq: z.coerce.number().int().min(0).max(2_147_483_647).default(0),
                after_part: z.coerce.number().int().min(-1).max(2_147_483_646).default(-1),
                limit: z.coerce.number().int().min(1).max(32).default(32),
            }),
        },
    }, async (request, reply) => {
        const { sessionId, epoch } = request.params;
        if (!await db.session.findFirst({ where: { id: sessionId, accountId: request.userId }, select: { id: true } })) {
            return reply.code(404).send({ error: 'Session not found' });
        }
        const { after_seq, after_part, limit } = request.query;
        // A fixed row and per-row byte cap bounds DB materialization as well as HTTP size.
        const rows = await db.sessionProtocolChunk.findMany({
            where: { sessionId, epoch, OR: [{ seq: { gt: after_seq } }, { seq: after_seq, part: { gt: after_part } }] },
            orderBy: [{ seq: 'asc' }, { part: 'asc' }], take: limit + 1,
            select: { seq: true, part: true, parts: true, content: true },
        });
        const chunks: typeof rows = [];
        let bytes = 512; // Response cursor/envelope budget.
        for (const row of rows) {
            const size = Buffer.byteLength(JSON.stringify(row)) + 1;
            if (chunks.length >= limit || bytes + size > PAGE_BYTES) break;
            chunks.push(row);
            bytes += size;
        }
        const last = chunks.at(-1);
        reply.header('Cache-Control', 'no-store');
        return { chunks, hasMore: rows.length > chunks.length, cursor: last ? { after_seq: last.seq, after_part: last.part } : { after_seq, after_part } };
    });
}
