import { describe, expect, it } from 'vitest';
import { defaultPermissionModeForSession } from './defaultPermissionMode';

describe('defaultPermissionModeForSession', () => {
    it('does not expand Codex permissions on a fresh device', () => {
        expect(defaultPermissionModeForSession({ flavor: 'codex', sandbox: null })).toBe('default');
    });

    it('does not bypass approval merely because an outer sandbox is enabled', () => {
        expect(defaultPermissionModeForSession({
            flavor: 'codex',
            sandbox: { enabled: true },
        })).toBe('default');
    });

    it('keeps the conservative default for Claude sessions', () => {
        expect(defaultPermissionModeForSession({ flavor: 'claude', sandbox: null })).toBe('default');
    });
});
