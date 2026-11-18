import fastify from 'fastify';
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from 'fastify-type-provider-zod';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { sessionRoutes } from './sessionRoutes';

const { conversationDeleteMock, sessionDeleteManyMock, sessionFindManyMock, sessionFindFirstMock, txMock } = vi.hoisted(() => ({
    conversationDeleteMock: vi.fn(),
    sessionDeleteManyMock: vi.fn(),
    sessionFindManyMock: vi.fn(),
    sessionFindFirstMock: vi.fn(),
    txMock: {
        session: { findMany: vi.fn(), findFirst: vi.fn(), create: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
        conversation: { findUnique: vi.fn(), create: vi.fn() },
    },
}));

vi.mock('@/app/session/sessionDelete', () => ({
    conversationDelete: conversationDeleteMock,
    sessionDelete: vi.fn(),
    sessionDeleteMany: sessionDeleteManyMock,
}));

vi.mock('@/storage/db', () => ({
    db: { session: { findMany: sessionFindManyMock, findFirst: sessionFindFirstMock } },
}));

vi.mock('@/storage/inTx', () => ({
    inTx: (callback: (tx: typeof txMock) => unknown) => callback(txMock),
    afterTx: vi.fn(),
}));

vi.mock('@/app/events/eventRouter', () => ({
    eventRouter: { emitEphemeral: vi.fn(), emitUpdate: vi.fn() },
    buildNewSessionUpdate: vi.fn(),
    buildSessionActivityEphemeral: vi.fn(),
}));

vi.mock('@/storage/seq', () => ({ allocateUserSeq: vi.fn() }));
vi.mock('@/utils/randomKeyNaked', () => ({ randomKeyNaked: vi.fn() }));
vi.mock('@/utils/log', () => ({ log: vi.fn() }));

async function createApp() {
    const app = fastify().withTypeProvider<ZodTypeProvider>();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    app.decorateRequest('userId', '');
    app.decorate('authenticate', async (request: any, reply: any) => {
        const userId = request.headers['x-user-id'];
        if (!userId) return reply.code(401).send({ error: 'Unauthorized' });
        request.userId = userId;
    });
    sessionRoutes(app as any);
    await app.ready();
    return app;
}

describe('conversation deletion route', () => {
    beforeEach(() => {
        sessionDeleteManyMock.mockReset();
        sessionDeleteManyMock.mockResolvedValue(2);
        conversationDeleteMock.mockReset();
        conversationDeleteMock.mockResolvedValue(3);
        sessionFindManyMock.mockReset();
        sessionFindFirstMock.mockReset();
        txMock.session.findMany.mockReset();
        txMock.session.findFirst.mockReset();
        txMock.session.create.mockReset();
        txMock.session.update.mockReset();
        txMock.session.updateMany.mockReset();
        txMock.conversation.findUnique.mockReset();
        txMock.conversation.create.mockReset();
    });

    it('resolves a source runtime id during daemon rolling upgrades', async () => {
        sessionFindFirstMock.mockResolvedValueOnce(null);
        txMock.conversation.findUnique.mockResolvedValueOnce(null);
        txMock.session.findFirst.mockResolvedValueOnce({
            id: 'source-runtime',
            conversationId: 'durable-conversation',
        });
        txMock.session.create.mockResolvedValueOnce({
            id: 'replacement-runtime',
            conversationId: 'durable-conversation',
            seq: 0,
            metadata: 'cipher',
            metadataVersion: 0,
            agentState: null,
            agentStateVersion: 0,
            dataEncryptionKey: null,
            active: true,
            lastActiveAt: new Date(10),
            createdAt: new Date(10),
            updatedAt: new Date(10),
        });
        const app = await createApp();
        const response = await app.inject({
            method: 'POST',
            url: '/v1/sessions',
            headers: { 'x-user-id': 'owner' },
            payload: {
                tag: 'replacement-tag',
                metadata: 'cipher',
                conversationId: 'source-runtime',
            },
        });

        expect(response.statusCode).toBe(200);
        expect(response.json().session.conversationId).toBe('durable-conversation');
        expect(txMock.session.create).toHaveBeenCalledWith({ data: expect.objectContaining({
            conversationId: 'durable-conversation',
        }) });
        await app.close();
    });

    it('binds encrypted legacy runtimes once to a durable identity', async () => {
        txMock.session.findMany.mockResolvedValueOnce([
            { id: 'legacy-a', conversationId: null },
            { id: 'legacy-b', conversationId: null },
        ]);
        txMock.conversation.findUnique.mockResolvedValueOnce(null);
        txMock.conversation.create.mockResolvedValueOnce({ id: 'conversation-1' });
        txMock.session.updateMany.mockResolvedValueOnce({ count: 2 });
        const app = await createApp();
        const response = await app.inject({
            method: 'POST',
            url: '/v1/conversations/bind',
            headers: { 'x-user-id': 'owner' },
            payload: { sessionIds: ['legacy-a', 'legacy-b'], conversationId: 'conversation-1' },
        });

        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({ kind: 'ok', conversationId: 'conversation-1', boundCount: 2 });
        expect(txMock.session.updateMany).toHaveBeenCalledWith({
            where: {
                id: { in: ['legacy-a', 'legacy-b'] },
                accountId: 'owner',
                conversationId: null,
            },
            data: { conversationId: 'conversation-1' },
        });
        await app.close();
    });

    it('rejects attempts to merge two already-bound conversations', async () => {
        txMock.session.findMany.mockResolvedValueOnce([
            { id: 'runtime-a', conversationId: 'conversation-a' },
            { id: 'runtime-b', conversationId: 'conversation-b' },
        ]);
        const app = await createApp();
        const response = await app.inject({
            method: 'POST',
            url: '/v1/conversations/bind',
            headers: { 'x-user-id': 'owner' },
            payload: { sessionIds: ['runtime-a', 'runtime-b'] },
        });

        expect(response.statusCode).toBe(409);
        expect(txMock.session.updateMany).not.toHaveBeenCalled();
        await app.close();
    });

    it('deletes an indexed logical conversation in one request', async () => {
        const app = await createApp();
        const response = await app.inject({
            method: 'DELETE',
            url: '/v1/conversations/conversation-1',
            headers: { 'x-user-id': 'owner' },
        });

        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({ success: true, deletedCount: 3 });
        expect(conversationDeleteMock).toHaveBeenCalledOnce();
        expect(conversationDeleteMock).toHaveBeenCalledWith({ uid: 'owner' }, 'conversation-1');
        await app.close();
    });

    it('deletes the complete runtime group in one authenticated request', async () => {
        const app = await createApp();
        const response = await app.inject({
            method: 'POST',
            url: '/v1/sessions/delete',
            headers: { 'x-user-id': 'owner' },
            payload: { sessionIds: ['runtime-1', 'runtime-2'] },
        });

        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({ success: true, deletedCount: 2 });
        expect(sessionDeleteManyMock).toHaveBeenCalledWith(
            { uid: 'owner' },
            ['runtime-1', 'runtime-2'],
        );
        await app.close();
    });

    it('rejects empty, oversized, and unauthenticated requests', async () => {
        const app = await createApp();
        const empty = await app.inject({
            method: 'POST',
            url: '/v1/sessions/delete',
            headers: { 'x-user-id': 'owner' },
            payload: { sessionIds: [] },
        });
        const oversized = await app.inject({
            method: 'POST',
            url: '/v1/sessions/delete',
            headers: { 'x-user-id': 'owner' },
            payload: { sessionIds: Array.from({ length: 10_001 }, (_, index) => `runtime-${index}`) },
        });
        const unauthorized = await app.inject({
            method: 'POST',
            url: '/v1/sessions/delete',
            payload: { sessionIds: ['runtime-1'] },
        });

        expect(empty.statusCode).toBe(400);
        expect(oversized.statusCode).toBe(400);
        expect(unauthorized.statusCode).toBe(401);
        expect(sessionDeleteManyMock).not.toHaveBeenCalled();
        await app.close();
    });

    it('does not report success when ownership verification fails', async () => {
        sessionDeleteManyMock.mockResolvedValueOnce(null);
        const app = await createApp();
        const response = await app.inject({
            method: 'POST',
            url: '/v1/sessions/delete',
            headers: { 'x-user-id': 'owner' },
            payload: { sessionIds: ['runtime-1', 'foreign-runtime'] },
        });

        expect(response.statusCode).toBe(404);
        await app.close();
    });

    it('paginates the encrypted deletion index within the authenticated account', async () => {
        const encryptedKey = new Uint8Array([1, 2, 3]);
        sessionFindManyMock
            .mockResolvedValueOnce([
                { id: 'z-runtime', metadata: 'cipher-z', metadataVersion: 1, dataEncryptionKey: encryptedKey },
                { id: 'y-runtime', metadata: 'cipher-y', metadataVersion: 2, dataEncryptionKey: null },
                { id: 'x-extra', metadata: 'cipher-x', metadataVersion: 3, dataEncryptionKey: null },
            ])
            .mockResolvedValueOnce([
                { id: 'x-runtime', metadata: 'cipher-x', metadataVersion: 3, dataEncryptionKey: null },
            ]);
        const app = await createApp();

        const first = await app.inject({
            method: 'GET',
            url: '/v1/sessions/deletion-scan?limit=2',
            headers: { 'x-user-id': 'owner' },
        });
        expect(first.statusCode).toBe(200);
        expect(first.json()).toEqual({
            sessions: [
                { id: 'z-runtime', metadata: 'cipher-z', metadataVersion: 1, dataEncryptionKey: 'AQID' },
                { id: 'y-runtime', metadata: 'cipher-y', metadataVersion: 2, dataEncryptionKey: null },
            ],
            nextCursor: 'y-runtime',
            hasNext: true,
        });
        expect(sessionFindManyMock).toHaveBeenNthCalledWith(1, expect.objectContaining({
            where: { accountId: 'owner' },
            take: 3,
        }));

        const second = await app.inject({
            method: 'GET',
            url: '/v1/sessions/deletion-scan?limit=2&cursor=y-runtime',
            headers: { 'x-user-id': 'owner' },
        });
        expect(second.statusCode).toBe(200);
        expect(second.json()).toEqual({
            sessions: [
                { id: 'x-runtime', metadata: 'cipher-x', metadataVersion: 3, dataEncryptionKey: null },
            ],
            nextCursor: null,
            hasNext: false,
        });
        expect(sessionFindManyMock).toHaveBeenNthCalledWith(2, expect.objectContaining({
            where: { accountId: 'owner', id: { lt: 'y-runtime' } },
            take: 3,
        }));
        await app.close();
    });
});
