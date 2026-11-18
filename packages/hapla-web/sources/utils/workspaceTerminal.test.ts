import { describe, expect, it, vi } from 'vitest';
vi.mock('@/sync/apiSocket', () => ({ apiSocket: {} }));
import { openWorkspaceTerminal } from './workspaceTerminal';

const options = { sessionId: 'session', sessionActive: true, machineId: 'machine', cwd: '/data2/workspace/video-e2e', cols: 100, rows: 30 };
const started = { terminalId: 'owned-terminal', pid: 1234, shell: '/bin/bash' };
const output = { data: 'prompt $ ', cursor: 1, dataLost: false, exited: false, exitCode: null, signal: null };

describe('workspace terminal RPC ownership and response validation', () => {
    it('uses the active session root and retains that owner for every subsequent operation', async () => {
        const rpc = { session: vi.fn().mockResolvedValueOnce(started).mockResolvedValueOnce(output).mockResolvedValue({ success: true }), machine: vi.fn() };
        const lease = await openWorkspaceTerminal(options, rpc);
        expect(lease.owner).toEqual({ kind: 'session', id: 'session' });
        expect(rpc.session).toHaveBeenNthCalledWith(1, 'session', 'terminal-start', { cwd: options.cwd, cols: 100, rows: 30 });
        expect(await lease.read(0)).toEqual(output);
        await lease.write('hello'); await lease.resize(80, 24); await lease.close(); await lease.close();
        expect(rpc.session.mock.calls.map(call => call[1])).toEqual(['terminal-start', 'terminal-read', 'terminal-write', 'terminal-resize', 'terminal-close']);
        expect(rpc.session.mock.calls.slice(1).every(call => call[2].terminalId === 'owned-terminal')).toBe(true);
        expect(rpc.machine).not.toHaveBeenCalled();
    });

    it('reports the actual denied cwd response instead of inventing a connected terminal', async () => {
        const rpc = { session: vi.fn(), machine: vi.fn().mockResolvedValue({ error: "Access denied: Path '/data2/workspace/video-e2e' is outside the working directory" }) };
        await expect(openWorkspaceTerminal({ ...options, sessionActive: false }, rpc)).rejects.toThrow('outside the working directory');
        expect(rpc.machine).toHaveBeenCalledTimes(1);
    });

    it.each([{}, { terminalId: '', pid: 12, shell: 'bash' }, { terminalId: 'id', shell: 'bash' }, null])('rejects a malformed successful start without entering the read loop: %j', async value => {
        const rpc = { session: vi.fn().mockResolvedValue(value), machine: vi.fn() };
        await expect(openWorkspaceTerminal(options, rpc)).rejects.toThrow();
        expect(rpc.session).toHaveBeenCalledTimes(1);
        expect(rpc.machine).not.toHaveBeenCalled();
    });

    it('falls back only after a definite missing session handler and keeps the machine owner thereafter', async () => {
        const rpc = { session: vi.fn().mockRejectedValue(new Error('RPC method not available')), machine: vi.fn().mockResolvedValueOnce(started).mockResolvedValueOnce(output).mockResolvedValue({ success: true }) };
        const lease = await openWorkspaceTerminal(options, rpc);
        expect(lease.owner).toEqual({ kind: 'machine', id: 'machine' });
        await lease.read(0); await lease.close();
        expect(rpc.session).toHaveBeenCalledTimes(1);
        expect(rpc.machine.mock.calls.map(call => call[1])).toEqual(['terminal-start', 'terminal-read', 'terminal-close']);
    });

    it.each(['RPC timed out', 'RPC target disconnected', 'Access denied: Path is outside the working directory'])('never duplicates an uncertain or denied start: %s', async message => {
        const rpc = { session: vi.fn().mockRejectedValue(new Error(message)), machine: vi.fn() };
        await expect(openWorkspaceTerminal(options, rpc)).rejects.toThrow(message);
        expect(rpc.machine).not.toHaveBeenCalled();
    });

    it.each([{ error: 'Terminal not found or expired' }, { ...output, cursor: undefined }, { ...output, data: 1 }])('surfaces read errors and malformed output rather than polling an empty terminal: %j', async value => {
        const rpc = { session: vi.fn().mockResolvedValueOnce(started).mockResolvedValueOnce(value), machine: vi.fn() };
        const lease = await openWorkspaceTerminal(options, rpc);
        await expect(lease.read(0)).rejects.toThrow();
    });

    it('reports write rejection and prevents new operations after close', async () => {
        const rpc = { session: vi.fn().mockResolvedValueOnce(started).mockResolvedValueOnce({ error: 'Terminal process has exited' }).mockResolvedValue({ success: true }), machine: vi.fn() };
        const lease = await openWorkspaceTerminal(options, rpc);
        await expect(lease.write('x')).rejects.toThrow('Terminal process has exited');
        await lease.close();
        await expect(lease.read(0)).rejects.toThrow('终端已关闭');
        expect(rpc.session).toHaveBeenCalledTimes(3);
    });
});
