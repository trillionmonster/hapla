import { beforeEach, describe, expect, it, vi } from 'vitest';
const socket = vi.hoisted(() => ({ sessionCommand: vi.fn(), machineRPC: vi.fn() }));
vi.mock('./apiSocket', () => ({ apiSocket: socket }));
import { gitWorkbenchRpc } from './gitWorkbench';
import { gitWorkbenchErrorCode } from './gitWorkbenchErrors';

describe('Git workbench transport compatibility', () => {
    beforeEach(() => vi.resetAllMocks());
    it('uses the upgraded daemon when a preserved session explicitly has no Git handler', async () => {
        socket.sessionCommand.mockRejectedValue(new Error('RPC method not available'));
        socket.machineRPC.mockResolvedValue({ files: [], branch: 'main' });
        expect(await gitWorkbenchRpc('old', 'machine', true, { operation: 'status', directory: '/project' })).toEqual({ files: [], branch: 'main' });
        expect(socket.machineRPC).toHaveBeenCalledWith('machine', 'git-workbench', { operation: 'status', directory: '/project', sessionId: 'old' }, 20_000);
    });
    it.each(['operation has timed out', 'RPC target disconnected', 'Git hook rejected commit'])('does not replay a mutation after %s', async message => {
        socket.sessionCommand.mockRejectedValue(new Error(message));
        await expect(gitWorkbenchRpc('session', 'machine', true, { operation: 'commit', message: 'Keep draft' })).rejects.toThrow(message);
        expect(socket.machineRPC).not.toHaveBeenCalled();
    });
    it('preserves the checkpoint namespace during daemon fallback', async () => {
        socket.sessionCommand.mockRejectedValue(new Error('Method not found'));
        socket.machineRPC.mockResolvedValue({ checkpoints: [] });
        await gitWorkbenchRpc('runtime', 'machine', true, { operation: 'checkpoints', sessionId: 'root' });
        expect(socket.machineRPC.mock.calls[0][2].sessionId).toBe('root');
    });
    it('does not turn an absent payload into an empty repository', async () => {
        socket.machineRPC.mockResolvedValue({});
        await expect(gitWorkbenchRpc('session', 'machine', false, { operation: 'status' })).rejects.toThrow('Invalid Git response');
    });
    it('distinguishes unsupported workers, non-repositories, timeouts and disconnections', () => {
        expect(gitWorkbenchErrorCode(new Error('RPC method not available'))).toBe('unsupported');
        expect(gitWorkbenchErrorCode(new Error('git failed: fatal: not a git repository'))).toBe('notRepository');
        expect(gitWorkbenchErrorCode(new Error('operation has timed out'))).toBe('timedOut');
        expect(gitWorkbenchErrorCode(new Error('RPC target disconnected'))).toBe('unavailable');
    });
});
