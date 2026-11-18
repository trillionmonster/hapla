import { describe, expect, it } from 'vitest';

import { extractCodexResumeFlag, extractCodexStartedByFlag, extractHaplaStartingModeFlag } from './cliArgs';

describe('extractCodexResumeFlag', () => {
    it('returns null and preserves args when resume flag is absent', () => {
        const parsed = extractCodexResumeFlag(['--started-by', 'terminal']);

        expect(parsed.resumeThreadId).toBeNull();
        expect(parsed.args).toEqual(['--started-by', 'terminal']);
    });

    it('extracts an explicit resume thread ID', () => {
        const parsed = extractCodexResumeFlag(['--resume', 'thread-123', '--started-by', 'daemon']);

        expect(parsed.resumeThreadId).toBe('thread-123');
        expect(parsed.args).toEqual(['--started-by', 'daemon']);
    });

    it('supports equals syntax', () => {
        const parsed = extractCodexResumeFlag(['--resume=thread-456', '--started-by', 'terminal']);

        expect(parsed.resumeThreadId).toBe('thread-456');
        expect(parsed.args).toEqual(['--started-by', 'terminal']);
    });

    it('throws when resume flag is missing a thread ID', () => {
        expect(() => extractCodexResumeFlag(['--resume'])).toThrow(
            'Codex resume requires a thread ID: hapla codex --resume <thread-id>',
        );
    });
});

describe('extractCodexStartedByFlag', () => {
    it('extracts started-by and preserves passthrough args', () => {
        const parsed = extractCodexStartedByFlag(['-m', 'gpt-5', '--started-by', 'daemon', '--disable', 'responses_websockets']);

        expect(parsed.startedBy).toBe('daemon');
        expect(parsed.args).toEqual(['-m', 'gpt-5', '--disable', 'responses_websockets']);
    });

    it('throws when started-by is invalid', () => {
        expect(() => extractCodexStartedByFlag(['--started-by', 'remote'])).toThrow(
            'Codex started-by requires "daemon" or "terminal": hapla codex --started-by <daemon|terminal>',
        );
    });
});


describe('extractHaplaStartingModeFlag', () => {
    it('extracts Hapla starting mode and preserves Codex passthrough args', () => {
        const parsed = extractHaplaStartingModeFlag(['--hapla-starting-mode', 'remote', '-m', 'gpt-5']);

        expect(parsed.startingMode).toBe('remote');
        expect(parsed.args).toEqual(['-m', 'gpt-5']);
    });

    it('leaves foreign starting-mode flags untouched', () => {
        const parsed = extractHaplaStartingModeFlag(['--happy-starting-mode', 'local']);
        expect(parsed.startingMode).toBeUndefined();
        expect(parsed.args).toEqual(['--happy-starting-mode', 'local']);
    });

    it('throws when Hapla starting mode is invalid', () => {
        expect(() => extractHaplaStartingModeFlag(['--hapla-starting-mode', 'daemon'])).toThrow(
            'Hapla starting mode requires "local" or "remote": hapla codex --hapla-starting-mode <local|remote>',
        );
    });
});
