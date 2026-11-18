import { PGlite } from '@electric-sql/pglite';
import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Prisma } from '@prisma/client';

vi.mock('@/app/events/eventRouter', () => ({ eventRouter: {}, buildUpdateSessionUpdate: vi.fn() }));
vi.mock('@/storage/seq', () => ({ allocateUserSeq: vi.fn() }));
vi.mock('@/utils/randomKeyNaked', () => ({ randomKeyNaked: vi.fn() }));

import { backfillQuestionIndex, indexAcceptedMessage, questionIndexResponse } from './sessionQuestionIndex';

describe('persisted last human question index', () => {
    let pg: PGlite;
    const tx = {
        async $queryRaw(strings: TemplateStringsArray, ...parameters: unknown[]) {
            const sql = strings.reduce((query, part, index) => query + (index ? `$${index}` : '') + part, '');
            return (await pg.query(sql, parameters)).rows;
        },
    } as unknown as Prisma.TransactionClient;

    beforeAll(async () => {
        pg = new PGlite();
        await pg.exec(`
            CREATE TABLE "Session" ("id" TEXT PRIMARY KEY, "accountId" TEXT NOT NULL, "seq" INTEGER NOT NULL,
                "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT '2020-01-01');
            CREATE TABLE "SessionMessage" ("id" TEXT PRIMARY KEY, "sessionId" TEXT NOT NULL,
                "seq" INTEGER NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL);
            INSERT INTO "Session" ("id", "accountId", "seq") VALUES ('legacy', 'a', 8);`);
        const migration = await readFile('prisma/migrations/20260911120000_add_last_user_message_index/migration.sql', 'utf8');
        await pg.exec(migration);
    });
    afterAll(async () => pg?.close());
    beforeEach(async () => {
        await pg.exec(`DELETE FROM "SessionMessage"; DELETE FROM "Session" WHERE "id" <> 'legacy';
            INSERT INTO "Session" ("id", "accountId", "seq") VALUES ('s', 'a', 5), ('foreign', 'b', 5);
            INSERT INTO "SessionMessage" VALUES
                ('old-user', 's', 1, '2026-01-01T00:00:01'),
                ('latest-user', 's', 4, '2026-01-01T00:00:04'),
                ('foreign-message', 'foreign', 1, '2026-01-01T00:00:05');`);
    });

    it('migrates existing sessions without inventing an activity timestamp', async () => {
        expect((await pg.query('SELECT "lastUserMessageAt", "lastUserMessageIndexedSeq" FROM "Session" WHERE "id"=\'legacy\'')).rows)
            .toEqual([{ lastUserMessageAt: null, lastUserMessageIndexedSeq: 0 }]);
    });

    it('indexes a human question using its accepted time, and keeps that time through agent/system output', async () => {
        const acceptedAt = new Date('2026-01-01T00:00:04Z');
        const user = await indexAcceptedMessage(tx, 's', { seq: 4, createdAt: acceptedAt }, 'user');
        expect(questionIndexResponse(user!)).toEqual({ lastUserMessageAt: acceptedAt.getTime(), lastUserMessageIndexedSeq: 4 });
        const agent = await indexAcceptedMessage(tx, 's', { seq: 5, createdAt: new Date('2027-01-01') }, 'agent');
        const system = await indexAcceptedMessage(tx, 's', { seq: 6, createdAt: new Date('2028-01-01') }, 'system');
        expect(agent?.lastUserMessageAt).toEqual(acceptedAt);
        expect(system?.lastUserMessageAt).toEqual(acceptedAt);
        expect(system?.lastUserMessageIndexedSeq).toBe(6);
        expect((await pg.query<{ updatedAt: Date }>('SELECT "updatedAt" FROM "Session" WHERE "id"=\'s\'')).rows[0].updatedAt)
            .toEqual(new Date('2020-01-01'));
    });

    it('does not skip unknown legacy messages when extending the scanned prefix', async () => {
        expect(await indexAcceptedMessage(tx, 's', { seq: 1, createdAt: new Date() }, undefined)).toBeNull();
        expect(await indexAcceptedMessage(tx, 's', { seq: 2, createdAt: new Date() }, 'agent')).toBeNull();
        expect(await indexAcceptedMessage(tx, 's', { seq: 3, createdAt: new Date() }, 'system')).toBeNull();
        const complete = await backfillQuestionIndex(tx, 'a', 's', { messageId: 'old-user', scannedThroughSeq: 3 });
        expect(complete.lastUserMessageIndexedSeq).toBe(3);
        expect((await indexAcceptedMessage(tx, 's', { seq: 4, createdAt: new Date() }, 'agent'))?.lastUserMessageIndexedSeq).toBe(4);
    });

    it('backfills only persisted own-message timestamps and never regresses on stale concurrent scans', async () => {
        const fresh = await backfillQuestionIndex(tx, 'a', 's', { messageId: 'latest-user', scannedThroughSeq: 5 });
        await Promise.all([
            backfillQuestionIndex(tx, 'a', 's', { messageId: 'old-user', scannedThroughSeq: 2 }),
            backfillQuestionIndex(tx, 'a', 's', { messageId: null, scannedThroughSeq: 3 }),
        ]);
        const final = await backfillQuestionIndex(tx, 'a', 's', { messageId: null, scannedThroughSeq: 5 });
        expect(final).toEqual(fresh);
        expect(questionIndexResponse(final)).toEqual({ lastUserMessageAt: Date.parse('2026-01-01T00:00:04Z'), lastUserMessageIndexedSeq: 5 });
    });

    it('rejects foreign sessions, foreign messages and impossible scan bounds', async () => {
        await expect(backfillQuestionIndex(tx, 'a', 'foreign', { messageId: null, scannedThroughSeq: 1 })).rejects.toMatchObject({ statusCode: 404 });
        await expect(backfillQuestionIndex(tx, 'a', 's', { messageId: 'foreign-message', scannedThroughSeq: 5 })).rejects.toMatchObject({ statusCode: 404 });
        await expect(backfillQuestionIndex(tx, 'a', 's', { messageId: null, scannedThroughSeq: 6 })).rejects.toMatchObject({ statusCode: 400 });
        await expect(backfillQuestionIndex(tx, 'a', 's', { messageId: 'latest-user', scannedThroughSeq: 3 })).rejects.toMatchObject({ statusCode: 400 });
    });

    it('distinguishes a fully scanned conversation with no human questions from an unscanned conversation', async () => {
        expect(questionIndexResponse(await backfillQuestionIndex(tx, 'a', 's', { messageId: null, scannedThroughSeq: 5 })))
            .toEqual({ lastUserMessageAt: null, lastUserMessageIndexedSeq: 5 });
    });
});
