import { apiSocket } from '@/sync/apiSocket';
import type { SessionTerminalReadResponse, SessionTerminalStartResponse } from '@/sync/ops';

type TerminalMethod = 'terminal-start' | 'terminal-read' | 'terminal-write' | 'terminal-resize' | 'terminal-close';
type Rpc = (id: string, method: TerminalMethod, params: Record<string, unknown>) => Promise<unknown>;
type Transports = { session: Rpc; machine: Rpc };
const transports: Transports = {
    session: (id, method, params) => apiSocket.sessionRPC(id, method, params, 20_000),
    machine: (id, method, params) => apiSocket.machineRPC(id, method, params, 20_000),
};

function response(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('终端返回了无效响应，请重试');
    const result = value as Record<string, unknown>;
    if (typeof result.error === 'string' && result.error.trim()) throw new Error(result.error);
    if (result.success === false) throw new Error('终端操作失败，请重试');
    return result;
}
const validInteger = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

/** A PTY belongs to the RPC scope that created it. Keep every later operation
 * on that owner even when session online metadata changes in the background. */
export async function openWorkspaceTerminal(options: {
    sessionId: string; sessionActive: boolean; machineId?: string; cwd?: string; cols: number; rows: number;
}, rpc: Transports = transports) {
    let owner: { kind: keyof Transports; id: string };
    const request = { cwd: options.cwd, cols: options.cols, rows: options.rows };
    let started: Record<string, unknown>;
    if (options.sessionActive) {
        owner = { kind: 'session', id: options.sessionId };
        try { started = response(await rpc.session(owner.id, 'terminal-start', request)); }
        catch (error) {
            // Only a definite missing target can safely fall back. A timeout
            // may already have created a PTY, so never open another on timeout.
            if (!options.machineId || !(error instanceof Error) || !/RPC method not available|Session encryption not found/i.test(error.message)) throw error;
            owner = { kind: 'machine', id: options.machineId };
            started = response(await rpc.machine(owner.id, 'terminal-start', request));
        }
    } else {
        if (!options.machineId) throw new Error('工作区所属工作台尚未连接，请重试');
        owner = { kind: 'machine', id: options.machineId };
        started = response(await rpc.machine(owner.id, 'terminal-start', request));
    }
    if (typeof started.terminalId !== 'string' || !started.terminalId.trim()
        || !validInteger(started.pid) || !started.pid || typeof started.shell !== 'string' || !started.shell.trim()) {
        throw new Error('终端未返回有效的进程信息，请重试');
    }
    const process = started as unknown as SessionTerminalStartResponse;
    let closed = false;
    const invoke = async (method: TerminalMethod, params: Record<string, unknown>) => {
        if (closed) throw new Error('终端已关闭');
        return response(await rpc[owner.kind](owner.id, method, { terminalId: process.terminalId, ...params }));
    };
    const action = async (method: TerminalMethod, params: Record<string, unknown>) => {
        if ((await invoke(method, params)).success !== true) throw new Error('终端操作未确认成功，请重试');
    };
    return {
        ...process, owner,
        async read(cursor: number): Promise<SessionTerminalReadResponse> {
            const value = await invoke('terminal-read', { cursor });
            if (typeof value.data !== 'string' || !validInteger(value.cursor) || Number(value.cursor) < cursor
                || typeof value.dataLost !== 'boolean' || typeof value.exited !== 'boolean'
                || (value.exitCode !== null && !validInteger(value.exitCode))
                || (value.signal !== null && !validInteger(value.signal))) throw new Error('终端输出返回了无效响应，请重试');
            return value as unknown as SessionTerminalReadResponse;
        },
        write: (data: string) => action('terminal-write', { data }),
        resize: (cols: number, rows: number) => action('terminal-resize', { cols, rows }),
        async close() {
            if (closed) return;
            closed = true;
            const value = response(await rpc[owner.kind](owner.id, 'terminal-close', { terminalId: process.terminalId }));
            if (value.success !== true) throw new Error('终端关闭未确认成功');
        },
    };
}

export type WorkspaceTerminal = Awaited<ReturnType<typeof openWorkspaceTerminal>>;
