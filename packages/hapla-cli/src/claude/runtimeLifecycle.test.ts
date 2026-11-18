import { describe, expect, it } from 'vitest';
import { markClaudeSessionSleeping, shouldPersistClaudeSleep } from './runtimeLifecycle';

describe('Claude runtime lifecycle', () => {
    it('persists sleeping only for explicit user shutdowns', () => {
        expect(shouldPersistClaudeSleep('manual-sleep')).toBe(true);
        expect(shouldPersistClaudeSleep('terminal-exit')).toBe(true);
        expect(shouldPersistClaudeSleep('archived')).toBe(false);
        expect(shouldPersistClaudeSleep('process-signal')).toBe(false);
        expect(shouldPersistClaudeSleep('runtime-error')).toBe(false);
    });

    it('records the acknowledged manual sleep transition', () => {
        expect(markClaudeSessionSleeping({
            path: '/workspace',
            host: 'test-host',
            homeDir: '/home/test',
            happyHomeDir: '/home/test/.hapla',
            happyLibDir: '/opt/hapla',
            happyToolsDir: '/opt/hapla/tools',
            lifecycleState: 'running',
            lifecycleStateSince: 10,
        }, 20)).toMatchObject({
            lifecycleState: 'sleeping',
            lifecycleStateSince: 20,
            sleepReason: 'runtime-stop',
        });
    });
});
