import { describe, expect, it, vi } from 'vitest';
import { readVideoPreview } from './sessionVideoPreview';

function dependencies() {
    return {
        read: vi.fn(async () => { throw new Error('RPC method not available'); }),
        session: { metadata: { path: '/work', machineId: 'owner' } },
        online: vi.fn(() => true),
        machineBash: vi.fn(async () => ({ success: true, stdout: JSON.stringify({ status: 'ready', sizeBytes: 123 }) })),
    };
}
describe('video preview compatibility', () => {
    it('uses the installed JSON helper only on the owning machine and quotes shell metacharacters', async () => {
        const deps = dependencies();
        expect(await readVideoPreview(deps, "/work/video '$(touch bad).mp4")).toEqual({ status: 'ready', sizeBytes: 123 });
        expect(deps.machineBash).toHaveBeenCalledWith('owner', {
            command: `hapla-video-preview --root '/work' --path '/work/video '"'"'$(touch bad).mp4'`, cwd: '/work', timeout: 30_000,
        });
        expect(deps.read).not.toHaveBeenCalled();
    });
    it('never runs a helper for access rejection or paths outside the workspace', async () => {
        const deps = dependencies();
        await expect(readVideoPreview(deps, '/other/video.mp4')).rejects.toThrow('工作区');
        expect(deps.machineBash).not.toHaveBeenCalled();
        deps.machineBash.mockResolvedValueOnce({ success: true, stdout: JSON.stringify({ success: false, error: 'Access denied' }) });
        await expect(readVideoPreview(deps, '/work/video.mp4')).resolves.toEqual({ success: false, error: 'Access denied' });
        expect(deps.read).not.toHaveBeenCalled();
    });
    it('does not use the helper for an offline owner', async () => {
        const deps = dependencies(); deps.online.mockReturnValue(false);
        await expect(readVideoPreview(deps, '/work/video.mp4')).rejects.toThrow('RPC method');
        expect(deps.machineBash).not.toHaveBeenCalled();
    });
});
