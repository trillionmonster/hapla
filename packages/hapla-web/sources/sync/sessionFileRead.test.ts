import { describe, expect, it, vi } from 'vitest';
import { readSessionFile } from './sessionFileRead';

const session = {
    active: false,
    metadata: { path: '/workspace/project', machineId: 'machine-1', lifecycleState: 'sleeping' },
};

function dependencies(overrides: Record<string, unknown> = {}) {
    return {
        getSession: vi.fn(() => session),
        isMachineOnline: vi.fn(() => true),
        sessionRPC: vi.fn(async () => ({ success: true, source: 'session' })),
        machineRPC: vi.fn(async () => ({ success: true, source: 'machine' })),
        ...overrides,
    } as any;
}

describe('readSessionFile', () => {
    it('reads a sleeping session file from its exact online machine', async () => {
        const deps = dependencies();
        await expect(readSessionFile(deps, 'session-1', 'file-download-info', {
            path: '/workspace/project/REPORT.md',
        })).resolves.toMatchObject({ success: true, source: 'machine' });
        expect(deps.sessionRPC).not.toHaveBeenCalled();
        expect(deps.machineRPC).toHaveBeenCalledWith('machine-1', 'file-download-info', {
            sessionId: 'session-1', workspaceRoot: '/workspace/project', path: '/workspace/project/REPORT.md',
        }, 15_000);
    });

    it('uses the session process first while it is active', async () => {
        const deps = dependencies({ getSession: vi.fn(() => ({ ...session, active: true, metadata: { ...session.metadata, lifecycleState: 'running' } })) });
        await expect(readSessionFile(deps, 'session-1', 'file-download-chunk', {
            path: 'REPORT.md', offset: 0, length: 128,
        })).resolves.toMatchObject({ source: 'session' });
        expect(deps.sessionRPC).toHaveBeenCalledWith('session-1', 'file-download-chunk', {
            path: '/workspace/project/REPORT.md', offset: 0, length: 128,
        }, 15_000);
        expect(deps.machineRPC).not.toHaveBeenCalled();
    });

    it('falls back to the owning machine when an active session RPC becomes unavailable', async () => {
        const deps = dependencies({
            getSession: vi.fn(() => ({ ...session, active: true, metadata: { ...session.metadata, lifecycleState: 'running' } })),
            sessionRPC: vi.fn(async () => { throw new Error('RPC target disconnected'); }),
        });
        await expect(readSessionFile(deps, 'session-1', 'file-download-info', {
            path: '/workspace/project/REPORT.md',
        })).resolves.toMatchObject({ source: 'machine' });
    });

    it('does not hide a real session-side file error behind a machine retry', async () => {
        const deps = dependencies({
            getSession: vi.fn(() => ({ ...session, active: true, metadata: { ...session.metadata, lifecycleState: 'running' } })),
            sessionRPC: vi.fn(async () => { throw new Error('File changed during download'); }),
        });
        await expect(readSessionFile(deps, 'session-1', 'file-download-info', {
            path: '/workspace/project/REPORT.md',
        })).rejects.toThrow('File changed during download');
        expect(deps.machineRPC).not.toHaveBeenCalled();
    });

    it('rejects paths outside the session workspace before any RPC', async () => {
        const deps = dependencies();
        await expect(readSessionFile(deps, 'session-1', 'file-download-info', {
            path: '/Users/wws/.ssh/id_ed25519',
        })).rejects.toThrow('文件不在当前会话工作区内');
        expect(deps.sessionRPC).not.toHaveBeenCalled();
        expect(deps.machineRPC).not.toHaveBeenCalled();
    });

    it('returns an explicit retryable error while the owning machine is offline', async () => {
        const deps = dependencies({ isMachineOnline: vi.fn(() => false) });
        await expect(readSessionFile(deps, 'session-1', 'file-download-info', {
            path: '/workspace/project/REPORT.md',
        })).rejects.toThrow('工作台未连接');
    });
});
