import { beforeEach, describe, expect, it, vi } from 'vitest';

const { tx, inTxMock } = vi.hoisted(() => {
    const tx = {
        conversation: { findFirst: vi.fn(), delete: vi.fn() },
        session: { findMany: vi.fn(), deleteMany: vi.fn() },
        sessionMessage: { deleteMany: vi.fn() },
        usageReport: { deleteMany: vi.fn() },
        accessKey: { deleteMany: vi.fn() },
    };
    return { tx, inTxMock: vi.fn(async (callback: (value: typeof tx) => unknown) => callback(tx)) };
});

vi.mock('@/storage/inTx', () => ({
    inTx: inTxMock,
    afterTx: vi.fn(),
}));
vi.mock('@/app/events/eventRouter', () => ({
    eventRouter: { emitUpdate: vi.fn() },
    buildDeleteSessionUpdate: vi.fn(),
}));
vi.mock('@/storage/seq', () => ({ allocateUserSeq: vi.fn() }));
vi.mock('@/utils/randomKeyNaked', () => ({ randomKeyNaked: vi.fn() }));
vi.mock('@/utils/log', () => ({ log: vi.fn() }));
vi.mock('@/app/presence/sessionCache', () => ({ activityCache: { removeSession: vi.fn() } }));

import { conversationDelete } from './sessionDelete';

describe('conversationDelete', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        tx.conversation.findFirst.mockResolvedValue({ id: 'conversation-1' });
        tx.session.findMany.mockResolvedValue([{ id: 'runtime-a' }, { id: 'runtime-b' }]);
        tx.sessionMessage.deleteMany.mockResolvedValue({ count: 3 });
        tx.usageReport.deleteMany.mockResolvedValue({ count: 2 });
        tx.accessKey.deleteMany.mockResolvedValue({ count: 1 });
        tx.session.deleteMany.mockResolvedValue({ count: 2 });
        tx.conversation.delete.mockResolvedValue({ id: 'conversation-1' });
    });

    it('derives every runtime from the indexed identity and deletes atomically', async () => {
        await expect(conversationDelete({ uid: 'owner' }, 'conversation-1')).resolves.toBe(2);

        expect(tx.conversation.findFirst).toHaveBeenCalledWith({
            where: { id: 'conversation-1', accountId: 'owner' },
            select: { id: true },
        });
        expect(tx.session.findMany).toHaveBeenCalledWith({
            where: { conversationId: 'conversation-1', accountId: 'owner' },
            select: { id: true },
        });
        expect(tx.session.deleteMany).toHaveBeenCalledWith({
            where: { conversationId: 'conversation-1', accountId: 'owner' },
        });
        expect(tx.conversation.delete).toHaveBeenCalledWith({ where: { id: 'conversation-1' } });
    });

    it('performs no child deletion when the conversation is not owned', async () => {
        tx.conversation.findFirst.mockResolvedValueOnce(null);

        await expect(conversationDelete({ uid: 'other-user' }, 'conversation-1')).resolves.toBeNull();
        expect(tx.session.findMany).not.toHaveBeenCalled();
        expect(tx.session.deleteMany).not.toHaveBeenCalled();
        expect(tx.conversation.delete).not.toHaveBeenCalled();
    });
});
