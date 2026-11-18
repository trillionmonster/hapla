import { describe, expect, it, vi } from 'vitest';
import { CodexPermissionHandler } from '../utils/permissionHandler';
import { codexRequestIdentity } from '../utils/codexRequestIdentity';

vi.mock('@/ui/logger', () => ({
    logger: {
        debug: vi.fn(),
    },
}));

function createSessionMock() {
    let state: Record<string, any> = {};

    return {
        session: {
            rpcHandlerManager: {
                registerHandler: vi.fn(),
            },
            updateAgentState: vi.fn((updater: (currentState: Record<string, any>) => Record<string, any>) => {
                state = updater(state);
                return state;
            }),
        },
        getState: () => state,
    };
}

describe('CodexPermissionHandler', () => {
    const context = { epoch: 'epoch-1', requestId: 1, threadId: 'thread-1', turnId: 'turn-1', itemId: 'item-1' };
    const event = (type: string, protocol = context, fields: Record<string, unknown> = {}) => ({ type, protocol, ...fields } as any);
    const rpc = (session: ReturnType<typeof createSessionMock>['session']) => session.rpcHandlerManager.registerHandler.mock.calls.at(-1)![1] as (response: unknown) => Promise<unknown>;

    it('waits for exact provider resolution and keeps concurrent request IDs independent', async () => {
        const { session, getState } = createSessionMock();
        const handler = new CodexPermissionHandler(session as any);
        const first = handler.handleToolCall('item-1', 'AskUserQuestion', { questions: [] }, context);
        const secondContext = { ...context, requestId: '1' };
        const second = handler.handleToolCall('item-1', 'AskUserQuestion', { questions: [] }, secondContext);
        const id = codexRequestIdentity(context);
        const secondId = codexRequestIdentity(secondContext);
        expect(id).not.toBe(secondId);
        expect(Object.keys(getState().requests)).toHaveLength(2);
        await rpc(session)({ id, approved: true, updatedInput: { answers: { password: { answers: ['private-answer'] } } } });
        expect((await first).updatedInput).toBeDefined();
        expect(getState().requests[id].status).toBe('submitting');
        expect(getState().completedRequests).toBeUndefined();
        expect(JSON.stringify(getState())).not.toContain('private-answer');
        await rpc(session)({ id, approved: false }); // An uncertain duplicate receipt cannot replace the submitted answer.
        handler.observeProtocolEvent(event('codex_request', context, { status: 'resolved' }));
        expect(getState().completedRequests[id]).toMatchObject({ status: 'approved', providerStatus: 'resolved' });
        expect(getState().requests[secondId].status).toBe('pending');
        handler.observeProtocolEvent(event('codex_request', secondContext as any, { status: 'resolved' }));
        await expect(second).resolves.toEqual({ decision: 'abort' });
        expect(getState().completedRequests[secondId]).toMatchObject({ status: 'canceled', providerStatus: 'resolved' });
        await expect(rpc(session)({ id, approved: true })).rejects.toThrow('no longer pending');
    });

    it('auto-submits a finite request timeout and waits for provider resolution before marking it expired', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-09-09T12:00:00.000Z'));
        try {
            const { session, getState } = createSessionMock();
            const handler = new CodexPermissionHandler(session as any);
            const pending = handler.handleToolCall(
                'item-1',
                'AskUserQuestion',
                { questions: [], autoResolutionMs: 1_000 },
                context,
            );
            const id = codexRequestIdentity(context);
            expect(getState().requests[id]).toMatchObject({
                status: 'pending',
                arguments: {
                    autoResolutionMs: 1_000,
                    expiresAt: Date.now() + 1_000,
                },
            });
            expect(vi.getTimerCount()).toBe(1);

            await vi.advanceTimersByTimeAsync(999);
            expect(getState().requests[id].status).toBe('pending');
            await vi.advanceTimersByTimeAsync(1);
            await expect(pending).resolves.toEqual({ decision: 'abort' });
            expect(getState().requests[id].status).toBe('submitting');
            expect(getState().completedRequests).toBeUndefined();
            expect(vi.getTimerCount()).toBe(0);

            handler.observeProtocolEvent(event('codex_request', context, { status: 'resolved' }));
            expect(getState().requests[id]).toBeUndefined();
            expect(getState().completedRequests[id]).toMatchObject({
                status: 'expired',
                reason: 'Request expired',
                providerStatus: 'resolved',
            });
        } finally {
            vi.useRealTimers();
        }
    });

    it('does not time out null requests and clears a finite timer when the user answers first', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-09-09T12:00:00.000Z'));
        try {
            const never = createSessionMock();
            const neverHandler = new CodexPermissionHandler(never.session as any);
            const neverPending = neverHandler.handleToolCall(
                'item-1',
                'AskUserQuestion',
                { questions: [], autoResolutionMs: null },
                context,
            );
            const neverId = codexRequestIdentity(context);
            expect(never.getState().requests[neverId].arguments).toMatchObject({
                autoResolutionMs: null,
                expiresAt: null,
            });
            expect(vi.getTimerCount()).toBe(0);

            const early = createSessionMock();
            const earlyHandler = new CodexPermissionHandler(early.session as any);
            const earlyContext = { ...context, requestId: 2 };
            const earlyPending = earlyHandler.handleToolCall(
                'item-1',
                'AskUserQuestion',
                { questions: [], autoResolutionMs: 1_000 },
                earlyContext,
            );
            const earlyId = codexRequestIdentity(earlyContext);
            expect(vi.getTimerCount()).toBe(1);
            await rpc(early.session)({ id: earlyId, approved: true, updatedInput: { answers: {} } });
            await expect(earlyPending).resolves.toMatchObject({ decision: 'approved' });
            expect(vi.getTimerCount()).toBe(0);
            await vi.advanceTimersByTimeAsync(2_000);
            expect(early.getState().requests[earlyId].status).toBe('submitting');
            expect(early.getState().completedRequests).toBeUndefined();
            earlyHandler.observeProtocolEvent(event('codex_request', earlyContext, { status: 'resolved' }));
            expect(early.getState().completedRequests[earlyId]).toMatchObject({
                status: 'approved',
                providerStatus: 'resolved',
            });

            neverHandler.reset();
            await expect(neverPending).resolves.toEqual({ decision: 'abort' });
        } finally {
            vi.useRealTimers();
        }
    });

    it('restores pending/submitting cards on reconnect and rejects the replaced RPC binding', async () => {
        const firstSession = createSessionMock();
        const handler = new CodexPermissionHandler(firstSession.session as any);
        const pending = handler.handleToolCall('item-1', 'AskUserQuestion', { secret: 'private-token' }, context);
        const id = codexRequestIdentity(context);
        const oldRpc = rpc(firstSession.session);
        const replacement = createSessionMock();
        handler.updateSession(replacement.session as any);
        expect(replacement.getState().requests[id]).toMatchObject({ status: 'pending', protocol: context, arguments: { secret: '[已隐藏]' } });
        await expect(oldRpc({ id, approved: true })).rejects.toThrow('replaced session');
        await rpc(replacement.session)({ id, approved: true });
        await pending;
        const third = createSessionMock();
        handler.updateSession(third.session as any);
        expect(third.getState().requests[id].status).toBe('submitting');
        handler.observeProtocolEvent(event('codex_request', context, { status: 'resolved' }));
        expect(third.getState().completedRequests[id].providerStatus).toBe('resolved');
    });

    it('does not claim canceled on the stop click and rejects prior turn/epoch replies after closure', async () => {
        const { session, getState } = createSessionMock();
        const handler = new CodexPermissionHandler(session as any);
        const pending = handler.handleToolCall('item-1', 'CodexBash', { command: 'echo ok' }, context);
        const id = codexRequestIdentity(context);
        handler.abortAll();
        await expect(pending).resolves.toEqual({ decision: 'abort' });
        expect(getState().requests[id].status).toBe('submitting');
        expect(getState().completedRequests).toBeUndefined();
        handler.observeProtocolEvent(event('turn_aborted'));
        expect(getState().completedRequests[id].status).toBe('canceled');
        expect(getState().completedRequests[id].providerStatus).toBeUndefined();
        await expect(rpc(session)({ id, approved: true })).rejects.toThrow('no longer pending');
        const next = { ...context, epoch: 'epoch-2' };
        const nextWait = handler.handleToolCall('item-1', 'CodexBash', {}, next);
        handler.observeProtocolEvent(event('codex_runtime_started', { ...context, epoch: 'epoch-3' }));
        await expect(nextWait).resolves.toEqual({ decision: 'abort' });
        expect(getState().completedRequests[codexRequestIdentity(next)].status).toBe('canceled');
    });

    it('does not auto-approve a command merely because its item ID contains change_title', async () => {
        const { session, getState } = createSessionMock();
        const handler = new CodexPermissionHandler(session as any);
        const pending = handler.handleToolCall('call_change_title_unsafe', 'CodexBash', {}, context);
        expect(getState().requests[codexRequestIdentity(context)].status).toBe('pending');
        handler.reset();
        await pending;
    });
    it('auto-approves the safe change_title tool', async () => {
        const { session, getState } = createSessionMock();
        const handler = new CodexPermissionHandler(session as any);

        const result = await handler.handleToolCall(
            'call_change_title_123',
            'change_title',
            { title: 'Greeting' },
        );

        expect(result).toEqual({ decision: 'approved' });
        expect(getState().completedRequests.call_change_title_123).toMatchObject({
            tool: 'change_title',
            arguments: { title: 'Greeting' },
            status: 'approved',
            decision: 'approved',
        });
    });

    it('keeps non-safe tools pending for user approval', async () => {
        const { session, getState } = createSessionMock();
        const handler = new CodexPermissionHandler(session as any);

        const pending = handler.handleToolCall(
            'call_exec_123',
            'Bash',
            { command: 'pwd' },
        );

        expect(getState().requests.call_exec_123).toMatchObject({
            tool: 'Bash',
            arguments: { command: 'pwd' },
        });

        handler.abortAll();

        await expect(pending).resolves.toEqual({ decision: 'abort' });
    });
});
