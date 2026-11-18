import fastify from 'fastify';
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from 'fastify-type-provider-zod';
import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { PrismaPGlite } from 'pglite-prisma-adapter';
import { PrismaClient } from '@prisma/client';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import type { Fastify } from '../types';

const state = vi.hoisted(() => ({ client: null as any }));
vi.mock('@/storage/db', () => ({ db: new Proxy({}, { get: (_, key) => {
    const value = state.client[key];
    return typeof value === 'function' ? value.bind(state.client) : value;
} }) }));
import { sessionProtocolRoutes } from './sessionProtocolRoutes';

describe('encrypted protocol journal HTTP persistence', () => {
    let pg: PGlite;
    let app: Fastify;
    const epoch = randomUUID();
    const base = `/v1/sessions/s1/protocol/${epoch}/chunks`;
    const headers = { 'x-user-id': 'owner' };
    const chunk = (seq: number, part = 0, parts = 1, content = 'Y2lwaGVydGV4dA==') => ({ seq, part, parts, content });
    const send = (chunks: ReturnType<typeof chunk>[]) => app.inject({ method: 'POST', url: base, headers, payload: { epochStartedAt: 100, chunks } });
    beforeAll(async () => {
        pg = new PGlite();
        await pg.exec('CREATE TABLE "Session" ("id" TEXT PRIMARY KEY, "accountId" TEXT NOT NULL);');
        await pg.exec(await readFile(resolve('prisma/migrations/20260909100000_add_session_protocol_journal/migration.sql'), 'utf8'));
        state.client = new PrismaClient({ adapter: new PrismaPGlite(pg) } as any);
        const raw = fastify();
        raw.setValidatorCompiler(validatorCompiler);
        raw.setSerializerCompiler(serializerCompiler);
        app = raw.withTypeProvider<ZodTypeProvider>() as unknown as Fastify;
        app.decorate('authenticate', async (request: any, reply: any) => {
            if (!request.headers['x-user-id']) return reply.code(401).send({ error: 'Unauthorized' });
            request.userId = request.headers['x-user-id'];
        });
        sessionProtocolRoutes(app);
        await app.ready();
    }, 30_000);
    beforeEach(async () => {
        await pg.exec('DELETE FROM "Session"; INSERT INTO "Session" VALUES (\'s1\', \'owner\');');
    });
    afterAll(async () => { await app?.close(); await state.client?.$disconnect(); await pg?.close(); });

    it('enforces authentication/ownership on both reads and writes', async () => {
        for (const method of ['GET', 'POST'] as const) {
            const payload = method === 'POST' ? { epochStartedAt: 100, chunks: [chunk(1)] } : undefined;
            expect((await app.inject({ method, url: base, payload })).statusCode).toBe(401);
            expect((await app.inject({ method, url: base, headers: { 'x-user-id': 'stranger' }, payload })).statusCode).toBe(404);
        }
        expect((await app.inject({ method: 'GET', url: '/v1/sessions/s1/protocol/epochs', headers: { 'x-user-id': 'stranger' } })).statusCode).toBe(404);
    });

    it('persists idempotently, rejects conflicting ciphertext, and cascades session deletion', async () => {
        expect((await send([chunk(1), chunk(2)])).statusCode).toBe(200);
        expect((await send([chunk(1), chunk(2)])).statusCode).toBe(200);
        expect(await state.client.sessionProtocolChunk.count()).toBe(2);
        expect((await send([chunk(1, 0, 1, 'Y29uZmxpY3Q=')])).statusCode).toBe(409);
        expect((await send([chunk(3), chunk(2, 0, 1, 'Y29uZmxpY3Q=')])).statusCode).toBe(409);
        expect(await state.client.sessionProtocolChunk.count()).toBe(2); // Whole conflicting transaction rolls back.
        await pg.exec('DELETE FROM "Session";');
        expect(await state.client.sessionProtocolChunk.count()).toBe(0);
        expect(await state.client.sessionProtocolEpoch.count()).toBe(0);
    });

    it('paginates by seq/part with a hard byte bound and no omissions', async () => {
        const content = 'Y'.repeat(48 * 1024);
        for (let part = 0; part < 12; part++) expect((await send([chunk(1, part, 12, content)])).statusCode).toBe(200);
        expect((await send([chunk(2)])).statusCode).toBe(200);
        const seen: string[] = [];
        let cursor = { after_seq: 0, after_part: -1 };
        let more = true;
        while (more) {
            const response = await app.inject({ method: 'GET', url: `${base}?after_seq=${cursor.after_seq}&after_part=${cursor.after_part}`, headers });
            expect(response.rawPayload.length).toBeLessThanOrEqual(256 * 1024);
            const page = response.json();
            seen.push(...page.chunks.map((c: any) => `${c.seq}:${c.part}`));
            cursor = page.cursor;
            more = page.hasMore;
        }
        expect(seen).toEqual([...Array.from({ length: 12 }, (_, part) => `1:${part}`), '2:0']);
        const epochs = (await app.inject({ method: 'GET', url: '/v1/sessions/s1/protocol/epochs', headers })).json();
        expect(epochs.epochs).toEqual([{ epoch, epochStartedAt: 100, lastSeq: 2 }]);
    });

    it('rejects oversized writes and invalid cursors', async () => {
        expect((await send([chunk(1, 1, 1)])).statusCode).toBe(400);
        expect((await send([chunk(1, 0, 1, 'A'.repeat(49 * 1024))])).statusCode).toBe(400);
        expect((await app.inject({ method: 'GET', url: `${base}?limit=33`, headers })).statusCode).toBe(400);
        expect((await app.inject({ method: 'GET', url: '/v1/sessions/s1/protocol/epochs?before_at=100', headers })).statusCode).toBe(400);
    });
});
