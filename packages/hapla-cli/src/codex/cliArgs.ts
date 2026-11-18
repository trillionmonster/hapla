export function extractCodexResumeFlag(args: string[]): { resumeThreadId: string | null; args: string[] } {
    const remainingArgs: string[] = [];
    let resumeThreadId: string | null = null;

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];

        if (arg === '--resume' || arg === '-r') {
            if (resumeThreadId !== null) {
                throw new Error('Codex resume flag can only be provided once.');
            }

            const nextArg = args[i + 1];
            if (!nextArg || nextArg.startsWith('-')) {
                throw new Error('Codex resume requires a thread ID: hapla codex --resume <thread-id>');
            }

            resumeThreadId = nextArg;
            i++;
            continue;
        }

        if (arg.startsWith('--resume=')) {
            if (resumeThreadId !== null) {
                throw new Error('Codex resume flag can only be provided once.');
            }

            const value = arg.slice('--resume='.length).trim();
            if (!value) {
                throw new Error('Codex resume requires a thread ID: hapla codex --resume <thread-id>');
            }

            resumeThreadId = value;
            continue;
        }

        remainingArgs.push(arg);
    }

    return {
        resumeThreadId,
        args: remainingArgs,
    };
}

export function extractCodexStartedByFlag(args: string[]): {
    startedBy: 'daemon' | 'terminal' | undefined;
    args: string[];
} {
    const remainingArgs: string[] = [];
    let startedBy: 'daemon' | 'terminal' | undefined;

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];

        if (arg === '--started-by') {
            const nextArg = args[i + 1];
            if (nextArg !== 'daemon' && nextArg !== 'terminal') {
                throw new Error('Codex started-by requires "daemon" or "terminal": hapla codex --started-by <daemon|terminal>');
            }

            startedBy = nextArg;
            i++;
            continue;
        }

        remainingArgs.push(arg);
    }

    return {
        startedBy,
        args: remainingArgs,
    };
}

export function extractHaplaStartingModeFlag(args: string[]): {
    startingMode: 'local' | 'remote' | undefined;
    args: string[];
} {
    const remainingArgs: string[] = [];
    let startingMode: 'local' | 'remote' | undefined;

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];

        if (arg === '--hapla-starting-mode') {
            const nextArg = args[i + 1];
            if (nextArg !== 'local' && nextArg !== 'remote') {
                throw new Error('Hapla starting mode requires "local" or "remote": hapla codex --hapla-starting-mode <local|remote>');
            }

            startingMode = nextArg;
            i++;
            continue;
        }

        remainingArgs.push(arg);
    }

    return {
        startingMode,
        args: remainingArgs,
    };
}
