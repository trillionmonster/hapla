import { describe, expect, it, vi } from 'vitest';
import type { Machine, Session } from '@/sync/storageTypes';

vi.mock('@/text', () => ({ t: (key: string) => key }));

import {
    continuationFlavor,
    getSessionContinuationAvailability,
    prepareSessionForSend,
    resolveContinuationMachine,
    type SessionContinuationDependencies,
} from './sessionContinuation';

function createSession(overrides: Partial<Session> = {}): Session {
    return {
        id: 'old-session',
        conversationId: 'conversation-1',
        seq: 1,
        createdAt: 1,
        updatedAt: 1,
        active: false,
        activeAt: 1,
        metadata: {
            path: '/workspace/project',
            host: 'test-host',
            flavor: 'codex',
            machineId: 'machine-1',
            codexThreadId: 'thread-1',
        },
        metadataVersion: 1,
        agentState: null,
        agentStateVersion: 1,
        thinking: false,
        thinkingAt: 1,
        presence: 1,
        permissionMode: 'yolo',
        modelMode: 'gpt-test',
        effortLevel: 'high',
        ...overrides,
    };
}

function createMachine(overrides: Partial<Machine> = {}): Machine {
    return {
        id: 'machine-1',
        seq: 1,
        createdAt: 1,
        updatedAt: 1,
        active: true,
        activeAt: 1,
        metadata: {
            host: 'test-host',
            platform: 'linux',
            happyCliVersion: '1.1.6',
            happyHomeDir: '/home/test/.hapla',
            homeDir: '/home/test',
            resumeSupport: {
                rpcAvailable: true,
                requiresSameMachine: true,
                requiresHappyAgentAuth: true,
                happyAgentAuthenticated: true,
                detectedAt: 1,
            },
        },
        metadataVersion: 1,
        daemonState: null,
        daemonStateVersion: 1,
        ...overrides,
    };
}

function createDependencies(overrides: Partial<SessionContinuationDependencies> = {}): SessionContinuationDependencies {
    return {
        resumeSession: vi.fn(async () => ({ type: 'success' as const, sessionId: 'new-session' })),
        refreshSessions: vi.fn(async () => undefined),
        getSession: vi.fn((id) => createSession({ id, active: true, presence: 'online' })),
        copySessionSettings: vi.fn(),
        wait: vi.fn(async () => undefined),
        refreshAttempts: 3,
        ...overrides,
    };
}

function runtimeState(overrides: Partial<NonNullable<NonNullable<Session['agentState']>['codexRuntime']>> = {}) {
    return {
        epoch: 'test-epoch', epochStartedAt: 1, seq: 1, updatedAt: 1,
        threadId: 'thread-1', turnId: null, startId: null,
        runtime: 'idle' as const, turn: 'none' as const, activity: null,
        interrupt: 'none' as const, pendingRequests: {}, ...overrides,
    };
}

function resumedSession(overrides: Partial<Session> = {}) {
    return createSession({ id: 'new-session', active: true, presence: 'online',
        agentState: { codexRuntime: runtimeState() }, ...overrides });
}

describe('session continuation before send', () => {
    it('normalizes all supported legacy provider markers', () => {
        expect(continuationFlavor(createSession({ metadata: {
            path: '/workspace/project',
            host: 'test-host',
            machineId: 'machine-1',
            flavor: 'gpt',
        } }))).toBe('codex');
        expect(continuationFlavor(createSession({ metadata: {
            path: '/workspace/project',
            host: 'test-host',
            machineId: 'machine-1',
            flavor: 'openai',
        } }))).toBe('codex');
        expect(continuationFlavor(createSession({ metadata: {
            path: '/workspace/project',
            host: 'test-host',
            machineId: 'machine-1',
        } }))).toBe('claude');
    });

    it('transparently continues a pre-provider-metadata Claude session', async () => {
        const session = createSession({ metadata: {
            path: '/workspace/project',
            host: 'test-host',
            machineId: 'machine-1',
        } });
        const dependencies = createDependencies();

        await expect(prepareSessionForSend(session, createMachine(), false, dependencies))
            .resolves.toBe('new-session');
        expect(dependencies.resumeSession).toHaveBeenCalledWith(expect.objectContaining({
            metadata: expect.objectContaining({ flavor: 'claude' }),
        }));
    });

    it('ensures a runtime when presence is gone even if persisted active state is stale', async () => {
        const session = createSession({ active: true, presence: Date.now() });
        const dependencies = createDependencies();

        await expect(prepareSessionForSend(session, createMachine(), false, dependencies))
            .resolves.toBe('new-session');
        expect(dependencies.resumeSession).toHaveBeenCalledTimes(1);
    });

    it('still asks the daemon to ensure a runtime while relay presence is live', async () => {
        const session = createSession({ active: false });
        const dependencies = createDependencies({
            resumeSession: vi.fn(async () => ({ type: 'success' as const, sessionId: session.id })),
        });

        await expect(prepareSessionForSend(session, createMachine(), true, dependencies))
            .resolves.toBe(session.id);
        expect(dependencies.resumeSession).toHaveBeenCalledTimes(1);
    });

    it('continues a sleeping session and copies all outbound mode settings', async () => {
        const session = createSession();
        const machine = createMachine();
        const getSession = vi.fn()
            .mockReturnValueOnce(undefined)
            .mockReturnValueOnce(createSession({ id: 'new-session', active: true, presence: 'online' }));
        const dependencies = createDependencies({ getSession });

        await expect(prepareSessionForSend(session, machine, false, dependencies))
            .resolves.toBe('new-session');
        expect(dependencies.resumeSession).toHaveBeenCalledWith({
            machineId: 'machine-1',
            sessionId: 'old-session',
            conversationId: 'conversation-1',
            metadata: {
                path: '/workspace/project',
                flavor: 'codex',
                codexThreadId: 'thread-1',
                claudeSessionId: undefined,
                conversationRootSessionId: undefined,
                codexBranches: undefined,
                activeCodexBranchId: undefined,
            },
        });
        expect(dependencies.refreshSessions).toHaveBeenCalledTimes(2);
        expect(dependencies.copySessionSettings).toHaveBeenCalledWith(session, 'new-session');
    });

    it('can continue directly on a selected Codex branch after a stale runtime is retired', async () => {
        const session = createSession();
        const dependencies = createDependencies();

        await expect(prepareSessionForSend(session, createMachine(), true, dependencies, {
            metadata: {
                codexThreadId: 'branch-thread-2',
                activeCodexBranchId: 'branch-2',
            },
        })).resolves.toBe('new-session');

        expect(dependencies.resumeSession).toHaveBeenCalledWith(expect.objectContaining({
            metadata: expect.objectContaining({
                codexThreadId: 'branch-thread-2',
                activeCodexBranchId: 'branch-2',
            }),
        }));
    });

    it('lets the daemon recover a Codex session that has no provider thread id yet', async () => {
        const session = createSession({
            metadata: {
                path: '/workspace/project',
                host: 'test-host',
                flavor: 'codex',
                machineId: 'machine-1',
            },
        });
        const dependencies = createDependencies();

        await expect(prepareSessionForSend(session, createMachine(), false, dependencies))
            .resolves.toBe('new-session');
        expect(dependencies.resumeSession).toHaveBeenCalledWith(expect.objectContaining({
            machineId: 'machine-1',
            metadata: expect.objectContaining({ codexThreadId: undefined }),
        }));
    });

    it('routes an offline installation through an online daemon on the same host and home', () => {
        const session = createSession({
            metadata: {
                path: '/home/test/project',
                homeDir: '/home/test',
                happyHomeDir: '/home/test/.hapla',
                host: 'test-host',
                flavor: 'codex',
                machineId: 'machine-1',
                codexThreadId: 'thread-1',
            },
        });
        const offlineOriginal = createMachine({ active: false });
        const replacement = createMachine({
            id: 'machine-2',
            active: true,
            activeAt: 20,
        });

        expect(resolveContinuationMachine(session, [offlineOriginal, replacement])?.id).toBe('machine-2');
    });

    it('never routes a conversation through a different host or home', () => {
        const session = createSession();
        const wrongHost = createMachine({
            id: 'machine-2',
            metadata: { ...createMachine().metadata!, host: 'other-host' },
        });
        const wrongHome = createMachine({
            id: 'machine-3',
            metadata: { ...createMachine().metadata!, homeDir: '/other-home' },
        });

        expect(resolveContinuationMachine(session, [wrongHost, wrongHome])).toBeNull();
    });

    it('does not attempt continuation while the original machine is offline', async () => {
        const session = createSession();
        const machine = createMachine({ active: false });
        const dependencies = createDependencies();

        const availability = getSessionContinuationAvailability(session, machine, false);
        expect(availability).toMatchObject({ requiresContinuation: true, canContinue: false });
        await expect(prepareSessionForSend(session, machine, false, dependencies)).rejects.toThrow();
        expect(dependencies.resumeSession).not.toHaveBeenCalled();
    });

    it('keeps the draft unsent when the continued session never synchronizes', async () => {
        const dependencies = createDependencies({ getSession: vi.fn(() => undefined) });

        await expect(prepareSessionForSend(createSession(), createMachine(), false, dependencies))
            .rejects.toThrow();
        expect(dependencies.refreshSessions).toHaveBeenCalledTimes(3);
        expect(dependencies.copySessionSettings).not.toHaveBeenCalled();
    });

    it('waits beyond row registration until the requested Codex thread is actually loaded', async () => {
        const source = createSession({ agentState: { codexRuntime: runtimeState() } });
        const getSession = vi.fn()
            .mockReturnValueOnce(resumedSession({ agentState: null }))
            .mockReturnValueOnce(resumedSession({ agentState: { codexRuntime: runtimeState({ runtime: 'notLoaded', threadId: null }) } }))
            .mockReturnValueOnce(resumedSession());
        const dependencies = createDependencies({ getSession });
        await expect(prepareSessionForSend(source, createMachine(), true, dependencies)).resolves.toBe('new-session');
        expect(dependencies.refreshSessions).toHaveBeenCalledTimes(3);
        expect(dependencies.copySessionSettings).toHaveBeenCalledTimes(1);
    });

    it('does not release the draft when a registered runtime remains unloaded', async () => {
        const dependencies = createDependencies({ getSession: vi.fn(() => resumedSession({
            agentState: { codexRuntime: runtimeState({ runtime: 'notLoaded', threadId: null }) },
        })) });
        await expect(prepareSessionForSend(createSession(), createMachine(), false, dependencies)).rejects.toThrow();
        expect(dependencies.refreshSessions).toHaveBeenCalledTimes(3);
        expect(dependencies.copySessionSettings).not.toHaveBeenCalled();
    });

    it.each([
        resumedSession({ active: false, presence: 1, agentState: { codexRuntime: runtimeState({ runtime: 'notLoaded', threadId: null }) } }),
        resumedSession({ agentState: { codexRuntime: runtimeState({ runtime: 'systemError' }) } }),
    ])('reports an exited or failed startup immediately without accepting the draft', async (target) => {
        const dependencies = createDependencies({ getSession: vi.fn(() => target) });
        await expect(prepareSessionForSend(createSession(), createMachine(), false, dependencies)).rejects.toThrow('消息尚未发送');
        expect(dependencies.refreshSessions).toHaveBeenCalledTimes(1);
        expect(dependencies.wait).not.toHaveBeenCalled();
        expect(dependencies.copySessionSettings).not.toHaveBeenCalled();
    });

    it('refuses a loaded runtime for another thread', async () => {
        const dependencies = createDependencies({ getSession: vi.fn(() => resumedSession({
            agentState: { codexRuntime: runtimeState({ threadId: 'other-thread' }) },
        })) });
        await expect(prepareSessionForSend(createSession(), createMachine(), false, dependencies)).rejects.toThrow('所选分支不一致');
        expect(dependencies.copySessionSettings).not.toHaveBeenCalled();
    });

    it('checks the selected branch and explicit thread override instead of the previous main thread', async () => {
        const source = createSession({ metadata: {
            ...createSession().metadata!, activeCodexBranchId: 'branch-2',
            codexBranches: [{ id: 'branch-2', threadId: 'thread-2', label: 'Branch', createdAt: 1 }],
        } });
        const dependencies = createDependencies({ getSession: vi.fn(() => resumedSession({
            agentState: { codexRuntime: runtimeState({ threadId: 'thread-2' }) },
        })) });
        await expect(prepareSessionForSend(source, createMachine(), false, dependencies)).resolves.toBe('new-session');
        const override = createDependencies({ getSession: vi.fn(() => resumedSession({
            agentState: { codexRuntime: runtimeState({ threadId: 'thread-3' }) },
        })) });
        await expect(prepareSessionForSend(source, createMachine(), false, override, { metadata: { codexThreadId: 'thread-3' } })).resolves.toBe('new-session');
    });

    it('permits an initialized empty conversation before the first question creates a thread', async () => {
        const source = createSession({ metadata: { ...createSession().metadata!, codexThreadId: undefined },
            agentState: { codexRuntime: runtimeState({ runtime: 'notLoaded', threadId: null }) } });
        const dependencies = createDependencies({ getSession: vi.fn(() => resumedSession({
            agentState: { codexRuntime: runtimeState({ runtime: 'notLoaded', threadId: null }) },
        })) });
        await expect(prepareSessionForSend(source, createMachine(), false, dependencies)).resolves.toBe('new-session');
    });

    it('preserves live same-runtime reuse and the legacy CLI readiness acknowledgement', async () => {
        const source = createSession({ active: true, presence: 'online', agentState: { codexRuntime: runtimeState() } });
        const same = createDependencies({
            resumeSession: vi.fn(async () => ({ type: 'success' as const, sessionId: source.id })),
            getSession: vi.fn(() => source),
        });
        await expect(prepareSessionForSend(source, createMachine(), true, same)).resolves.toBe(source.id);
        const legacy = createDependencies({ getSession: vi.fn(() => resumedSession({ agentState: null })) });
        await expect(prepareSessionForSend(createSession(), createMachine(), false, legacy)).resolves.toBe('new-session');
    });
});
