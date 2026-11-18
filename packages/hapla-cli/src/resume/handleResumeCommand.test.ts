import { describe, expect, it } from 'vitest';

import { buildResumeLaunch, buildTransparentContinuationLaunch, formatResumeHelp, parseResumeCommandArgs } from './handleResumeCommand';

describe('parseResumeCommandArgs', () => {
    it('parses the Hapla session id', () => {
        expect(parseResumeCommandArgs(['cmmij8olq00dp5jcxr3wtbpau'])).toEqual({
            showHelp: false,
            sessionId: 'cmmij8olq00dp5jcxr3wtbpau',
        });
    });

    it('recognizes help flags', () => {
        expect(parseResumeCommandArgs(['--help'])).toEqual({
            showHelp: true,
            sessionId: '',
        });
    });

    it('rejects missing session ids', () => {
        expect(() => parseResumeCommandArgs([])).toThrow(
            'Hapla session ID is required: hapla resume <session-id>',
        );
    });
});

describe('buildResumeLaunch', () => {
    it('builds a Codex resume command', () => {
        expect(buildResumeLaunch({
            id: 'session-1',
            active: false,
            metadata: {
                path: '/tmp/p1-control-flow',
                flavor: 'codex',
                codexThreadId: '019ccca5-726b-7c61-b914-16de27dfab6e',
                host: 'localhost',
                homeDir: '/tmp',
                happyHomeDir: '/tmp/.hapla',
                happyLibDir: '/tmp/happy',
                happyToolsDir: '/tmp/happy/tools',
            },
        })).toEqual({
            cwd: '/tmp/p1-control-flow',
            args: ['codex', '--resume', '019ccca5-726b-7c61-b914-16de27dfab6e'],
        });
    });

    it('builds a Claude resume command', () => {
        expect(buildResumeLaunch({
            id: 'session-2',
            active: false,
            metadata: {
                path: '/tmp/repo',
                flavor: 'claude',
                claudeSessionId: '93a9705e-bc6a-406d-8dce-8acc014dedbd',
                host: 'localhost',
                homeDir: '/tmp',
                happyHomeDir: '/tmp/.hapla',
                happyLibDir: '/tmp/happy',
                happyToolsDir: '/tmp/happy/tools',
            },
        })).toEqual({
            cwd: '/tmp/repo',
            args: ['claude', '--resume', '93a9705e-bc6a-406d-8dce-8acc014dedbd'],
        });
    });

    it('rejects unsupported flavors', () => {
        expect(() => buildResumeLaunch({
            id: 'session-3',
            active: false,
            metadata: {
                path: '/tmp/repo',
                flavor: 'gemini',
                host: 'localhost',
                homeDir: '/tmp',
                happyHomeDir: '/tmp/.hapla',
                happyLibDir: '/tmp/happy',
                happyToolsDir: '/tmp/happy/tools',
            },
        })).toThrow('Hapla session session-3 uses unsupported flavor "gemini".');
    });
});

describe('buildTransparentContinuationLaunch', () => {
    it('starts Claude for a session created before provider metadata existed', () => {
        expect(buildTransparentContinuationLaunch({
            id: 'pre-provider-session',
            active: false,
            metadata: {
                path: '/tmp/project',
                host: 'localhost',
                homeDir: '/tmp',
                happyHomeDir: '/tmp/.hapla',
                happyLibDir: '/tmp/hapla',
                happyToolsDir: '/tmp/hapla/tools',
            },
        }, { startedBy: 'daemon', claudeStartingMode: 'remote' })).toEqual({
            cwd: '/tmp/project',
            args: ['claude', '--hapla-starting-mode', 'remote', '--started-by', 'daemon'],
        });
    });

    it('normalizes the legacy gpt provider marker to Codex', () => {
        expect(buildTransparentContinuationLaunch({
            id: 'legacy-gpt-session',
            active: false,
            metadata: {
                path: '/tmp/project',
                flavor: 'gpt',
                host: 'localhost',
                homeDir: '/tmp',
                happyHomeDir: '/tmp/.hapla',
                happyLibDir: '/tmp/hapla',
                happyToolsDir: '/tmp/hapla/tools',
            },
        }, { startedBy: 'daemon' })).toEqual({
            cwd: '/tmp/project',
            args: ['codex', '--started-by', 'daemon'],
        });
    });

    it('starts a fresh Codex runtime when an interrupted session never received a thread id', () => {
        expect(buildTransparentContinuationLaunch({
            id: 'legacy-session',
            active: false,
            metadata: {
                path: '/tmp/project',
                flavor: 'codex',
                host: 'localhost',
                homeDir: '/tmp',
                happyHomeDir: '/tmp/.hapla',
                happyLibDir: '/tmp/hapla',
                happyToolsDir: '/tmp/hapla/tools',
            },
        }, { startedBy: 'daemon', claudeStartingMode: 'remote' })).toEqual({
            cwd: '/tmp/project',
            args: ['codex', '--hapla-starting-mode', 'remote', '--started-by', 'daemon'],
        });
    });

    it('keeps the provider resume path when a thread id exists', () => {
        expect(buildTransparentContinuationLaunch({
            id: 'session-1',
            active: false,
            metadata: {
                path: '/tmp/project',
                flavor: 'codex',
                codexThreadId: 'thread-1',
                host: 'localhost',
                homeDir: '/tmp',
                happyHomeDir: '/tmp/.hapla',
                happyLibDir: '/tmp/hapla',
                happyToolsDir: '/tmp/hapla/tools',
            },
        }, { startedBy: 'daemon' })).toEqual({
            cwd: '/tmp/project',
            args: ['codex', '--resume', 'thread-1', '--started-by', 'daemon'],
        });
    });
});

describe('formatResumeHelp', () => {
    it('mentions the session id command shape', () => {
        expect(formatResumeHelp()).toContain('hapla resume <session-id>');
    });
});
