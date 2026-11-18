import { describe, expect, it } from 'vitest';
import { defaultPermissionModeForSession } from './defaultPermissionMode';

describe('defaultPermissionModeForSession', () => {
    it('uses native full access for Codex sessions', () => {
        expect(defaultPermissionModeForSession({ flavor: 'codex', sandbox: null })).toBe('yolo');
    });

    it('keeps managed sandbox sessions inside the external sandbox', () => {
        expect(defaultPermissionModeForSession({
            flavor: 'codex',
            sandbox: { enabled: true },
        })).toBe('bypassPermissions');
    });

    it('keeps the conservative default for Claude sessions', () => {
        expect(defaultPermissionModeForSession({ flavor: 'claude', sandbox: null })).toBe('default');
    });
});
