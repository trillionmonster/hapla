import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SandboxConfig } from '@/persistence';

const {
    mockExecSync,
    mockInitializeSandbox,
    mockWrapForMcpTransport,
    mockSandboxCleanup,
    mockSpawn,
} = vi.hoisted(() => ({
    mockExecSync: vi.fn(),
    mockInitializeSandbox: vi.fn(),
    mockWrapForMcpTransport: vi.fn(),
    mockSandboxCleanup: vi.fn(),
    mockSpawn: vi.fn(),
}));

vi.mock('node:child_process', () => ({
    execSync: mockExecSync,
    execFileSync: mockExecSync,
    spawn: mockSpawn,
}));

vi.mock('cross-spawn', () => ({
    spawn: mockSpawn,
    sync: (...args: unknown[]) => ({ status: 0, stdout: mockExecSync(...args) }),
}));

vi.mock('@/sandbox/manager', () => ({
    initializeSandbox: mockInitializeSandbox,
    wrapForMcpTransport: mockWrapForMcpTransport,
}));

vi.mock('@/ui/logger', () => ({
    logger: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
    },
}));

vi.mock('../package.json', () => ({
    default: { version: '0.0.1-test' },
}));

type MockRpcMessage = {
    id?: number;
    method?: string;
    params?: any;
    result?: any;
};

function pushJsonLine(stdout: NodeJS.ReadableStream & { push: (chunk: string) => void }, payload: unknown) {
    stdout.push(JSON.stringify(payload) + '\n');
}

// Mock child process with stdin/stdout/stderr
function createMockProcess(opts?: {
    pid?: number;
    initializeDelayMs?: number;
    onRequest?: (msg: MockRpcMessage, stdout: NodeJS.ReadableStream & { push: (chunk: string) => void }) => void;
}) {
    const { Readable, Writable } = require('stream');
    const initializeDelayMs = opts?.initializeDelayMs ?? 5;
    const stdin = new Writable({ write: (_: any, __: any, cb: () => void) => cb() });
    const stdout = new Readable({ read() {} });
    const stderr = new Readable({ read() {} });
    const proc = Object.assign(new (require('events').EventEmitter)(), {
        stdin,
        stdout,
        stderr,
        pid: opts?.pid ?? 12345,
        kill: vi.fn(),
    });
    // Send initialize response immediately when stdin is written to
    const origWrite = stdin.write.bind(stdin);
    stdin.write = (data: any, ...args: any[]) => {
        try {
            const msg = JSON.parse(typeof data === 'string' ? data : data.toString());
            if (msg.method === 'initialize' && msg.id != null) {
                // Send response on next tick
                setTimeout(() => {
                    pushJsonLine(stdout, { id: msg.id, result: { userAgent: 'test' } });
                }, initializeDelayMs);
            }
            opts?.onRequest?.(msg, stdout);
        } catch {}
        return origWrite(data, ...args);
    };
    return proc;
}

async function waitFor(predicate: () => boolean, timeoutMs: number = 1000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
        if (Date.now() >= deadline) {
            throw new Error(`Timed out after ${timeoutMs}ms`);
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
}

const sandboxConfig: SandboxConfig = {
    enabled: true,
    workspaceRoot: '~/projects',
    sessionIsolation: 'workspace',
    customWritePaths: [],
    denyReadPaths: ['~/.ssh'],
    extraWritePaths: ['/tmp'],
    denyWritePaths: ['.env'],
    networkMode: 'allowed',
    allowedDomains: [],
    deniedDomains: [],
    allowLocalBinding: true,
};

describe('CodexAppServerClient sandbox integration', () => {
    const originalRustLog = process.env.RUST_LOG;
    const originalCodexPath = process.env.HAPLA_CODEX_PATH;

    beforeEach(() => {
        vi.clearAllMocks();
        process.env.HAPLA_CODEX_PATH = 'codex';
        process.env.RUST_LOG = originalRustLog;
        mockExecSync.mockReturnValue('codex-cli 0.107.0');
        mockInitializeSandbox.mockResolvedValue(mockSandboxCleanup);
        mockWrapForMcpTransport.mockResolvedValue({ command: 'sh', args: ['-c', 'wrapped codex app-server'] });
        mockSpawn.mockImplementation(() => createMockProcess());
    });

    afterAll(() => {
        if (originalCodexPath === undefined) delete process.env.HAPLA_CODEX_PATH;
        else process.env.HAPLA_CODEX_PATH = originalCodexPath;
        process.env.RUST_LOG = originalRustLog;
    });

    async function runningClient(onRequest?: (msg: MockRpcMessage, stdout: NodeJS.ReadableStream & { push: (chunk: string) => void }) => void, verbosity?: 'high', threadOptions?: {
        model?: string; cwd?: string; approvalPolicy?: 'on-request'; sandbox?: 'read-only'; mcpServers?: Record<string, unknown>;
    }) {
        const requests: MockRpcMessage[] = [];
        const events: any[] = [];
        let turnNumber = 0;
        const proc = createMockProcess({ onRequest: (msg, stdout) => {
            requests.push(msg);
            if (msg.method === 'thread/start') queueMicrotask(() => pushJsonLine(stdout, {
                id: msg.id, result: { thread: { id: 'thread-reliable', status: { type: 'idle' } }, model: 'test' },
            }));
            if (msg.method === 'turn/start') {
                const id = `turn-${++turnNumber}`;
                queueMicrotask(() => {
                    pushJsonLine(stdout, { id: msg.id, result: { turn: { id } } });
                    pushJsonLine(stdout, { method: 'turn/started', params: { threadId: 'thread-reliable', turn: { id, status: 'inProgress' } } });
                });
            }
            if (msg.method === 'turn/interrupt') queueMicrotask(() => pushJsonLine(stdout, { id: msg.id, result: {} }));
            if (msg.method === 'thread/read') queueMicrotask(() => pushJsonLine(stdout, {
                id: msg.id, result: { thread: { id: 'thread-reliable', turns: [{ id: `turn-${turnNumber}`, status: 'inProgress' }] } },
            }));
            onRequest?.(msg, stdout);
        } });
        mockSpawn.mockImplementation(() => proc);
        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();
        client.setEventHandler((event) => events.push(event));
        await client.connect();
        await client.startThread({ ...threadOptions, verbosity });
        const notify = (method: string, params: unknown) => pushJsonLine(proc.stdout, { method, params });
        const complete = (id: string, status = 'completed', threadId = 'thread-reliable') => notify('turn/completed', { threadId, turn: { id, status } });
        return { client, proc, requests, events, notify, complete };
    }

    it('restores a terminal SSE server error once on the latest executable without replaying the failed input', async () => {
        const mcpServers = { hapla: { command: 'node', args: ['bridge.mjs'] } };
        const { client, proc, requests, events, notify } = await runningClient(undefined, undefined, {
            model: 'initial-model', cwd: '/work', approvalPolicy: 'on-request', sandbox: 'read-only', mcpServers,
        });
        const { CodexTurnFailure } = await import('./codexTurnFailure');
        const turn = client.sendTurnContentAndWait([{ type: 'text', text: 'original request' }, { type: 'image', url: 'data:image/png;base64,fixture' }], { model: 'current-model', turnTimeoutMs: 80 });
        const failureResult = turn.catch(error => error);
        await waitFor(() => client.turnId === 'turn-1');
        const error = { codexErrorInfo: 'other', message: 'stream disconnected before completion: An error occurred while processing your request. Request ID req-original' };
        notify('error', { threadId: 'thread-reliable', turnId: 'turn-1', error, willRetry: true });
        await new Promise(resolve => setTimeout(resolve, 10));
        expect(mockSpawn).toHaveBeenCalledTimes(1);
        expect(client.turnId).toBe('turn-1');

        let oldExited = false;
        proc.kill.mockImplementation(() => {
            setTimeout(() => { oldExited = true; proc.exitCode = 0; proc.emit('exit', 0, null); }, 20);
            return true;
        });
        const recoveredRequests: MockRpcMessage[] = [];
        const recovered = createMockProcess({ initializeDelayMs: 100, onRequest: (msg, stdout) => {
            recoveredRequests.push(msg);
            if (msg.method === 'thread/resume') queueMicrotask(() => pushJsonLine(stdout, {
                id: msg.id, result: { thread: { id: 'thread-reliable', status: { type: 'idle' } }, model: 'current-model' },
            }));
            if (msg.method === 'turn/start') queueMicrotask(() => {
                pushJsonLine(stdout, { id: msg.id, result: { turn: { id: 'turn-next' } } });
                pushJsonLine(stdout, { method: 'turn/completed', params: { threadId: 'thread-reliable', turn: { id: 'turn-next', status: 'completed' } } });
            });
        } });
        process.env.HAPLA_CODEX_PATH = 'codex-updated';
        mockExecSync.mockReturnValue('codex-cli 0.162.1');
        mockSpawn.mockImplementation(() => { expect(oldExited).toBe(true); return recovered; });
        notify('turn/completed', { threadId: 'thread-reliable', turn: { id: 'turn-1', status: 'failed', error } });

        const failure = await failureResult;
        expect(failure).toBeInstanceOf(CodexTurnFailure);
        expect(failure).toMatchObject({ message: error.message, recovery: 'restored', threadId: 'thread-reliable', turnId: 'turn-1' });
        expect(mockSpawn).toHaveBeenCalledTimes(2);
        expect(mockSpawn.mock.calls[1][0]).toBe('codex-updated');
        expect(recoveredRequests.find(msg => msg.method === 'thread/resume')?.params).toMatchObject({
            threadId: 'thread-reliable', model: 'current-model', cwd: '/work', approvalPolicy: 'on-request', sandbox: 'read-only',
            config: { mcp_servers: mcpServers }, persistExtendedHistory: true,
        });
        expect(recoveredRequests.some(msg => msg.method === 'thread/start' || msg.method === 'turn/start')).toBe(false);
        expect(requests.filter(msg => msg.method === 'turn/start')).toHaveLength(1);
        expect(events.filter(event => event.type === 'task_complete')).toEqual([expect.objectContaining({ status: 'failed', error })]);
        expect(events.some(event => event.type === 'codex_runtime_error' && event.reason === 'completionUnconfirmed')).toBe(false);
        expect(client.threadId).toBe('thread-reliable');
        await expect(client.sendTurnAndWait('next user request')).resolves.toEqual({ aborted: false });
        expect(recoveredRequests.filter(msg => msg.method === 'turn/start').map(msg => msg.params.input)).toEqual([[{ type: 'text', text: 'next user request' }]]);
        await client.disconnect();
    });

    it.each(['unauthorized', 'usageLimitExceeded', 'rateLimitExceeded', 'contextWindowExceeded'])('rejects a failed %s turn without restarting the runtime', async (codexErrorInfo) => {
        const { client, notify } = await runningClient();
        const turn = client.sendTurnAndWait('request');
        const result = turn.catch(error => error);
        await waitFor(() => client.turnId === 'turn-1');
        notify('turn/completed', { threadId: 'thread-reliable', turn: { id: 'turn-1', status: 'failed', error: { message: 'original provider error', codexErrorInfo } } });
        expect(await result).toMatchObject({ name: 'CodexTurnFailure', message: 'original provider error', recovery: 'notAttempted' });
        expect(mockSpawn).toHaveBeenCalledTimes(1);
        expect(client.turnId).toBeNull();
        await expect(client.waitForTurnIdle()).resolves.toBeUndefined();
        await client.disconnect();
    });

    it('retains the failure details when completion arrives before turn/start acknowledges its ID', async () => {
        const providerError = { message: 'quota exhausted', codexErrorInfo: 'usageLimitExceeded' };
        const proc = createMockProcess({ onRequest: (msg, stdout) => {
            if (msg.method === 'thread/start') queueMicrotask(() => pushJsonLine(stdout, { id: msg.id, result: { thread: { id: 'early-thread' }, model: 'test' } }));
            if (msg.method === 'turn/start') queueMicrotask(() => {
                pushJsonLine(stdout, { method: 'turn/completed', params: { threadId: 'early-thread', turn: { id: 'early-turn', status: 'failed', error: providerError } } });
                pushJsonLine(stdout, { id: msg.id, result: { turn: { id: 'early-turn' } } });
            });
        } });
        mockSpawn.mockImplementation(() => proc);
        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();
        await client.connect();
        await client.startThread({});
        await expect(client.sendTurnAndWait('request')).rejects.toMatchObject({ name: 'CodexTurnFailure', message: providerError.message, providerError });
        expect(client.turnId).toBeNull();
        await client.disconnect();
    });

    it('preserves the original conversation when automatic resume fails and never falls back to a new thread', async () => {
        const { client, proc, notify } = await runningClient();
        proc.kill.mockImplementation(() => { proc.exitCode = 0; proc.emit('exit', 0, null); return true; });
        const requests: MockRpcMessage[] = [];
        const recovered = createMockProcess({ onRequest: (msg, stdout) => {
            requests.push(msg);
            if (msg.method === 'thread/resume') queueMicrotask(() => pushJsonLine(stdout, { id: msg.id, error: { code: -32000, message: 'resume unavailable' } }));
        } });
        const result = client.sendTurnAndWait('request').catch(error => error);
        await waitFor(() => client.turnId === 'turn-1');
        mockSpawn.mockImplementation(() => recovered);
        notify('turn/completed', { threadId: 'thread-reliable', turn: { id: 'turn-1', status: 'failed', error: { message: 'original failure', codexErrorInfo: 'internalServerError' } } });
        expect(await result).toMatchObject({ message: 'original failure', recovery: 'failed', recoveryError: expect.stringContaining('resume unavailable') });
        expect(mockSpawn).toHaveBeenCalledTimes(2);
        expect(requests.filter(msg => msg.method === 'thread/resume')).toHaveLength(1);
        expect(requests.some(msg => msg.method === 'thread/start' || msg.method === 'turn/start')).toBe(false);
        expect(client.threadId).toBe('thread-reliable');
        await expect(client.waitForTurnIdle()).rejects.toThrow('disconnected');
        await client.disconnect();
    });

    it('does not start a replacement process if the previous rollout writer has not exited', async () => {
        const { client, proc, notify } = await runningClient();
        const result = client.sendTurnAndWait('request').catch(error => error);
        await waitFor(() => client.turnId === 'turn-1');
        vi.useFakeTimers();
        try {
            notify('turn/completed', { threadId: 'thread-reliable', turn: { id: 'turn-1', status: 'failed', error: { message: 'original failure', codexErrorInfo: 'internalServerError' } } });
            await vi.advanceTimersByTimeAsync(5_100);
            expect(await result).toMatchObject({ recovery: 'failed', recoveryError: expect.stringContaining('did not exit') });
            expect(proc.kill).toHaveBeenCalledWith('SIGKILL');
            expect(mockSpawn).toHaveBeenCalledTimes(1);
            expect(client.threadId).toBe('thread-reliable');
        } finally { vi.useRealTimers(); await client.disconnect(); }
    });

    it('sets output detail when creating a new thread before it has a resumable rollout', async () => {
        const { client, requests, complete } = await runningClient(undefined, 'high');
        const turn = client.sendTurnAndWait('首轮', { verbosity: 'high' });
        await waitFor(() => client.turnId === 'turn-1');
        expect(requests.find(request => request.method === 'thread/start')?.params.config).toMatchObject({ model_verbosity: 'high' });
        expect(requests.some(request => request.method === 'thread/resume')).toBe(false);
        complete('turn-1'); await turn; await client.disconnect();
    });

    it('sends native effort, Fast and plan settings while changing verbosity only on this thread', async () => {
        const { client, requests, complete } = await runningClient((msg, stdout) => {
            if (msg.method === 'config/read') queueMicrotask(() => pushJsonLine(stdout, { id: msg.id, result: { config: { model_verbosity: 'medium' } } }));
            if (msg.method === 'thread/resume') queueMicrotask(() => pushJsonLine(stdout, { id: msg.id, result: {} }));
        });
        const turn = client.sendTurnAndWait('设置验证', { effort: 'high', serviceTier: 'fast', verbosity: 'high', collaborationMode: 'plan' });
        await waitFor(() => client.turnId === 'turn-1');
        expect(requests.find(request => request.method === 'thread/resume')?.params.config).toMatchObject({ model_verbosity: 'high' });
        expect(requests.find(request => request.method === 'turn/start')?.params).toMatchObject({ effort: 'high', serviceTier: 'fast', collaborationMode: { mode: 'plan', settings: { model: 'test', reasoning_effort: 'high', developer_instructions: null } } });
        expect(requests.some(request => request.method?.startsWith('config/value/write'))).toBe(false);
        complete('turn-1'); await turn;
        const next = client.sendTurnAndWait('恢复默认', { verbosity: null, serviceTier: null, collaborationMode: 'default' });
        await waitFor(() => client.turnId === 'turn-2');
        expect(requests.filter(request => request.method === 'thread/resume').at(-1)?.params.config.model_verbosity).toBe('medium');
        expect(requests.filter(request => request.method === 'turn/start').at(-1)?.params.serviceTier).toBeNull();
        complete('turn-2'); await next; await client.disconnect();
    });

    it('projects only provider-declared reasoning summaries and keeps hidden reasoning out of normal events', async () => {
        const { client, events, notify, complete } = await runningClient();
        const turn = client.sendTurnAndWait('think');
        await waitFor(() => client.turnId === 'turn-1');
        const context = { threadId: 'thread-reliable', turnId: 'turn-1', itemId: 'reason-1' };
        notify('item/reasoning/textDelta', { ...context, delta: 'PRIVATE_RAW_THINKING' });
        notify('item/reasoning/summaryTextDelta', { ...context, summaryIndex: 0, delta: 'Public summary' });
        notify('item/completed', { ...context, item: { id: 'reason-1', type: 'reasoning', summary: ['Public summary', 'Second section'], content: ['PRIVATE_RAW_THINKING'] } });
        complete('turn-1');
        await turn;
        expect(events).toContainEqual(expect.objectContaining({ type: 'agent_reasoning_delta', summary: true, delta: 'Public summary', item_id: 'reason-1' }));
        expect(events).toContainEqual(expect.objectContaining({ type: 'agent_reasoning', summary: true, text: 'Public summary\n\nSecond section', item_id: 'reason-1' }));
        expect(JSON.stringify(events)).not.toContain('PRIVATE_RAW_THINKING');
        await client.disconnect();
    });

    it('retains the active turn across a virtual 30-minute compaction without interrupting or allowing an overlapping start', async () => {
        const { client, events, requests, notify, complete } = await runningClient();
        let finished = false;
        const turn = client.sendTurnAndWait('continue after compaction').then(() => { finished = true; });
        await waitFor(() => client.turnId === 'turn-1');
        const context = { threadId: 'thread-reliable', turnId: 'turn-1' };
        notify('item/started', { ...context, item: { id: 'compact-1', type: 'contextCompaction' } });
        await waitFor(() => events.some(event => event.type === 'codex_activity' && event.phase === 'compacting'));
        vi.useFakeTimers();
        try {
            await vi.advanceTimersByTimeAsync(30 * 60 * 1000);
            expect(finished).toBe(false);
            expect(client.turnId).toBe('turn-1');
            expect(requests.some(request => request.method === 'turn/interrupt')).toBe(false);
            expect(mockSpawn).toHaveBeenCalledTimes(1);
            await expect(client.sendTurnAndWait('overlap')).rejects.toThrow();
            expect(requests.filter(request => request.method === 'turn/start')).toHaveLength(1);
            notify('item/completed', { ...context, item: { id: 'compact-1', type: 'contextCompaction' } });
            complete('turn-1');
            await turn;
            expect(finished).toBe(true);
            expect(client.turnId).toBeNull();
        } finally { vi.useRealTimers(); await client.disconnect(); }
    });

    it('queues input behind an unsolicited compaction turn and rejects idle waits on disconnect', async () => {
        const { client, notify, requests, complete } = await runningClient();
        notify('turn/started', { threadId: 'thread-reliable', turn: { id: 'compact-turn', status: 'inProgress' } });
        notify('item/started', { threadId: 'thread-reliable', turnId: 'compact-turn', item: { id: 'compact-item', type: 'contextCompaction' } });
        await waitFor(() => client.turnId === 'compact-turn');
        let idle = false;
        const barrier = client.waitForTurnIdle().then(() => { idle = true; });
        const next = client.sendTurnAndWait('queued during compaction');
        vi.useFakeTimers();
        try {
            await vi.advanceTimersByTimeAsync(30 * 60 * 1000);
            expect(idle).toBe(false);
            expect(requests.filter(request => request.method === 'turn/start')).toHaveLength(0);
            // An idle status or the item alone is insufficient; the turn must finish.
            notify('thread/status/changed', { threadId: 'thread-reliable', status: { type: 'idle' } });
            notify('item/completed', { threadId: 'thread-reliable', turnId: 'compact-turn', item: { id: 'compact-item', type: 'contextCompaction' } });
            await vi.advanceTimersByTimeAsync(1);
            expect(idle).toBe(false);
            complete('compact-turn');
            await barrier;
            await vi.advanceTimersByTimeAsync(1);
            expect(requests.filter(request => request.method === 'turn/start')).toHaveLength(1);
            complete('turn-1');
            await next;
        } finally { vi.useRealTimers(); }
        notify('turn/started', { threadId: 'thread-reliable', turn: { id: 'compact-disconnect', status: 'inProgress' } });
        await waitFor(() => client.turnId === 'compact-disconnect');
        const disconnected = expect(client.waitForTurnIdle()).rejects.toThrow('disconnected');
        await client.disconnect();
        await disconnected;
        await expect(client.waitForTurnIdle()).rejects.toThrow('disconnected');
    });

    it('deduplicates interrupt requests and requires the exact authoritative interrupted status', async () => {
        const { client, requests, events, complete } = await runningClient();
        const turn = client.sendTurnAndWait('work');
        await waitFor(() => client.turnId === 'turn-1');
        await Promise.all([client.interruptTurn(), client.interruptTurn(), client.interruptTurn()]);
        await client.interruptTurn(); // Acknowledged requests remain idempotent until terminal state.
        expect(requests.filter((request) => request.method === 'turn/interrupt')).toHaveLength(1);
        expect(events.filter((event) => event.type === 'codex_interrupt').map((event) => event.status)).toEqual(['requested', 'acknowledged']);
        expect(events.some((event) => event.type === 'turn_aborted')).toBe(false);
        expect(client.turnId).toBe('turn-1');
        complete('turn-1', 'interrupted');
        await expect(turn).resolves.toEqual({ aborted: true });
        const abort = events.find((event) => event.type === 'turn_aborted');
        expect(abort.protocol).toMatchObject({ threadId: 'thread-reliable', turnId: 'turn-1', epoch: expect.any(String), seq: expect.any(Number) });
        await client.disconnect();
    });

    it.each([false, true])('does not wait for a process that was never approved when interrupted (request resolved first: %s)', async (resolvedFirst) => {
        const { client, proc, requests, events, notify } = await runningClient((msg, stdout) => {
            if (msg.method === 'thread/backgroundTerminals/list') queueMicrotask(() => pushJsonLine(stdout, { id: msg.id, result: { data: [], nextCursor: null } }));
            if (msg.method === 'turn/interrupt') queueMicrotask(() => {
                if (resolvedFirst) pushJsonLine(stdout, { method: 'serverRequest/resolved', params: { threadId: 'thread-reliable', requestId: 'unapproved-command' } });
                pushJsonLine(stdout, { method: 'turn/completed', params: { threadId: 'thread-reliable', turn: { id: 'turn-1', status: 'interrupted' } } });
            });
        });
        client.setApprovalHandler(() => new Promise(() => {}));
        const turn = client.sendTurnAndWait('approval required');
        await waitFor(() => client.turnId === 'turn-1');
        notify('item/started', { threadId: 'thread-reliable', turnId: 'turn-1', item: { type: 'commandExecution', id: 'unapproved-item', status: 'inProgress', processId: null, command: 'echo approved', cwd: '/work' } });
        pushJsonLine(proc.stdout, { id: 'unapproved-command', method: 'item/commandExecution/requestApproval', params: { threadId: 'thread-reliable', turnId: 'turn-1', itemId: 'unapproved-item', command: 'echo approved', cwd: '/work' } });
        await waitFor(() => events.some(event => event.type === 'codex_request' && event.status === 'pending'));
        expect(events.some(event => event.type === 'exec_command_end')).toBe(false);
        await expect(client.abortTurnWithFallback({ gracePeriodMs: 0, commandCleanupTimeoutMs: 50 })).resolves.toMatchObject({ aborted: true, forcedRestart: false });
        await expect(turn).resolves.toEqual({ aborted: true });
        expect(events.filter(event => event.type === 'exec_command_end')).toEqual([expect.objectContaining({
            call_id: 'unapproved-item', commandNotStarted: true, completedByTurn: true, status: 'interrupted', exit_code: null,
            protocol: expect.objectContaining({ threadId: 'thread-reliable', turnId: 'turn-1', itemId: 'unapproved-item' }),
        })]);
        expect(events.some(event => event.type === 'codex_command_cleanup')).toBe(false);
        expect(requests.some(request => request.method === 'thread/backgroundTerminals/terminate')).toBe(false);
        expect(client.turnId).toBeNull();
        await client.disconnect();
    });

    it('keeps interruption pending until the exact native command disappears, preserving output during cleanup', async () => {
        let live = true;
        const native = { itemId: 'native-command', processId: 'native-process', command: 'python work', cwd: '/work', osPid: 7777 };
        const { client, requests, events, notify } = await runningClient((msg, stdout) => {
            if (msg.method === 'thread/backgroundTerminals/list') queueMicrotask(() => pushJsonLine(stdout, {
                id: msg.id, result: { data: [...(live ? [native] : []), { ...native, itemId: 'other-turn-command', processId: 'unrelated-process' }], nextCursor: null },
            }));
            if (msg.method === 'thread/backgroundTerminals/terminate') queueMicrotask(() => pushJsonLine(stdout, { id: msg.id, result: { terminated: true } }));
            if (msg.method === 'turn/interrupt') queueMicrotask(() => pushJsonLine(stdout, { method: 'turn/completed', params: {
                threadId: 'thread-reliable', turn: { id: 'turn-1', status: 'interrupted' },
            } }));
        });
        const turn = client.sendTurnAndWait('work');
        await waitFor(() => client.turnId === 'turn-1');
        notify('item/started', { threadId: 'thread-reliable', turnId: 'turn-1', item: {
            type: 'commandExecution', id: native.itemId, processId: native.processId, status: 'inProgress', command: native.command,
        } });
        const abort = client.abortTurnWithFallback({ gracePeriodMs: 0, commandCleanupTimeoutMs: 1_000 });
        await waitFor(() => requests.some((request) => request.method === 'thread/backgroundTerminals/terminate'));
        expect(client.turnId).toBe('turn-1');
        expect(events.some((event) => event.type === 'turn_aborted')).toBe(false);
        notify('item/commandExecution/outputDelta', { threadId: 'thread-reliable', turnId: 'turn-1', itemId: native.itemId, delta: 'last bytes' });
        expect(events).toContainEqual(expect.objectContaining({ type: 'exec_command_output_delta', delta: 'last bytes' }));
        expect(requests.filter((request) => request.method === 'thread/backgroundTerminals/terminate')).toEqual([
            expect.objectContaining({ params: { threadId: 'thread-reliable', processId: native.processId } }),
        ]);
        live = false;
        await expect(abort).resolves.toMatchObject({ aborted: true, forcedRestart: false });
        await expect(turn).resolves.toEqual({ aborted: true });
        expect(events.filter((event) => event.type === 'codex_command_cleanup').map((event) => event.status)).toEqual(['pending', 'confirmed']);
        expect(events.find((event) => event.type === 'turn_aborted')).toMatchObject({ commands_confirmed: true, cleanup_item_ids: [native.itemId] });
        expect(client.turnId).toBeNull();
        await client.disconnect();
    });

    it('reports cleanup failure without claiming stopped and permits a scoped retry', async () => {
        let visible = false;
        let live = true;
        const { client, requests, events, notify } = await runningClient((msg, stdout) => {
            if (msg.method === 'thread/backgroundTerminals/list') queueMicrotask(() => pushJsonLine(stdout, { id: msg.id, result: {
                data: visible && live ? [{ itemId: 'native-command', processId: 'native-process' }] : [], nextCursor: null,
            } }));
            if (msg.method === 'thread/backgroundTerminals/terminate') {
                live = false;
                queueMicrotask(() => pushJsonLine(stdout, { id: msg.id, result: { terminated: true } }));
            }
            if (msg.method === 'turn/interrupt') queueMicrotask(() => pushJsonLine(stdout, { method: 'turn/completed', params: {
                threadId: 'thread-reliable', turn: { id: 'turn-1', status: 'interrupted' },
            } }));
        });
        const turn = client.sendTurnAndWait('work');
        await waitFor(() => client.turnId === 'turn-1');
        notify('item/started', { threadId: 'thread-reliable', turnId: 'turn-1', item: {
            type: 'commandExecution', id: 'native-command', processId: 'native-process', status: 'inProgress',
        } });
        await expect(client.abortTurnWithFallback({ gracePeriodMs: 0, commandCleanupTimeoutMs: 20, forceRestartOnTimeout: true })).resolves.toMatchObject({ aborted: false, forcedRestart: false });
        expect(events.some((event) => event.type === 'turn_aborted')).toBe(false);
        expect(events).toContainEqual(expect.objectContaining({ type: 'codex_command_cleanup', status: 'failed' }));
        expect(client.turnId).toBe('turn-1');
        await expect(client.sendTurnAndWait('overlap')).rejects.toThrow('still active');
        await expect(client.forkThread()).rejects.toThrow('Finish native command interruption');
        visible = true;
        await expect(client.abortTurnWithFallback({ expectedTurnId: 'turn-1', commandCleanupTimeoutMs: 1_000 })).resolves.toMatchObject({ aborted: true });
        expect(requests.filter((request) => request.method === 'turn/interrupt')).toHaveLength(1);
        await expect(turn).resolves.toEqual({ aborted: true });
        await client.disconnect();
    });

    it('keeps a turn active on an unconfirmed interrupt and allows a retry', async () => {
        const { client, requests, events, complete } = await runningClient();
        const turn = client.sendTurnAndWait('work');
        await waitFor(() => client.turnId === 'turn-1');
        await expect(client.abortTurnWithFallback({ gracePeriodMs: 0 })).resolves.toEqual({
            hadActiveTurn: true, aborted: false, forcedRestart: false, resumedThread: false,
        });
        expect(client.turnId).toBe('turn-1');
        expect(events.some((event) => event.type === 'turn_aborted')).toBe(false);
        expect(events).toContainEqual(expect.objectContaining({ type: 'codex_interrupt', status: 'failed' }));
        await client.interruptTurn();
        expect(requests.filter((request) => request.method === 'turn/interrupt')).toHaveLength(2);
        complete('turn-1');
        await expect(turn).resolves.toEqual({ aborted: false });
        await client.disconnect();
    });

    it('rejects a completion timeout without claiming interruption or permitting an overlapping turn', async () => {
        const { client, events, complete } = await runningClient();
        await expect(client.sendTurnAndWait('work', { turnTimeoutMs: 10 })).rejects.toThrow('not confirmed');
        expect(client.turnId).toBe('turn-1');
        expect(events.some((event) => ['turn_aborted', 'task_complete'].includes(event.type))).toBe(false);
        await expect(client.sendTurnAndWait('overlap')).rejects.toThrow('still active');
        complete('turn-1');
        await waitFor(() => client.turnId === null);
        await client.disconnect();
    });

    it('isolates duplicate and cross-thread terminal events from the next turn', async () => {
        const { client, events, complete, notify } = await runningClient();
        const first = client.sendTurnAndWait('one');
        await waitFor(() => client.turnId === 'turn-1');
        complete('turn-1');
        await first;
        const next = client.sendTurnAndWait('two');
        await waitFor(() => client.turnId === 'turn-2');
        complete('turn-1', 'interrupted');
        complete('turn-2', 'interrupted', 'another-thread');
        notify('turn/started', { threadId: 'thread-reliable', turn: { id: 'turn-1', status: 'inProgress' } });
        notify('item/agentMessage/delta', { threadId: 'thread-reliable', turnId: 'turn-1', itemId: 'stale', delta: 'old' });
        expect(client.turnId).toBe('turn-2');
        expect(events.filter((event) => event.type === 'task_complete')).toHaveLength(1);
        expect(events.some((event) => event.type === 'turn_aborted')).toBe(false);
        expect(events.some((event) => event.item_id === 'stale')).toBe(false);
        complete('turn-2');
        await expect(next).resolves.toEqual({ aborted: false });
        await client.disconnect();
    });

    it('preserves a real late command completion for its ended turn without reopening activity or accepting deltas', async () => {
        const { client, events, complete, notify } = await runningClient();
        const first = client.sendTurnAndWait('one');
        await waitFor(() => client.turnId === 'turn-1');
        complete('turn-1', 'interrupted');
        await first;
        const next = client.sendTurnAndWait('two');
        await waitFor(() => client.turnId === 'turn-2');
        const startCount = events.filter((event) => event.type === 'task_started').length;
        const activityCount = events.filter((event) => event.type === 'codex_activity').length;
        const params = {
            threadId: 'thread-reliable', turnId: 'turn-1',
            item: { id: 'old-command', type: 'commandExecution', status: 'failed', aggregatedOutput: 'final output', exitCode: 130, durationMs: 32 },
        };
        notify('item/completed', { ...params, threadId: 'other-branch' });
        notify('item/started', params);
        notify('item/commandExecution/outputDelta', { threadId: 'thread-reliable', turnId: 'turn-1', itemId: 'old-command', delta: 'late output' });
        notify('item/completed', params);
        const ends = events.filter((event) => event.type === 'exec_command_end');
        expect(ends).toHaveLength(1);
        expect(ends[0]).toMatchObject({
            call_id: 'old-command', output: 'final output', exit_code: 130, duration_ms: 32,
            protocol: { threadId: 'thread-reliable', turnId: 'turn-1', itemId: 'old-command' },
        });
        expect(client.turnId).toBe('turn-2');
        expect(events.filter((event) => event.type === 'task_started')).toHaveLength(startCount);
        expect(events.filter((event) => event.type === 'codex_activity')).toHaveLength(activityCount);
        expect(events.some((event) => event.type === 'exec_command_output_delta')).toBe(false);
        complete('turn-2');
        await expect(next).resolves.toEqual({ aborted: false });
        await client.disconnect();
    });

    it('preserves full raw notifications and replays normalized events with their original cursor', async () => {
        const { client, events, notify } = await runningClient();
        const delta = '中文'.repeat(10_000);
        notify('item/future/outputDelta', { threadId: 'thread-reliable', turnId: 'turn-future', itemId: 'item-future', delta });
        const { replayCodexProtocolJournal, replayedCodexEvent } = await import('./codexProtocolJournal');
        const records = [];
        for await (const record of replayCodexProtocolJournal(client.protocolJournalPath)) records.push(record);
        const raw = records.find((record: any) => record.kind === 'raw' && record.message.method === 'item/future/outputDelta');
        expect((raw?.message as any).params.delta).toBe(delta);
        expect(raw?.protocol).toMatchObject({ threadId: 'thread-reliable', turnId: 'turn-future', itemId: 'item-future' });
        expect(records.map((record) => record.protocol.seq)).toEqual(records.map((_, index) => index + 1));
        expect(records.map(replayedCodexEvent).filter(Boolean)).toEqual(events);
        const resumed = [];
        for await (const record of replayCodexProtocolJournal(client.protocolJournalPath, { afterSeq: raw!.protocol.seq })) resumed.push(record);
        expect(resumed).toHaveLength(1);
        await client.disconnect();
    });

    it('does not submit a user answer after its server request has been resolved', async () => {
        const { client, proc, events, requests, notify } = await runningClient();
        let answer!: (value: { answers: Record<string, { answers: string[] }> }) => void;
        client.setUserInputHandler(() => new Promise((resolve) => { answer = resolve; }));
        pushJsonLine(proc.stdout, { id: 'question-1', method: 'item/tool/requestUserInput', params: {
            threadId: 'thread-reliable', turnId: 'turn-1', itemId: 'question-item', questions: [], autoResolutionMs: null,
        } });
        await waitFor(() => !!answer);
        notify('serverRequest/resolved', { threadId: 'thread-reliable', requestId: 'question-1' });
        answer({ answers: {} });
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(requests.some((request) => request.id as unknown === 'question-1' && request.result)).toBe(false);
        expect(events.filter((event) => event.type === 'codex_request').map((event) => event.status)).toEqual(['pending', 'resolved']);
        expect(events.find((event) => event.type === 'codex_request').protocol).toMatchObject({
            requestId: 'question-1', threadId: 'thread-reliable', turnId: 'turn-1', itemId: 'question-item',
        });
        await client.disconnect();
    });

    it('orders a fast completion that arrives before turn/start responds and emits a correlated start', async () => {
        const events: any[] = [];
        const proc = createMockProcess({ onRequest: (msg, stdout) => {
            if (msg.method === 'thread/start') queueMicrotask(() => pushJsonLine(stdout, { id: msg.id, result: { thread: { id: 'fast-thread' } } }));
            if (msg.method === 'turn/start') queueMicrotask(() => {
                pushJsonLine(stdout, { method: 'turn/completed', params: { threadId: 'fast-thread', turn: { id: 'old-turn', status: 'interrupted' } } });
                pushJsonLine(stdout, { method: 'turn/completed', params: { threadId: 'fast-thread', turn: { id: 'fast-turn', status: 'completed' } } });
                pushJsonLine(stdout, { id: msg.id, result: { turn: { id: 'fast-turn' } } });
            });
        } });
        mockSpawn.mockImplementation(() => proc);
        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();
        client.setEventHandler((event) => events.push(event));
        await client.connect();
        await client.startThread({});
        await expect(client.sendTurnAndWait('fast')).resolves.toEqual({ aborted: false });
        expect(client.turnId).toBeNull();
        expect(events.filter((event) => ['task_started', 'task_complete', 'turn_aborted'].includes(event.type)).map((event) => [event.type, event.protocol.turnId]))
            .toEqual([['task_started', 'fast-turn'], ['task_complete', 'fast-turn']]);
        await client.disconnect();
    });

    it('opts into the experimental fields it uses without marking an unknown CLI contract verified', async () => {
        for (const version of ['0.153.4', '0.156.1', '0.159.0']) {
            mockExecSync.mockReturnValue(`codex-cli ${version}`);
            const verified = await runningClient();
            expect(verified.requests.find((request) => request.method === 'initialize')?.params.capabilities.experimentalApi).toBe(true);
            expect(verified.events[0]).toMatchObject({ type: 'codex_runtime_started', verified: true, cliVersion: version });
            await verified.client.disconnect();
        }
        mockExecSync.mockReturnValue('codex-cli 0.999.0');
        const unknown = await runningClient();
        expect(unknown.requests.find((request) => request.method === 'initialize')?.params.capabilities.experimentalApi).toBe(true);
        expect(unknown.events[0]).toMatchObject({ type: 'codex_runtime_started', verified: false, cliVersion: '0.999.0' });
        await unknown.client.disconnect();
    });

    it.each(['default', 'plan'] as const)('can start a %s turn after a CLI patch update enforces the experimental capability', async (mode) => {
        mockExecSync.mockReturnValue('codex-cli 0.159.2');
        let experimentalApi = false;
        const proc = createMockProcess({ onRequest: (msg, stdout) => {
            if (msg.method === 'initialize') experimentalApi = msg.params.capabilities.experimentalApi === true;
            if (msg.method === 'thread/start') queueMicrotask(() => pushJsonLine(stdout, {
                id: msg.id, result: { thread: { id: 'patched-thread', status: { type: 'idle' } }, model: 'test' },
            }));
            if (msg.method === 'turn/start') queueMicrotask(() => {
                if (msg.params.collaborationMode && !experimentalApi) {
                    pushJsonLine(stdout, { id: msg.id, error: { code: -32600,
                        message: 'turn/start.collaborationMode requires experimentalApi capability' } });
                    return;
                }
                pushJsonLine(stdout, { id: msg.id, result: { turn: { id: 'patched-turn' } } });
                pushJsonLine(stdout, { method: 'turn/completed', params: {
                    threadId: 'patched-thread', turn: { id: 'patched-turn', status: 'completed' },
                } });
            });
        } });
        mockSpawn.mockImplementation(() => proc);
        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();
        await client.connect();
        await client.startThread({});
        await expect(client.sendTurnAndWait('check', { collaborationMode: mode })).resolves.toEqual({ aborted: false });
        await client.disconnect();
    });

    it('rejects a late resume response instead of replacing the currently selected branch', async () => {
        const { client, proc, requests, events } = await runningClient();
        const older = client.resumeThread({ threadId: 'older-branch' });
        const olderCheck = expect(older).rejects.toThrow('stale Codex thread/resume');
        const current = client.resumeThread({ threadId: 'current-branch' });
        const oldRequest = requests.find((request) => request.method === 'thread/resume' && request.params.threadId === 'older-branch')!;
        const currentRequest = requests.find((request) => request.method === 'thread/resume' && request.params.threadId === 'current-branch')!;
        pushJsonLine(proc.stdout, { id: currentRequest.id, result: { thread: { id: 'current-branch', status: { type: 'idle' } }, model: 'test' } });
        await current;
        pushJsonLine(proc.stdout, { id: oldRequest.id, result: { thread: { id: 'older-branch', status: { type: 'active', activeFlags: [] } }, model: 'test' } });
        await olderCheck;
        expect(client.threadId).toBe('current-branch');
        expect(events.some((event) => event.type === 'codex_thread_status' && event.protocol.threadId === 'older-branch')).toBe(false);
        await client.disconnect();
    });

    it('exposes an initialized unloaded runtime and distinguishes thread snapshots from notifications', async () => {
        const { client, events, notify } = await runningClient();
        const statuses = () => events.filter((event) => event.type === 'codex_thread_status');
        expect(statuses()).toMatchObject([
            { source: 'snapshot', status: { type: 'notLoaded' } },
            { source: 'snapshot', status: { type: 'idle' }, protocol: { threadId: 'thread-reliable' } },
        ]);
        expect(statuses()[0].protocol.threadId).toBeUndefined();
        notify('thread/status/changed', { threadId: 'old-branch', status: { type: 'active', activeFlags: [] } });
        notify('thread/status/changed', { threadId: 'thread-reliable', status: { type: 'idle' } });
        expect(statuses()).toHaveLength(3);
        expect(statuses()[2]).toMatchObject({ source: 'notification', protocol: { threadId: 'thread-reliable' } });
        expect(statuses().some((event) => event.protocol.threadId === 'old-branch')).toBe(false);
        await client.disconnect();
    });

    it('rejects a late server request for a completed turn without reopening user interaction', async () => {
        const { client, proc, events, requests, complete } = await runningClient();
        const userInput = vi.fn(async () => ({ answers: {} }));
        client.setUserInputHandler(userInput);
        const turn = client.sendTurnAndWait('finish');
        await waitFor(() => client.turnId === 'turn-1');
        complete('turn-1');
        await turn;
        pushJsonLine(proc.stdout, { id: 'late-question', method: 'item/tool/requestUserInput', params: {
            threadId: 'thread-reliable', turnId: 'turn-1', itemId: 'question-item', questions: [], autoResolutionMs: null,
        } });
        expect(userInput).not.toHaveBeenCalled();
        expect(events.some((event) => event.type === 'codex_request' || event.type === 'codex_request_user_input')).toBe(false);
        expect(requests).toContainEqual(expect.objectContaining({
            id: 'late-question', error: { code: -32600, message: 'Request targets a completed Codex turn' },
        }));
        await client.disconnect();
    });

    it('exposes a pending turn start and correlates an RPC rejection to that start', async () => {
        const requests: MockRpcMessage[] = [];
        const events: any[] = [];
        const proc = createMockProcess({ onRequest: (msg, stdout) => {
            requests.push(msg);
            if (msg.method === 'thread/start') queueMicrotask(() => pushJsonLine(stdout, {
                id: msg.id, result: { thread: { id: 'start-thread', status: { type: 'idle' } }, model: 'test' },
            }));
        } });
        mockSpawn.mockImplementation(() => proc);
        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();
        client.setEventHandler((event) => events.push(event));
        await client.connect();
        await client.startThread({});
        const pending = client.sendTurnAndWait('start');
        const check = expect(pending).rejects.toThrow('invalid request');
        const starting = events.find((event) => event.type === 'codex_turn_starting');
        expect(starting).toMatchObject({ startId: expect.any(String), protocol: { threadId: 'start-thread' } });
        expect(starting.protocol.turnId).toBeUndefined();
        expect(client.startId).toBe(starting.startId);
        const request = requests.find((msg) => msg.method === 'turn/start')!;
        pushJsonLine(proc.stdout, { id: request.id, error: { code: -32602, message: 'invalid request' } });
        await check;
        expect(events).toContainEqual(expect.objectContaining({ type: 'codex_turn_start_failed', startId: starting.startId }));
        expect(client.startId).toBeNull();
        await client.disconnect();
    });

    it('keeps an interrupt of a pending start from crossing into the next queued turn', async () => {
        const requests: MockRpcMessage[] = [];
        const proc = createMockProcess({ onRequest: (msg, stdout) => {
            requests.push(msg);
            if (msg.method === 'thread/start') queueMicrotask(() => pushJsonLine(stdout, {
                id: msg.id, result: { thread: { id: 'start-thread', status: { type: 'idle' } }, model: 'test' },
            }));
        } });
        mockSpawn.mockImplementation(() => proc);
        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();
        await client.connect();
        await client.startThread({});
        const first = client.sendTurnAndWait('first');
        const firstStartId = client.startId!;
        const abort = client.abortTurnWithFallback({ expectedStartId: firstStartId, gracePeriodMs: 0 });
        const next = client.sendTurnAndWait('next');
        expect(requests.filter((msg) => msg.method === 'turn/start')).toHaveLength(1);
        const finishStart = (index: number, turnId: string) => {
            const request = requests.filter((msg) => msg.method === 'turn/start')[index]!;
            pushJsonLine(proc.stdout, { id: request.id, result: { turn: { id: turnId } } });
            pushJsonLine(proc.stdout, { method: 'turn/started', params: { threadId: 'start-thread', turn: { id: turnId, status: 'inProgress' } } });
            pushJsonLine(proc.stdout, { method: 'turn/completed', params: { threadId: 'start-thread', turn: { id: turnId, status: 'completed' } } });
        };
        finishStart(0, 'old-turn');
        await expect(first).resolves.toEqual({ aborted: false });
        await expect(abort).resolves.toMatchObject({ hadActiveTurn: false, aborted: false });
        await waitFor(() => requests.filter((msg) => msg.method === 'turn/start').length === 2);
        expect(client.startId).not.toBe(firstStartId);
        await expect(client.abortTurnWithFallback({ expectedStartId: firstStartId, gracePeriodMs: 0 })).resolves.toMatchObject({ hadActiveTurn: false });
        expect(requests.some((msg) => msg.method === 'turn/interrupt')).toBe(false);
        finishStart(1, 'next-turn');
        await expect(next).resolves.toEqual({ aborted: false });
        await client.disconnect();
    });

    it('wraps transport when sandbox is enabled', async () => {
        // Dynamic import to ensure mocks are applied
        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient(sandboxConfig);

        await client.connect();

        expect(mockInitializeSandbox).toHaveBeenCalledWith(sandboxConfig, process.cwd());
        expect(mockWrapForMcpTransport).toHaveBeenCalledWith('codex', ['app-server', '--listen', 'stdio://']);
        expect(mockSpawn).toHaveBeenCalledWith(
            'sh',
            ['-c', 'wrapped codex app-server'],
            expect.objectContaining({
                env: expect.objectContaining({
                    CODEX_SANDBOX: 'seatbelt',
                    RUST_LOG: expect.stringContaining('codex_core::rollout::list=off'),
                }),
            }),
        );
        expect(client.sandboxEnabled).toBe(true);

        await client.disconnect();
    });

    it('falls back to non-sandbox transport when sandbox initialization fails', async () => {
        mockInitializeSandbox.mockRejectedValue(new Error('sandbox init failed'));
        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient(sandboxConfig);

        await client.connect();

        expect(mockWrapForMcpTransport).not.toHaveBeenCalled();
        expect(mockSpawn).toHaveBeenCalledWith(
            'codex',
            ['app-server', '--listen', 'stdio://'],
            expect.objectContaining({
                env: expect.objectContaining({
                    RUST_LOG: expect.stringContaining('codex_core::rollout::list=off'),
                }),
            }),
        );
        expect(client.sandboxEnabled).toBe(false);

        await client.disconnect();
    });

    it('forwards raw codex CLI args when spawning app-server', async () => {
        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient(undefined, [
            '-m', 'gpt-5',
            '-c', 'openai_base_url=http://proxy/v1',
            '--disable', 'responses_websockets',
        ]);

        await client.connect();

        expect(mockSpawn).toHaveBeenCalledWith(
            'codex',
            [
                '-m', 'gpt-5',
                '-c', 'openai_base_url=http://proxy/v1',
                '--disable', 'responses_websockets',
                'app-server', '--listen', 'stdio://',
            ],
            expect.anything(),
        );

        await client.disconnect();
    });

    it('uses an isolated executable override for both version probing and app-server launch', async () => {
        const original = process.env.HAPLA_CODEX_PATH;
        const executable = '/tmp/isolated codex/bin/codex';
        process.env.HAPLA_CODEX_PATH = executable;
        try {
            const { CodexAppServerClient } = await import('./codexAppServerClient');
            const client = new CodexAppServerClient();
            await client.connect();
            expect(mockExecSync).toHaveBeenCalledWith(executable, ['--version'], expect.objectContaining({ encoding: 'utf8' }));
            expect(mockSpawn).toHaveBeenCalledWith(executable, ['app-server', '--listen', 'stdio://'], expect.anything());
            await client.disconnect();
        } finally {
            if (original === undefined) delete process.env.HAPLA_CODEX_PATH;
            else process.env.HAPLA_CODEX_PATH = original;
        }
    });

    it('reads every page of the installed Codex model catalog', async () => {
        const proc = createMockProcess({
            onRequest: (msg, stdout) => {
                if (msg.method !== 'model/list' || msg.id == null) return;

                const cursor = msg.params?.cursor;
                setTimeout(() => {
                    pushJsonLine(stdout, {
                        id: msg.id,
                        result: cursor
                            ? {
                                data: [{
                                    id: 'catalog-2', model: 'gpt-second', displayName: 'GPT Second', description: '',
                                    isDefault: false, hidden: false, defaultReasoningEffort: 'medium', supportedReasoningEfforts: [],
                                }],
                                nextCursor: null,
                            }
                            : {
                                data: [{
                                    id: 'catalog-1', model: 'gpt-first', displayName: 'GPT First', description: '',
                                    isDefault: true, hidden: false, defaultReasoningEffort: 'medium', supportedReasoningEfforts: [],
                                }],
                                nextCursor: 'page-2',
                            },
                    });
                }, 0);
            },
        });
        mockSpawn.mockImplementation(() => proc);

        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();
        await client.connect();

        await expect(client.listModels()).resolves.toMatchObject([
            { model: 'gpt-first', isDefault: true },
            { model: 'gpt-second', isDefault: false },
        ]);

        await client.disconnect();
    });

    it('resets sandbox on disconnect', async () => {
        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient(sandboxConfig);

        await client.connect();
        await client.disconnect();

        expect(mockSandboxCleanup).toHaveBeenCalledTimes(1);
        expect(client.sandboxEnabled).toBe(false);
    });

    it('appends rollout log filter to existing RUST_LOG', async () => {
        process.env.RUST_LOG = 'info,codex_core=warn';
        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient(sandboxConfig);

        await client.connect();

        expect(mockSpawn).toHaveBeenCalledWith(
            expect.anything(),
            expect.anything(),
            expect.objectContaining({
                env: expect.objectContaining({
                    RUST_LOG: 'info,codex_core=warn,codex_core::rollout::list=off',
                }),
            }),
        );

        await client.disconnect();
    });

    it('ignores stale process exit during reconnect initialize', async () => {
        const proc1 = createMockProcess({ pid: 1001, initializeDelayMs: 5 });
        const proc2 = createMockProcess({ pid: 1002, initializeDelayMs: 50 });
        mockSpawn
            .mockImplementationOnce(() => proc1)
            .mockImplementationOnce(() => proc2);

        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();

        await client.connect();
        await client.disconnect();

        const reconnect = client.connect();
        setTimeout(() => {
            proc1.emit('exit', 0, null);
        }, 10);

        await expect(reconnect).resolves.toBeUndefined();
        await client.disconnect();
    });

    it('reports an unconfirmed interrupt honestly while explicitly restarting and resuming the same thread', async () => {
        const firstProcessRequests: MockRpcMessage[] = [];
        const secondProcessRequests: MockRpcMessage[] = [];
        type CapturedEvent = { type: string; [key: string]: unknown };

        const proc1 = createMockProcess({
            pid: 2001,
            onRequest: (msg, stdout) => {
                firstProcessRequests.push(msg);

                if (msg.method === 'thread/start' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, {
                            id: msg.id,
                            result: {
                                thread: { id: 'thread-1', path: '/tmp/thread-1' },
                                model: 'gpt-test',
                                modelProvider: 'openai',
                                cwd: '/tmp/project',
                                approvalPolicy: 'on-request',
                                sandbox: { type: 'readOnly' },
                                reasoningEffort: null,
                            },
                        });
                    }, 0);
                }

                if (msg.method === 'turn/start' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, { id: msg.id, result: {} });
                        pushJsonLine(stdout, {
                            method: 'codex/event',
                            params: { msg: { type: 'task_started', turn_id: 'turn-1' } },
                        });
                    }, 0);
                }

                if (msg.method === 'turn/interrupt' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, { id: msg.id, result: { abortReason: 'interrupted' } });
                    }, 0);
                }
            },
        });

        const proc2 = createMockProcess({
            pid: 2002,
            onRequest: (msg, stdout) => {
                secondProcessRequests.push(msg);

                if (msg.method === 'thread/resume' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, {
                            id: msg.id,
                            result: {
                                thread: { id: 'thread-1', path: '/tmp/thread-1' },
                                model: 'gpt-test',
                                modelProvider: 'openai',
                                cwd: '/tmp/project',
                                approvalPolicy: 'on-request',
                                sandbox: { type: 'readOnly' },
                                reasoningEffort: null,
                            },
                        });
                    }, 0);
                }

                if (msg.method === 'turn/start' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, { id: msg.id, result: {} });
                        pushJsonLine(stdout, {
                            method: 'codex/event',
                            params: { msg: { type: 'task_started', turn_id: 'turn-2' } },
                        });
                        pushJsonLine(stdout, {
                            method: 'codex/event',
                            params: { msg: { type: 'task_complete', turn_id: 'turn-2' } },
                        });
                    }, 0);
                }
            },
        });

        mockSpawn
            .mockImplementationOnce(() => proc1)
            .mockImplementationOnce(() => proc2);

        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();
        const events: CapturedEvent[] = [];
        client.setEventHandler((msg) => {
            events.push(msg as CapturedEvent);
        });

        await client.connect();
        await client.startThread({
            model: 'gpt-test',
            cwd: '/tmp/project',
            approvalPolicy: 'on-request',
            sandbox: 'read-only',
        });

        const pendingTurn = client.sendTurnAndWait('hang forever', { turnTimeoutMs: 5000 });
        const pendingTurnCheck = expect(pendingTurn).rejects.toThrow('disconnected before confirming');
        await waitFor(() => firstProcessRequests.some((msg) => msg.method === 'turn/start'));

        const abortResult = await client.abortTurnWithFallback({
            gracePeriodMs: 1,
            forceRestartOnTimeout: true,
        });

        await pendingTurnCheck;
        expect(abortResult).toEqual({
            hadActiveTurn: true,
            aborted: false,
            forcedRestart: true,
            resumedThread: true,
        });
        expect(events).toContainEqual(expect.objectContaining({
            type: 'codex_runtime_error',
            reason: 'interruptUnconfirmed',
            turn_id: 'turn-1',
            forced_restart: true,
        }));

        const resumeRequest = secondProcessRequests.find((msg) => msg.method === 'thread/resume');
        expect(resumeRequest?.params).toEqual(expect.objectContaining({
            threadId: 'thread-1',
            model: 'gpt-test',
            cwd: '/tmp/project',
            approvalPolicy: 'on-request',
            sandbox: 'read-only',
            persistExtendedHistory: true,
        }));
        expect(client.threadId).toBe('thread-1');

        await expect(client.sendTurnAndWait('follow up after reconnect')).resolves.toEqual({ aborted: false });

        await client.disconnect();
    });

    it('maps raw item notifications into legacy events and deduplicates turn completion', async () => {
        const requests: MockRpcMessage[] = [];
        const proc = createMockProcess({
            pid: 3001,
            onRequest: (msg, stdout) => {
                requests.push(msg);

                if (msg.method === 'thread/start' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, {
                            id: msg.id,
                            result: {
                                thread: { id: 'thread-raw-1', path: '/tmp/thread-raw-1' },
                                model: 'gpt-test',
                                modelProvider: 'openai',
                                cwd: '/tmp/project',
                                approvalPolicy: 'never',
                                sandbox: { type: 'dangerFullAccess' },
                                reasoningEffort: null,
                            },
                        });
                    }, 0);
                }

                if (msg.method === 'turn/start' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, {
                            id: msg.id,
                            result: {
                                turn: { id: 'turn-raw-1', items: [], status: 'inProgress', error: null },
                            },
                        });
                        pushJsonLine(stdout, {
                            method: 'thread/status/changed',
                            params: { threadId: 'thread-raw-1', status: { type: 'active', activeFlags: [] } },
                        });
                        pushJsonLine(stdout, {
                            method: 'turn/started',
                            params: {
                                threadId: 'thread-raw-1',
                                turn: { id: 'turn-raw-1', items: [], status: 'inProgress', error: null },
                            },
                        });
                        pushJsonLine(stdout, {
                            method: 'item/started',
                            params: {
                                threadId: 'thread-raw-1',
                                turnId: 'turn-raw-1',
                                item: {
                                    type: 'commandExecution',
                                    id: 'call-1',
                                    command: '/bin/zsh -lc pwd',
                                    cwd: '/tmp/project',
                                    status: 'inProgress',
                                },
                            },
                        });
                        pushJsonLine(stdout, {
                            method: 'item/agentMessage/delta',
                            params: {
                                threadId: 'thread-raw-1',
                                turnId: 'turn-raw-1',
                                itemId: 'msg-1',
                                delta: 'do',
                            },
                        });
                        pushJsonLine(stdout, {
                            method: 'item/agentMessage/delta',
                            params: {
                                threadId: 'thread-raw-1',
                                turnId: 'turn-raw-1',
                                itemId: 'msg-1',
                                delta: 'ne',
                            },
                        });
                        pushJsonLine(stdout, {
                            method: 'item/completed',
                            params: {
                                threadId: 'thread-raw-1',
                                turnId: 'turn-raw-1',
                                item: {
                                    type: 'commandExecution',
                                    id: 'call-1',
                                    command: '/bin/zsh -lc pwd',
                                    cwd: '/tmp/project',
                                    aggregatedOutput: '/tmp/project\n',
                                    exitCode: 0,
                                    durationMs: 1,
                                    status: 'completed',
                                },
                            },
                        });
                        pushJsonLine(stdout, {
                            method: 'item/started',
                            params: {
                                threadId: 'thread-raw-1',
                                turnId: 'turn-raw-1',
                                item: {
                                    type: 'mcpToolCall', id: 'mcp-1', server: 'composer', tool: 'render',
                                    status: 'inProgress', arguments: { face: 2 },
                                    appContext: { connectorId: '', linkId: null, resourceUri: 'ui://composer/v1.html', appName: 'Composer', templateId: null, actionName: null },
                                    pluginId: null, result: null, error: null, durationMs: null,
                                },
                            },
                        });
                        pushJsonLine(stdout, {
                            method: 'item/completed',
                            params: {
                                threadId: 'thread-raw-1',
                                turnId: 'turn-raw-1',
                                item: {
                                    type: 'mcpToolCall', id: 'mcp-1', server: 'composer', tool: 'render',
                                    status: 'completed', arguments: { face: 2 },
                                    appContext: { connectorId: '', linkId: null, resourceUri: 'ui://composer/v1.html', appName: 'Composer', templateId: null, actionName: null },
                                    pluginId: null,
                                    result: { content: [], structuredContent: { face: 2 }, _meta: null },
                                    error: null, durationMs: 4,
                                },
                            },
                        });
                        pushJsonLine(stdout, {
                            method: 'item/completed',
                            params: {
                                threadId: 'thread-raw-1',
                                turnId: 'turn-raw-1',
                                item: {
                                    type: 'agentMessage',
                                    id: 'msg-1',
                                    text: 'done',
                                    phase: 'final_answer',
                                    delivery: 'async',
                                    questions: [{ title: 'Pick a direction', options: ['Continue', 'Stop'] }],
                                },
                            },
                        });
                        pushJsonLine(stdout, {
                            method: 'item/completed',
                            params: {
                                threadId: 'thread-raw-1',
                                turnId: 'turn-raw-1',
                                item: {
                                    type: 'imageGeneration',
                                    id: 'image-1',
                                    status: 'completed',
                                    result: 'generated image',
                                    savedPath: '/home/test/.codex/generated_images/image-1.png',
                                },
                            },
                        });
                        pushJsonLine(stdout, {
                            method: 'rawResponseItem/completed',
                            params: {
                                threadId: 'thread-raw-1',
                                turnId: 'turn-raw-1',
                                item: {
                                    type: 'custom_tool_call_output',
                                    call_id: 'image-provider-call-1',
                                    output: [
                                        { type: 'input_text', text: 'Script failed' },
                                        { type: 'input_text', text: 'image generation failed: http 401 Unauthorized: Your IP is not authorized' },
                                    ],
                                },
                            },
                        });
                        pushJsonLine(stdout, {
                            method: 'thread/status/changed',
                            params: { threadId: 'thread-raw-1', status: { type: 'idle' } },
                        });
                        pushJsonLine(stdout, {
                            method: 'turn/completed',
                            params: {
                                threadId: 'thread-raw-1',
                                turn: { id: 'turn-raw-1', items: [], status: 'completed', error: null },
                            },
                        });
                    }, 0);
                }
            },
        });

        mockSpawn.mockImplementation(() => proc);

        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();
        const events: Array<Record<string, unknown>> = [];
        client.setEventHandler((msg) => {
            events.push(msg as Record<string, unknown>);
        });

        await client.connect();
        await client.startThread({
            model: 'gpt-test',
            cwd: '/tmp/project',
            approvalPolicy: 'never',
            sandbox: 'danger-full-access',
        });

        await expect(client.sendTurnAndWait('run pwd')).resolves.toEqual({ aborted: false });

        expect(events).toEqual(expect.arrayContaining([
            expect.objectContaining({ type: 'task_started', turn_id: 'turn-raw-1' }),
            expect.objectContaining({ type: 'codex_activity', phase: 'executing', itemType: 'commandExecution' }),
            expect.objectContaining({ type: 'codex_activity', phase: 'generating-media', itemType: 'mcpToolCall' }),
            expect.objectContaining({ type: 'exec_command_begin', callId: 'call-1' }),
            expect.objectContaining({ type: 'exec_command_end', callId: 'call-1', output: '/tmp/project\n' }),
            expect.objectContaining({ type: 'agent_message_delta', item_id: 'msg-1', delta: 'do' }),
            expect.objectContaining({ type: 'agent_message_delta', item_id: 'msg-1', delta: 'ne' }),
            expect.objectContaining({ type: 'agent_message', message: 'done', delivery: 'async', questions: [{ title: 'Pick a direction', options: ['Continue', 'Stop'] }] }),
            expect.objectContaining({ type: 'generated_image', path: '/home/test/.codex/generated_images/image-1.png' }),
            expect.objectContaining({
                type: 'image_generation_error',
                call_id: 'image-provider-call-1',
                message: expect.stringContaining('401 Unauthorized'),
            }),
            expect.objectContaining({
                type: 'mcp_tool_call_begin',
                callId: 'mcp-1',
                resource_uri: 'ui://composer/v1.html',
            }),
            expect.objectContaining({
                type: 'mcp_tool_call_end',
                callId: 'mcp-1',
                result: expect.objectContaining({ structuredContent: { face: 2 } }),
            }),
        ]));
        const threadStartRequest = requests.find((message) => message.method === 'thread/start');
        expect(threadStartRequest?.params).toMatchObject({ experimentalRawEvents: false });
        expect(events.filter((event) => event.type === 'task_complete')).toHaveLength(1);
        expect(events).not.toEqual(expect.arrayContaining([
            expect.objectContaining({
                type: 'codex_item',
                item: expect.objectContaining({ type: 'agentMessage' }),
            }),
            expect.objectContaining({
                type: 'codex_item',
                item: expect.objectContaining({ type: 'userMessage' }),
            }),
        ]));

        await client.disconnect();
    });

    it('maps raw file change items into legacy patch events', async () => {
        const proc = createMockProcess({
            pid: 3003,
            onRequest: (msg, stdout) => {
                if (msg.method === 'thread/start' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, {
                            id: msg.id,
                            result: {
                                thread: { id: 'thread-raw-3', path: '/tmp/thread-raw-3' },
                                model: 'gpt-test',
                                modelProvider: 'openai',
                                cwd: '/tmp/project',
                                approvalPolicy: 'never',
                                sandbox: { type: 'dangerFullAccess' },
                                reasoningEffort: null,
                            },
                        });
                    }, 0);
                }

                if (msg.method === 'turn/start' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, {
                            id: msg.id,
                            result: {
                                turn: { id: 'turn-raw-3', items: [], status: 'inProgress', error: null },
                            },
                        });
                        pushJsonLine(stdout, {
                            method: 'turn/started',
                            params: {
                                threadId: 'thread-raw-3',
                                turn: { id: 'turn-raw-3', items: [], status: 'inProgress', error: null },
                            },
                        });
                        pushJsonLine(stdout, {
                            method: 'item/started',
                            params: {
                                threadId: 'thread-raw-3',
                                turnId: 'turn-raw-3',
                                item: {
                                    type: 'fileChange',
                                    id: 'patch-1',
                                    status: 'inProgress',
                                    changes: [{
                                        path: 'README.md',
                                        kind: { type: 'update', move_path: null },
                                        diff: '@@ -1 +1 @@',
                                    }],
                                },
                            },
                        });
                        pushJsonLine(stdout, {
                            method: 'item/completed',
                            params: {
                                threadId: 'thread-raw-3',
                                turnId: 'turn-raw-3',
                                item: {
                                    type: 'fileChange',
                                    id: 'patch-1',
                                    status: 'completed',
                                    changes: [{
                                        path: 'README.md',
                                        kind: { type: 'update', move_path: null },
                                        diff: '@@ -1 +1 @@',
                                    }],
                                },
                            },
                        });
                        pushJsonLine(stdout, {
                            method: 'item/completed',
                            params: {
                                threadId: 'thread-raw-3',
                                turnId: 'turn-raw-3',
                                item: {
                                    type: 'agentMessage',
                                    id: 'msg-3',
                                    text: 'patched',
                                    phase: 'final_answer',
                                },
                            },
                        });
                        pushJsonLine(stdout, {
                            method: 'turn/completed',
                            params: {
                                threadId: 'thread-raw-3',
                                turn: { id: 'turn-raw-3', items: [], status: 'completed', error: null },
                            },
                        });
                    }, 0);
                }
            },
        });

        mockSpawn.mockImplementation(() => proc);

        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();
        const events: Array<Record<string, unknown>> = [];
        client.setEventHandler((msg) => {
            events.push(msg as Record<string, unknown>);
        });

        await client.connect();
        await client.startThread({
            model: 'gpt-test',
            cwd: '/tmp/project',
            approvalPolicy: 'never',
            sandbox: 'danger-full-access',
        });

        await expect(client.sendTurnAndWait('patch the file')).resolves.toEqual({ aborted: false });

        expect(events).toEqual(expect.arrayContaining([
            expect.objectContaining({
                type: 'patch_apply_begin',
                callId: 'patch-1',
                changes: {
                    'README.md': {
                        diff: '@@ -1 +1 @@',
                        kind: { type: 'update', move_path: null },
                    },
                },
            }),
            expect.objectContaining({
                type: 'patch_apply_end',
                callId: 'patch-1',
                status: 'completed',
            }),
        ]));

        await client.disconnect();
    });

    it('hydrates v2 file change approvals from raw item metadata', async () => {
        const approvals: Array<Record<string, unknown>> = [];
        const proc = createMockProcess({
            pid: 3004,
            onRequest: (msg, stdout) => {
                if (msg.method === 'thread/start' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, {
                            id: msg.id,
                            result: {
                                thread: { id: 'thread-raw-4', path: '/tmp/thread-raw-4' },
                                model: 'gpt-test',
                                modelProvider: 'openai',
                                cwd: '/tmp/project',
                                approvalPolicy: 'on-request',
                                sandbox: { type: 'workspaceWrite', writableRoots: [], networkAccess: true, excludeTmpdirEnvVar: false, excludeSlashTmp: false },
                                reasoningEffort: null,
                            },
                        });
                        pushJsonLine(stdout, {
                            method: 'item/started',
                            params: {
                                threadId: 'thread-raw-4',
                                turnId: 'turn-raw-4',
                                item: {
                                    type: 'fileChange',
                                    id: 'patch-approval-1',
                                    status: 'inProgress',
                                    changes: [{
                                        path: 'README.md',
                                        kind: { type: 'update', move_path: null },
                                        diff: '@@ -1 +1 @@',
                                    }],
                                },
                            },
                        });
                        pushJsonLine(stdout, {
                            id: 99,
                            method: 'item/fileChange/requestApproval',
                            params: {
                                threadId: 'thread-raw-4',
                                turnId: 'turn-raw-4',
                                itemId: 'patch-approval-1',
                                reason: null,
                                grantRoot: null,
                            },
                        });
                    }, 0);
                }
            },
        });

        mockSpawn.mockImplementation(() => proc);

        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();
        client.setApprovalHandler(async (params) => {
            approvals.push(params as Record<string, unknown>);
            return 'approved';
        });

        await client.connect();
        await client.startThread({
            model: 'gpt-test',
            cwd: '/tmp/project',
            approvalPolicy: 'on-request',
            sandbox: 'workspace-write',
        });

        await waitFor(() => approvals.length === 1);

        expect(approvals[0]).toEqual(expect.objectContaining({
            type: 'patch',
            callId: 'patch-approval-1',
            fileChanges: {
                'README.md': {
                    diff: '@@ -1 +1 @@',
                    kind: { type: 'update', move_path: null },
                },
            },
            reason: null,
        }));

        await client.disconnect();
    });

    it('waits for raw turn/completed after the final answer item', async () => {
        const proc = createMockProcess({
            pid: 3002,
            onRequest: (msg, stdout) => {
                if (msg.method === 'thread/start' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, {
                            id: msg.id,
                            result: {
                                thread: { id: 'thread-raw-2', path: '/tmp/thread-raw-2' },
                                model: 'gpt-test',
                                modelProvider: 'openai',
                                cwd: '/tmp/project',
                                approvalPolicy: 'never',
                                sandbox: { type: 'dangerFullAccess' },
                                reasoningEffort: null,
                            },
                        });
                    }, 0);
                }

                if (msg.method === 'turn/start' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, {
                            id: msg.id,
                            result: {
                                turn: { id: 'turn-raw-2', items: [], status: 'inProgress', error: null },
                            },
                        });
                        pushJsonLine(stdout, {
                            method: 'turn/started',
                            params: {
                                threadId: 'thread-raw-2',
                                turn: { id: 'turn-raw-2', items: [], status: 'inProgress', error: null },
                            },
                        });
                        pushJsonLine(stdout, {
                            method: 'item/completed',
                            params: {
                                threadId: 'thread-raw-2',
                                turnId: 'turn-raw-2',
                                item: {
                                    type: 'agentMessage',
                                    id: 'msg-2',
                                    text: 'still works',
                                    phase: 'final_answer',
                                },
                            },
                        });
                        setTimeout(() => {
                            pushJsonLine(stdout, {
                                method: 'turn/completed',
                                params: {
                                    threadId: 'thread-raw-2',
                                    turn: { id: 'turn-raw-2', items: [], status: 'completed', error: null },
                                },
                            });
                        }, 10);
                    }, 0);
                }
            },
        });

        mockSpawn.mockImplementation(() => proc);

        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();
        const events: Array<Record<string, unknown>> = [];
        client.setEventHandler((msg) => {
            events.push(msg as Record<string, unknown>);
        });

        await client.connect();
        await client.startThread({
            model: 'gpt-test',
            cwd: '/tmp/project',
            approvalPolicy: 'never',
            sandbox: 'danger-full-access',
        });

        await expect(client.sendTurnAndWait('say hi')).resolves.toEqual({ aborted: false });
        expect(events).toEqual(expect.arrayContaining([
            expect.objectContaining({ type: 'task_started', turn_id: 'turn-raw-2' }),
            expect.objectContaining({ type: 'agent_message', message: 'still works' }),
            expect.objectContaining({ type: 'task_complete', turn_id: 'turn-raw-2' }),
        ]));

        await client.disconnect();
    });

    it('sends multimodal input items in turn/start requests', async () => {
        const requests: MockRpcMessage[] = [];
        const proc = createMockProcess({
            pid: 3006,
            onRequest: (msg, stdout) => {
                requests.push(msg);
                if (msg.method === 'thread/start' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, {
                            id: msg.id,
                            result: {
                                thread: { id: 'thread-multimodal', path: '/tmp/thread-multimodal' },
                                model: 'gpt-test',
                                modelProvider: 'openai',
                                cwd: '/tmp/project',
                                approvalPolicy: 'never',
                                sandbox: { type: 'workspaceWrite', writableRoots: [], networkAccess: true, excludeTmpdirEnvVar: false, excludeSlashTmp: false },
                                reasoningEffort: null,
                            },
                        });
                    }, 0);
                }

                if (msg.method === 'turn/start' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, {
                            id: msg.id,
                            result: {
                                turn: { id: 'turn-multimodal' },
                            },
                        });
                        pushJsonLine(stdout, {
                            method: 'turn/started',
                            params: {
                                turn: { id: 'turn-multimodal', status: 'running' },
                            },
                        });
                        pushJsonLine(stdout, {
                            method: 'turn/completed',
                            params: {
                                turn: { id: 'turn-multimodal', status: 'completed' },
                            },
                        });
                    }, 0);
                }
            },
        });

        mockSpawn.mockImplementation(() => proc);

        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();

        await client.connect();
        await client.startThread({
            model: 'gpt-test',
            cwd: '/tmp/project',
            approvalPolicy: 'never',
            sandbox: 'workspace-write',
        });

        await expect(client.sendTurnContentAndWait([
            { type: 'image', url: 'data:image/png;base64,abc123' },
            { type: 'image', fileId: 'file-upstream-image', detail: 'original' },
            { type: 'text', text: 'describe this image' },
        ], {
            sandbox: 'workspace-write',
            networkAccess: true,
        })).resolves.toEqual({ aborted: false });

        const turnStartRequest = requests.find((msg) => msg.method === 'turn/start');
        expect(turnStartRequest?.params).toMatchObject({
            threadId: 'thread-multimodal',
            input: [
                { type: 'image', url: 'data:image/png;base64,abc123' },
                { type: 'image', fileId: 'file-upstream-image', detail: 'original' },
                { type: 'text', text: 'describe this image' },
            ],
            sandboxPolicy: {
                type: 'workspaceWrite',
                writableRoots: [],
                networkAccess: true,
                excludeTmpdirEnvVar: false,
                excludeSlashTmp: false,
            },
        });

        await client.disconnect();
    });

    it('steers an active turn with the current generated protocol precondition', async () => {
        const requests: MockRpcMessage[] = [];
        const proc = createMockProcess({
            onRequest: (msg, stdout) => {
                requests.push(msg);
                if (msg.method === 'thread/start' && msg.id != null) {
                    setTimeout(() => pushJsonLine(stdout, { id: msg.id, result: { thread: { id: 'thread-steer' }, model: 'gpt-test' } }), 0);
                }
                if (msg.method === 'turn/start' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, { id: msg.id, result: { turn: { id: 'turn-active' } } });
                        pushJsonLine(stdout, { method: 'turn/started', params: { threadId: 'thread-steer', turn: { id: 'turn-active', status: 'inProgress' } } });
                    }, 0);
                }
                if (msg.method === 'turn/steer' && msg.id != null) {
                    setTimeout(() => pushJsonLine(stdout, { id: msg.id, result: { turnId: 'turn-active' } }), 0);
                }
            },
        });
        mockSpawn.mockImplementation(() => proc);
        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();
        await client.connect();
        await client.startThread({ cwd: '/workspace' });
        await client.sendTurn('begin');

        await expect(client.steerTurn('include this too', 'web-message-1')).resolves.toEqual({ turnId: 'turn-active' });
        expect(requests).toContainEqual(expect.objectContaining({
            method: 'turn/steer',
            params: {
                threadId: 'thread-steer',
                input: [{ type: 'text', text: 'include this too' }],
                expectedTurnId: 'turn-active',
                clientUserMessageId: 'web-message-1',
                responsesapiClientMetadata: null,
                additionalContext: null,
            },
        }));
        await client.disconnect();
    });

    it('responds to MCP elicitation requests with an action payload', async () => {
        const approvals: Array<Record<string, unknown>> = [];
        const requests: MockRpcMessage[] = [];
        const proc = createMockProcess({
            pid: 3007,
            onRequest: (msg, stdout) => {
                requests.push(msg);
                if (msg.method === 'thread/start' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, {
                            id: msg.id,
                            result: {
                                thread: { id: 'thread-raw-7', path: '/tmp/thread-raw-7' },
                                model: 'gpt-test',
                                modelProvider: 'openai',
                                cwd: '/tmp/project',
                                approvalPolicy: 'on-request',
                                sandbox: { type: 'workspaceWrite', writableRoots: [], networkAccess: true, excludeTmpdirEnvVar: false, excludeSlashTmp: false },
                                reasoningEffort: null,
                            },
                        });
                        pushJsonLine(stdout, {
                            id: 77,
                            method: 'mcpServer/elicitation/request',
                            params: {
                                threadId: 'thread-raw-7',
                                turnId: 'turn-raw-7',
                                serverName: 'hapla',
                                mode: 'form',
                                _meta: {
                                    codex_approval_kind: 'mcp_tool_call',
                                    tool_title: 'Change Chat Title',
                                    tool_description: 'Change the title of the current chat session',
                                    tool_params: { title: 'Casual Greeting' },
                                },
                                message: 'Allow the hapla MCP server to run tool "change_title"?',
                                requestedSchema: {
                                    type: 'object',
                                    properties: {},
                                },
                            },
                        });
                    }, 0);
                }
            },
        });

        mockSpawn.mockImplementation(() => proc);

        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();
        client.setApprovalHandler(async (params) => {
            approvals.push(params as Record<string, unknown>);
            return 'approved';
        });

        await client.connect();
        await client.startThread({
            model: 'gpt-test',
            cwd: '/tmp/project',
            approvalPolicy: 'on-request',
            sandbox: 'workspace-write',
        });

        await waitFor(() => approvals.length === 1);
        await waitFor(() => requests.some((msg) => msg.id === 77 && msg.result?.action === 'accept'));

        expect(approvals[0]).toEqual(expect.objectContaining({
            type: 'mcp',
            callId: 'hapla:77',
            toolName: 'change_title',
            input: { title: 'Casual Greeting' },
            serverName: 'hapla',
        }));
        expect(requests).toEqual(expect.arrayContaining([
            expect.objectContaining({
                id: 77,
                result: {
                    action: 'accept',
                    content: {},
                    _meta: null,
                },
            }),
        ]));

        await client.disconnect();
    });

    it.each([
        [{ mcpAppUi: { resourceUri: 'ui://new.html', preferredModelDisplayMode: 'inline' }, appContext: { resourceUri: 'ui://context.html' }, mcpAppResourceUri: 'ui://legacy.html' }, 'ui://new.html'],
        [{ appContext: { resourceUri: 'ui://context.html' }, mcpAppResourceUri: 'ui://legacy.html' }, 'ui://context.html'],
        [{ mcpAppResourceUri: 'ui://legacy.html' }, 'ui://legacy.html'],
    ])('retains the newest available MCP UI resource while preserving older descriptors', async (presentation, expectedUri) => {
        const { client, events, notify } = await runningClient();
        notify('item/completed', { threadId: 'thread-reliable', item: {
            type: 'mcpToolCall', id: 'mcp-display', server: 'app', tool: 'render', status: 'completed',
            arguments: {}, result: { content: [] }, ...presentation,
        } });
        await waitFor(() => events.some((event) => event.type === 'mcp_tool_call_end'));
        expect(events.find((event) => event.type === 'mcp_tool_call_end')?.resource_uri).toBe(expectedUri);
        await client.disconnect();
    });

    it('rejects unexpected user verification requests without presenting or accepting a generic approval', async () => {
        mockExecSync.mockReturnValue('codex-cli 0.156.1');
        const { client, proc, requests, events } = await runningClient();
        const approve = vi.fn().mockResolvedValue('approved');
        const ask = vi.fn().mockResolvedValue({ answers: {} });
        client.setApprovalHandler(approve);
        client.setUserInputHandler(ask);
        const init = requests.find((request) => request.method === 'initialize');
        expect(init?.params.capabilities.extensions?.['openai/userVerification']).toBeUndefined();
        pushJsonLine(proc.stdout, { id: 991, method: 'mcpServer/elicitation/request', params: {
            threadId: 'thread-reliable', turnId: null, serverName: 'account',
            mode: 'openai/userVerification', title: 'Verify', description: 'Verify user', challenge: 'opaque', _meta: null,
        } });
        await waitFor(() => requests.some((request: any) => request.id === 991 && request.error));
        expect(requests.find((request) => request.id === 991)).toMatchObject({
            error: { code: -32601, message: 'Hapla does not support openai/userVerification requests.' },
        });
        expect(approve).not.toHaveBeenCalled();
        expect(ask).not.toHaveBeenCalled();
        expect(events.some((event) => event.type === 'codex_request' && event.requestId === 991)).toBe(false);
        await client.disconnect();
    });

    it('forks at a turn boundary and creates a clean sibling before the first turn without rollback', async () => {
        const requests: MockRpcMessage[] = [];
        let threadStarts = 0;
        const proc = createMockProcess({
            onRequest: (msg, stdout) => {
                requests.push(msg);
                if (msg.method === 'thread/start' && msg.id != null) {
                    threadStarts += 1;
                    const id = threadStarts === 1 ? 'thread-root' : 'thread-empty-child';
                    setTimeout(() => pushJsonLine(stdout, { id: msg.id, result: { thread: { id }, model: 'gpt-test' } }), 0);
                }
                if (msg.method === 'thread/read' && msg.id != null) {
                    setTimeout(() => pushJsonLine(stdout, { id: msg.id, result: { thread: { turns: [{ id: 'turn-1' }] } } }), 0);
                }
                if (msg.method === 'thread/fork' && msg.id != null) {
                    setTimeout(() => pushJsonLine(stdout, { id: msg.id, result: { thread: { id: 'thread-child', forkedFromId: 'thread-root' }, model: 'gpt-test' } }), 0);
                }
            },
        });
        mockSpawn.mockImplementation(() => proc);
        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();
        await client.connect();
        await client.startThread({ cwd: '/workspace' });

        await expect(client.readThreadTurns()).resolves.toEqual([{ id: 'turn-1' }]);
        await expect(client.forkThread({ lastTurnId: 'turn-1' })).resolves.toEqual({
            threadId: 'thread-child', model: 'gpt-test', forkedFromId: 'thread-root',
        });
        expect(client.threadId).toBe('thread-child');
        expect(requests).toContainEqual(expect.objectContaining({
            method: 'thread/fork',
            params: expect.objectContaining({ threadId: 'thread-root', lastTurnId: 'turn-1' }),
        }));
        await expect(client.startSiblingThread({ cwd: '/workspace' })).resolves.toEqual({
            threadId: 'thread-empty-child', model: 'gpt-test', forkedFromId: 'thread-child',
        });
        expect(client.threadId).toBe('thread-empty-child');
        expect(requests.some((request) => request.method === 'thread/rollback')).toBe(false);
        await client.disconnect();
    });

    it('supports future requests and notifications through the raw bridge', async () => {
        const requests: MockRpcMessage[] = [];
        const events: Array<Record<string, unknown>> = [];
        const proc = createMockProcess({
            onRequest: (msg, stdout) => {
                requests.push(msg);
                if (msg.method === 'future/capability' && msg.id != null) {
                    setTimeout(() => pushJsonLine(stdout, { id: msg.id, result: { supported: true } }), 0);
                }
            },
        });
        mockSpawn.mockImplementation(() => proc);

        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();
        client.setEventHandler((event) => events.push(event));
        await client.connect();

        await expect(client.requestRaw<{ supported: boolean }>('future/capability', { version: 1 }))
            .resolves.toEqual({ supported: true });
        client.notifyRaw('future/clientNotification', { enabled: true });
        pushJsonLine(proc.stdout, { method: 'future/serverNotification', params: { value: 42 } });

        await waitFor(() => events.some((event) => event.type === 'codex_notification'));
        expect(requests).toEqual(expect.arrayContaining([
            expect.objectContaining({ method: 'future/capability', params: { version: 1 } }),
            expect.objectContaining({ method: 'future/clientNotification', params: { enabled: true } }),
        ]));
        expect(events).toContainEqual(expect.objectContaining({
            type: 'codex_notification',
            method: 'future/serverNotification',
            params: { value: 42 },
            protocol: expect.objectContaining({ epoch: expect.any(String), seq: expect.any(Number) }),
        }));

        await client.disconnect();
    });

    it('covers every current built-in server request and advertises capabilities accurately', async () => {
        const requests: MockRpcMessage[] = [];
        const proc = createMockProcess({
            onRequest: (msg, stdout) => {
                requests.push(msg);
                if (msg.method === 'initialize' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, { id: 91, method: 'currentTime/read', params: { threadId: 'thread-1' } });
                        pushJsonLine(stdout, { id: 92, method: 'attestation/generate', params: { nonce: 'nonce-1' } });
                        pushJsonLine(stdout, { id: 93, method: 'account/chatgptAuthTokens/refresh', params: { reason: 'expired' } });
                    }, 10);
                }
            },
        });
        mockSpawn.mockImplementation(() => proc);

        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();
        client.setAttestationHandler(async () => ({ token: 'attested' }));
        client.setChatgptAuthTokensRefreshHandler(async () => ({
            accessToken: 'fresh',
            chatgptAccountId: 'account-1',
            chatgptPlanType: 'pro',
        }));
        await client.connect();

        await waitFor(() => requests.some((msg) => msg.id === 93 && msg.result));
        const initialize = requests.find((msg) => msg.method === 'initialize');
        expect(initialize?.params?.capabilities).toMatchObject({
            requestAttestation: true,
            mcpServerOpenaiFormElicitation: false,
        });
        expect(requests).toEqual(expect.arrayContaining([
            expect.objectContaining({ id: 91, result: expect.objectContaining({ currentTimeAt: expect.any(Number) }) }),
            expect.objectContaining({ id: 92, result: { token: 'attested' } }),
            expect.objectContaining({
                id: 93,
                result: { accessToken: 'fresh', chatgptAccountId: 'account-1', chatgptPlanType: 'pro' },
            }),
        ]));

        await client.disconnect();
    });
});
