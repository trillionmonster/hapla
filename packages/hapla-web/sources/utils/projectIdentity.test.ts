import { describe, expect, it } from 'vitest';
import { getProjectIdentity, normalizeProjectPath, projectIdentityKey, projectLabel } from './projectIdentity';

describe('project identity', () => {
    it('keeps the same identity for the same folder', () => {
        expect(getProjectIdentity('/home/user/projects/hapla')).toEqual(
            getProjectIdentity('/home/user/projects/hapla/'),
        );
    });

    it('gives visibly different identities to representative folders', () => {
        const demo = getProjectIdentity('/home/user/demohapla');
        const lab = getProjectIdentity('/home/user/lab-rat-todo-project');

        expect(`${demo.icon}-${demo.paletteIndex}`).not.toBe(`${lab.icon}-${lab.paletteIndex}`);
        expect(demo.icon).toBe('sparkles-outline');
        expect(lab.icon).toBe('flask-outline');
    });

    it('supports POSIX and Windows paths', () => {
        expect(projectLabel('/workspace/media-player')).toBe('media-player');
        expect(projectLabel('C:\\work\\codex-client')).toBe('codex-client');
    });

    it('normalizes separators and trailing slashes for shared data-layer identity', () => {
        expect(normalizeProjectPath('/workspace//hapla/')).toBe('/workspace/hapla');
        expect(normalizeProjectPath('C:\\work\\hapla\\')).toBe('C:/work/hapla');
        expect(normalizeProjectPath('/')).toBe('/');
        expect(normalizeProjectPath('C:\\')).toBe('C:/');
        expect(normalizeProjectPath('  ')).toBeNull();
        expect(projectIdentityKey('C:\\Work\\Hapla\\')).toBe('c:/work/hapla');
    });

    it('uses a readable fallback for sessions without a path', () => {
        expect(getProjectIdentity(null, 'Remote workspace').label).toBe('Remote workspace');
    });
});
