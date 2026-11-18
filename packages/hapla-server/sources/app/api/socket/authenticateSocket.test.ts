import type { Socket } from 'socket.io';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    verifyToken: vi.fn(),
    sessionFindFirst: vi.fn(),
    machineFindFirst: vi.fn(),
}));
vi.mock('@/app/auth/auth', () => ({ auth: { verifyToken: mocks.verifyToken } }));
vi.mock('@/storage/db', () => ({ db: {
    session: { findFirst: mocks.sessionFindFirst },
    machine: { findFirst: mocks.machineFindFirst },
} }));
vi.mock('@/utils/log', () => ({ log: vi.fn() }));

import { authenticateSocket } from './authenticateSocket';

function makeSocket(handshake: Record<string, unknown>) {
    return { handshake: { auth: { token: 'owner-token', ...handshake }, headers: {} }, data: {} } as unknown as Socket;
}

describe('Socket.IO account and scope authentication', () => {
    beforeEach(() => {
        vi.resetAllMocks();
        mocks.verifyToken.mockImplementation(async (token: string) => token === 'owner-token' ? { userId: 'owner' } : null);
        const findOwned = async ({ where }: { where: Record<string, unknown> }) => {
            const rows = [{ id: 'own', accountId: 'owner' }, { id: 'other', accountId: 'other-owner' }];
            return rows.find(row => Object.entries(where).every(([key, value]) => row[key as keyof typeof row] === value)) ?? null;
        };
        mocks.sessionFindFirst.mockImplementation(findOwned);
        mocks.machineFindFirst.mockImplementation(findOwned);
    });

    it.each(['session', 'machine'] as const)('allows an owned %s scope after ownership lookup', async (scope) => {
        const socket = makeSocket({ clientType: `${scope}-scoped`, [`${scope}Id`]: 'own' });
        const next = vi.fn();
        await authenticateSocket(socket, next);
        expect(next.mock.calls).toEqual([[]]);
        expect(socket.data.userId).toBe('owner');
        expect(socket.data[`${scope}Id`]).toBe('own');
    });

    it.each([
        ['session', 'other'], ['session', 'missing'],
        ['machine', 'other'], ['machine', 'missing'],
    ])('rejects %s scope %s without admitting a connection', async (scope, id) => {
        const socket = makeSocket({ clientType: `${scope}-scoped`, [`${scope}Id`]: id });
        const next = vi.fn();
        await authenticateSocket(socket, next);
        expect(next).toHaveBeenCalledExactlyOnceWith(new Error(`${scope === 'session' ? 'Session' : 'Machine'} not found`));
        expect(socket.data).toEqual({});
    });

    it.each([undefined, 'user-scoped'])('preserves ordinary user authentication (%s)', async (clientType) => {
        const socket = makeSocket({ clientType, machineId: 'other', sessionId: 'other' });
        const next = vi.fn();
        await authenticateSocket(socket, next);
        expect(next.mock.calls).toEqual([[]]);
        expect(socket.data.userId).toBe('owner');
        expect(socket.data.sessionId).toBeUndefined();
        expect(socket.data.machineId).toBeUndefined();
        expect(mocks.sessionFindFirst).not.toHaveBeenCalled();
        expect(mocks.machineFindFirst).not.toHaveBeenCalled();
    });

    it.each([
        { token: null }, { token: 'invalid-token' }, { clientType: 'invalid-scope' },
        { clientType: 'session-scoped' }, { clientType: 'session-scoped', sessionId: { equals: 'own' } },
        { clientType: 'machine-scoped' }, { clientType: 'machine-scoped', machineId: ' ' },
    ])('rejects malformed or unauthenticated handshakes: %j', async (handshake) => {
        const socket = makeSocket(handshake);
        const next = vi.fn();
        await authenticateSocket(socket, next);
        expect(next).toHaveBeenCalledExactlyOnceWith(expect.any(Error));
        expect(socket.data).toEqual({});
        expect(mocks.sessionFindFirst).not.toHaveBeenCalled();
        expect(mocks.machineFindFirst).not.toHaveBeenCalled();
    });

    it('does not admit a socket while its ownership query is pending', async () => {
        let complete!: (row: { id: string }) => void;
        mocks.sessionFindFirst.mockReturnValue(new Promise(resolve => { complete = resolve; }));
        const socket = makeSocket({ clientType: 'session-scoped', sessionId: 'own' });
        const next = vi.fn();
        const pending = authenticateSocket(socket, next);
        await vi.waitFor(() => expect(mocks.sessionFindFirst).toHaveBeenCalled());
        expect(next).not.toHaveBeenCalled();
        expect(socket.data).toEqual({});
        complete({ id: 'own' });
        await pending;
        expect(next.mock.calls).toEqual([[]]);
    });

    it.each(['verifyToken', 'sessionFindFirst', 'machineFindFirst'] as const)('fails closed when %s rejects', async (operation) => {
        mocks[operation].mockRejectedValue(new Error('backend unavailable'));
        const scope = operation === 'machineFindFirst' ? 'machine' : 'session';
        const socket = makeSocket({ clientType: `${scope}-scoped`, [`${scope}Id`]: 'own' });
        const next = vi.fn();
        await authenticateSocket(socket, next);
        expect(next).toHaveBeenCalledExactlyOnceWith(new Error('Authentication failed'));
        expect(socket.data).toEqual({});
    });
});
