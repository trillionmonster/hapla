import { existsSync } from 'node:fs';

import type { Metadata } from '@/api/types';
import { spawnHaplaCLI } from '@/utils/spawnHaplaCLI';

import { resolveHaplaSession, type ResumableHaplaSession } from './resolveHaplaSession';

export type ResumeLaunch = {
    cwd: string;
    args: string[];
};

export type ResumeLaunchOptions = {
    claudeStartingMode?: 'local' | 'remote';
    startedBy?: 'daemon' | 'terminal';
};

export function parseResumeCommandArgs(args: string[]): { showHelp: boolean; sessionId: string } {
    if (args.includes('-h') || args.includes('--help')) {
        return {
            showHelp: true,
            sessionId: '',
        };
    }

    if (args.length === 0) {
        throw new Error('Hapla session ID is required: hapla resume <session-id>');
    }
    if (args.length > 1) {
        throw new Error(`Unexpected arguments for hapla resume: ${args.slice(1).join(' ')}`);
    }

    return {
        showHelp: false,
        sessionId: args[0],
    };
}

function resolveFlavor(metadata: Metadata): 'codex' | 'claude' | null {
    const flavor = metadata.flavor?.toLowerCase();
    if (flavor === 'codex' || flavor === 'gpt' || flavor === 'openai' || metadata.codexThreadId) {
        return 'codex';
    }
    if (flavor === 'claude' || metadata.claudeSessionId) {
        return 'claude';
    }
    // Sessions predating provider metadata were created by the original
    // Claude-only client. Preserve that upgrade path without exposing a
    // command-line recovery step to the user.
    if (!flavor) return 'claude';
    return null;
}

export function buildResumeLaunch(session: ResumableHaplaSession, options: ResumeLaunchOptions = {}): ResumeLaunch {
    const { metadata } = session;
    const flavor = resolveFlavor(metadata);

    if (flavor === 'codex') {
        if (!metadata.codexThreadId) {
            throw new Error(`Hapla session ${session.id} is missing its Codex thread ID.`);
        }
        const args = ['codex', '--resume', metadata.codexThreadId];
        if (options.startedBy) {
            args.push('--started-by', options.startedBy);
        }
        return {
            cwd: metadata.path,
            args,
        };
    }

    if (flavor === 'claude') {
        if (!metadata.claudeSessionId) {
            throw new Error(`Hapla session ${session.id} is missing its Claude session ID.`);
        }
        const args = ['claude'];
        if (options.claudeStartingMode) {
            args.push('--hapla-starting-mode', options.claudeStartingMode);
        }
        if (options.startedBy) {
            args.push('--started-by', options.startedBy);
        }
        args.push('--resume', metadata.claudeSessionId);
        return {
            cwd: metadata.path,
            args,
        };
    }

    throw new Error(`Hapla session ${session.id} uses unsupported flavor "${metadata.flavor ?? 'unknown'}".`);
}

/**
 * Build the invisible web continuation launch. A legacy or interrupted session
 * can exist before its provider issued a backend conversation id. There is
 * nothing provider-side to resume in that case, so create a new runtime in the
 * same workspace and link its transport record to the visible conversation.
 */
export function buildTransparentContinuationLaunch(
    session: ResumableHaplaSession,
    options: ResumeLaunchOptions = {},
): ResumeLaunch {
    const flavor = resolveFlavor(session.metadata);
    if (!flavor) {
        throw new Error(`Hapla session ${session.id} uses unsupported flavor "${session.metadata.flavor ?? 'unknown'}".`);
    }
    if (
        (flavor === 'codex' && session.metadata.codexThreadId)
        || (flavor === 'claude' && session.metadata.claudeSessionId)
    ) {
        return buildResumeLaunch(session, options);
    }

    const args: string[] = [flavor];
    if (options.claudeStartingMode) {
        args.push('--hapla-starting-mode', options.claudeStartingMode);
    }
    if (options.startedBy) {
        args.push('--started-by', options.startedBy);
    }
    return { cwd: session.metadata.path, args };
}

export function formatResumeHelp(): string {
    return [
        'hapla resume - Resume a previous Hapla session',
        '',
        'Usage:',
        '  hapla resume <session-id>',
        '',
        'Examples:',
        '  hapla resume cmmij8olq00dp5jcxr3wtbpau',
        '  hapla resume cmmij8',
        '',
        'This reuses the saved worktree/path and resumes the underlying agent session',
        'when the backend supports it.',
    ].join('\n');
}

function spawnResumeChild(launch: ResumeLaunch, conversationId: string): Promise<number | null> {
    return new Promise((resolve, reject) => {
        const child = spawnHaplaCLI(launch.args, {
            cwd: launch.cwd,
            env: { ...process.env, HAPLA_CONVERSATION_ID: conversationId },
            stdio: 'inherit',
        });

        child.once('error', reject);
        child.once('exit', (code, signal) => {
            if (signal) {
                reject(new Error(`Resumed session exited via signal ${signal}`));
                return;
            }
            resolve(code);
        });
    });
}

export async function handleResumeCommand(args: string[]): Promise<void> {
    const parsed = parseResumeCommandArgs(args);
    if (parsed.showHelp) {
        console.log(formatResumeHelp());
        return;
    }

    const session = await resolveHaplaSession(parsed.sessionId);
    const launch = buildResumeLaunch(session);

    if (!existsSync(launch.cwd)) {
        throw new Error(`Saved session path does not exist: ${launch.cwd}`);
    }

    const exitCode = await spawnResumeChild(launch, session.conversationId ?? session.id);
    if (typeof exitCode === 'number' && exitCode !== 0) {
        process.exit(exitCode);
    }
}
