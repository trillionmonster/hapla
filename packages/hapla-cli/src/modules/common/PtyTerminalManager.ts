import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import type { IPty, IPtyForkOptions } from 'node-pty';
import { ensurePtySpawnHelper } from './ptySpawnHelper';

const require = createRequire(import.meta.url);
const nodePty = require('node-pty') as typeof import('node-pty');

const MAX_TERMINALS = 4;
const MAX_BUFFERED_CHUNKS = 512;
const MAX_INPUT_LENGTH = 64 * 1024;
const IDLE_TIMEOUT_MS = 30 * 60 * 1000;
const EXIT_RETENTION_MS = 2 * 60 * 1000;

type OutputChunk = {
    cursor: number;
    data: string;
};

type ManagedTerminal = {
    id: string;
    pty: IPty;
    chunks: OutputChunk[];
    cursor: number;
    exited: boolean;
    exitCode: number | null;
    signal: number | null;
    idleTimer: NodeJS.Timeout | null;
    exitTimer: NodeJS.Timeout | null;
};

export type TerminalStartResult = {
    terminalId: string;
    pid: number;
    shell: string;
};

export type TerminalReadResult = {
    data: string;
    cursor: number;
    dataLost: boolean;
    exited: boolean;
    exitCode: number | null;
    signal: number | null;
};

function clampDimension(value: number | undefined, fallback: number, max: number): number {
    if (!Number.isFinite(value)) {
        return fallback;
    }
    return Math.max(2, Math.min(max, Math.floor(value!)));
}

function getShell(): { executable: string; args: string[] } {
    if (process.platform === 'win32') {
        return {
            executable: process.env.COMSPEC || 'cmd.exe',
            args: [],
        };
    }
    return {
        executable: process.env.SHELL || '/bin/bash',
        args: [],
    };
}

/**
 * Owns the short-lived PTYs exposed by one encrypted machine/session RPC scope.
 * Output is cursor-based so Web clients can poll without duplicating chunks.
 */
export class PtyTerminalManager {
    private readonly terminals = new Map<string, ManagedTerminal>();

    start(options: { cwd: string; cols?: number; rows?: number }): TerminalStartResult {
        ensurePtySpawnHelper(require.resolve('node-pty/package.json'));
        if (this.terminals.size >= MAX_TERMINALS) {
            const oldest = this.terminals.keys().next().value as string | undefined;
            if (oldest) {
                this.close(oldest);
            }
        }

        const shell = getShell();
        const forkOptions: IPtyForkOptions = {
            name: 'xterm-256color',
            cols: clampDimension(options.cols, 100, 500),
            rows: clampDimension(options.rows, 30, 200),
            cwd: options.cwd,
            env: {
                ...process.env,
                TERM: 'xterm-256color',
                COLORTERM: 'truecolor',
            } as Record<string, string>,
        };
        const pty = nodePty.spawn(shell.executable, shell.args, forkOptions);
        const terminal: ManagedTerminal = {
            id: randomUUID(),
            pty,
            chunks: [],
            cursor: 0,
            exited: false,
            exitCode: null,
            signal: null,
            idleTimer: null,
            exitTimer: null,
        };

        pty.onData((data) => {
            terminal.cursor += 1;
            terminal.chunks.push({ cursor: terminal.cursor, data });
            if (terminal.chunks.length > MAX_BUFFERED_CHUNKS) {
                terminal.chunks.splice(0, terminal.chunks.length - MAX_BUFFERED_CHUNKS);
            }
            this.touch(terminal);
        });
        pty.onExit((event: { exitCode: number; signal?: number }) => {
            terminal.exited = true;
            terminal.exitCode = event.exitCode;
            terminal.signal = event.signal ?? null;
            if (terminal.idleTimer) {
                clearTimeout(terminal.idleTimer);
                terminal.idleTimer = null;
            }
            terminal.exitTimer = setTimeout(() => this.close(terminal.id, false), EXIT_RETENTION_MS);
            terminal.exitTimer.unref?.();
        });

        this.terminals.set(terminal.id, terminal);
        this.touch(terminal);
        return { terminalId: terminal.id, pid: pty.pid, shell: shell.executable };
    }

    write(terminalId: string, data: string): void {
        const terminal = this.get(terminalId);
        if (terminal.exited) {
            throw new Error('Terminal process has exited');
        }
        if (!data || data.length > MAX_INPUT_LENGTH) {
            throw new Error('Terminal input must be between 1 byte and 64 KiB');
        }
        terminal.pty.write(data);
        this.touch(terminal);
    }

    resize(terminalId: string, cols?: number, rows?: number): void {
        const terminal = this.get(terminalId);
        if (terminal.exited) {
            return;
        }
        terminal.pty.resize(
            clampDimension(cols, 100, 500),
            clampDimension(rows, 30, 200),
        );
        this.touch(terminal);
    }

    read(terminalId: string, afterCursor = 0): TerminalReadResult {
        const terminal = this.get(terminalId);
        const normalizedCursor = Number.isFinite(afterCursor) ? Math.max(0, Math.floor(afterCursor)) : 0;
        const firstCursor = terminal.chunks[0]?.cursor ?? terminal.cursor + 1;
        const dataLost = normalizedCursor < firstCursor - 1;
        const data = terminal.chunks
            .filter((chunk) => chunk.cursor > normalizedCursor)
            .map((chunk) => chunk.data)
            .join('');
        this.touch(terminal);
        return {
            data,
            cursor: terminal.cursor,
            dataLost,
            exited: terminal.exited,
            exitCode: terminal.exitCode,
            signal: terminal.signal,
        };
    }

    close(terminalId: string, kill = true): void {
        const terminal = this.terminals.get(terminalId);
        if (!terminal) {
            return;
        }
        this.terminals.delete(terminalId);
        if (terminal.idleTimer) clearTimeout(terminal.idleTimer);
        if (terminal.exitTimer) clearTimeout(terminal.exitTimer);
        if (kill && !terminal.exited) {
            try {
                terminal.pty.kill();
            } catch {
                // The operating system may have already reaped the PTY.
            }
        }
    }

    dispose(): void {
        for (const terminalId of [...this.terminals.keys()]) {
            this.close(terminalId);
        }
    }

    private get(terminalId: string): ManagedTerminal {
        const terminal = this.terminals.get(terminalId);
        if (!terminal) {
            throw new Error('Terminal not found or expired');
        }
        return terminal;
    }

    private touch(terminal: ManagedTerminal): void {
        if (terminal.exited) {
            return;
        }
        if (terminal.idleTimer) {
            clearTimeout(terminal.idleTimer);
        }
        terminal.idleTimer = setTimeout(() => this.close(terminal.id), IDLE_TIMEOUT_MS);
        terminal.idleTimer.unref?.();
    }
}
