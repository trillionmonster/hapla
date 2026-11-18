import { createHash, type Hash } from 'node:crypto';
import { closeSync, constants, ftruncateSync, mkdirSync, openSync, realpathSync, writeSync } from 'node:fs';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { stripVTControlCharacters } from 'node:util';

export const COMMAND_LIVE_OUTPUT_BYTES = 1024 * 1024;
export const COMMAND_PREVIEW_OUTPUT_BYTES = 128 * 1024;

/** Remove terminal instructions and bound individual lines before sending output to the browser. */
export function sanitizeCommandOutput(text: string): string {
    const withoutOperatingSystemCommands = text.replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\|$)/g, '');
    return stripVTControlCharacters(withoutOperatingSystemCommands)
        .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '')
        .replace(/([^\n]{16384})(?=[^\n])/g, '$1\n');
}

function utf8Tail(buffer: Buffer, maxBytes: number): Buffer {
    let start = Math.max(0, buffer.length - maxBytes);
    while (start < buffer.length && (buffer[start] & 0xc0) === 0x80) start++;
    return buffer.subarray(start);
}

type CommandOutput = {
    tail: Buffer;
    totalBytes: number;
    streamHash: Hash;
    fd: number | null;
    logPath?: string;
    command?: unknown;
    cwd?: string;
    turnId: string | null;
    threadId?: string;
    epoch?: string;
    branchId?: string;
    subagent?: string;
    parent_call_id?: string;
    parentCallId?: string;
};

export type CommandOutputPreview = {
    output: string;
    totalBytes: number;
    truncated: boolean;
    logPath?: string;
};

/** Full output is written synchronously to disk, so a slow disk cannot create an unbounded write queue. */
export class CommandOutputStore {
    private readonly commands = new Map<string, CommandOutput>();
    private readonly completed = new Map<string, { command: CommandOutput; metadata: Record<string, unknown>; bytes: number }>();
    private completedBytes = 0;
    private readonly directory: string;

    constructor(
        private readonly workspaceRoot: string,
        sessionId: string,
        private readonly onError: (error: unknown) => void,
        private readonly completedLimits = { bytes: 4 * 1024 * 1024, count: 128 },
    ) {
        this.directory = join('.hapla', 'command-logs', createHash('sha256').update(sessionId).digest('hex').slice(0, 24));
    }

    begin(id: string, message: Record<string, unknown> = {}): void {
        const protocol = message.protocol as { turnId?: unknown; threadId?: unknown; epoch?: unknown } | undefined;
        const turnId = typeof message.turn_id === 'string' ? message.turn_id
            : typeof protocol?.turnId === 'string' ? protocol.turnId : null;
        const existing = this.commands.get(id);
        if (this.completed.has(id)) return; // A late delta/start cannot reopen a terminal command.
        if (existing) {
            existing.turnId ??= turnId;
            existing.command ??= message.command;
            if (typeof message.cwd === 'string') existing.cwd ??= message.cwd;
            return;
        }
        const command: CommandOutput = {
            tail: Buffer.alloc(0), totalBytes: 0, streamHash: createHash('sha256'), fd: null, turnId,
            ...(typeof protocol?.threadId === 'string' ? { threadId: protocol.threadId } : {}),
            ...(typeof protocol?.epoch === 'string' ? { epoch: protocol.epoch } : {}),
            ...(typeof message.branchId === 'string' ? { branchId: message.branchId } : {}),
            ...(message.command !== undefined ? { command: message.command } : {}),
            ...(typeof message.cwd === 'string' ? { cwd: message.cwd } : {}),
            ...(typeof message.subagent === 'string' ? { subagent: message.subagent } : {}),
            ...(typeof message.parent_call_id === 'string' ? { parent_call_id: message.parent_call_id } : {}),
            ...(typeof message.parentCallId === 'string' ? { parentCallId: message.parentCallId } : {}),
        };
        try {
            const path = join(this.directory, `${createHash('sha256').update(id).digest('hex')}.log`);
            const absolutePath = join(this.workspaceRoot, path);
            mkdirSync(dirname(absolutePath), { recursive: true, mode: 0o700 });
            const logDirectory = relative(realpathSync(this.workspaceRoot), realpathSync(dirname(absolutePath)));
            if (logDirectory === '..' || logDirectory.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(logDirectory)) {
                throw new Error('Command output log directory is outside the session workspace');
            }
            // Never follow an existing command-log symlink or reuse a previous log.
            command.fd = openSync(absolutePath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
            command.logPath = path;
        } catch (error) {
            this.onError(error);
        }
        this.commands.set(id, command);
    }

    append(id: string, delta: string, context: Record<string, unknown> = {}): CommandOutputPreview {
        this.begin(id, context);
        const completed = this.completed.get(id);
        if (completed) return this.preview(completed.command, COMMAND_PREVIEW_OUTPUT_BYTES);
        const command = this.commands.get(id)!;
        this.appendBytes(command, Buffer.from(delta, 'utf8'));
        // Keep the 1 MiB ring locally; snapshots stay small enough for encrypted transport.
        return this.preview(command, COMMAND_PREVIEW_OUTPUT_BYTES);
    }

    complete(id: string, message: Record<string, unknown>): Record<string, unknown> {
        const completed = this.completed.get(id);
        if (!completed) this.begin(id, message);
        // Completed entries keep only a preview and metadata, never an open fd or the 1 MiB live ring.
        const command = completed ? { ...completed.command } : this.commands.get(id)!;
        const output = typeof message.output === 'string' ? message.output
            : typeof message.aggregatedOutput === 'string' ? message.aggregatedOutput : '';
        const finalBytes = Buffer.from(output, 'utf8');
        // A native head/tail aggregate inserts an omission marker and can be
        // longer than the complete stream near its 1 MiB cap. Length alone
        // cannot establish completeness. Adopt a larger aggregate only when
        // it contains every received byte as a verified prefix or suffix.
        const receivedHash = command.streamHash.copy().digest('hex');
        const containsReceivedOutput = command.totalBytes === 0 || (finalBytes.length > command.totalBytes && (
            createHash('sha256').update(finalBytes.subarray(0, command.totalBytes)).digest('hex') === receivedHash
            || createHash('sha256').update(finalBytes.subarray(finalBytes.length - command.totalBytes)).digest('hex') === receivedHash
        ));
        if (finalBytes.length > command.totalBytes && containsReceivedOutput) {
            if (completed && command.logPath) {
                try {
                    const absolutePath = join(this.workspaceRoot, command.logPath);
                    const relativeDirectory = relative(realpathSync(this.workspaceRoot), realpathSync(dirname(absolutePath)));
                    if (relativeDirectory === '..' || relativeDirectory.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(relativeDirectory)) {
                        throw new Error('Command output log directory is outside the session workspace');
                    }
                    command.fd = openSync(absolutePath, constants.O_WRONLY | constants.O_NOFOLLOW);
                } catch (error) { this.failLog(command, error); }
            }
            if (command.fd !== null) {
                try { ftruncateSync(command.fd, 0); }
                catch (error) { this.failLog(command, error); }
            }
            command.tail = Buffer.alloc(0);
            command.totalBytes = 0;
            command.streamHash = createHash('sha256');
            this.appendBytes(command, finalBytes);
        }
        const preview = this.preview(command, COMMAND_PREVIEW_OUTPUT_BYTES);
        this.close(command);
        this.commands.delete(id);
        const metadata = {
            ...completed?.metadata,
            ...message,
            command: message.command ?? command.command,
            cwd: message.cwd ?? command.cwd,
            turn_id: message.turn_id ?? command.turnId,
            branchId: command.branchId,
            // A real item/completed supersedes a result inferred from turn authority.
            completedByTurn: message.completedByTurn === true,
            commandNotStarted: message.commandNotStarted === true,
        };
        this.rememberCompleted(id, command, metadata);
        return {
            ...metadata,
            ...preview,
        };
    }

    getContext(id: string): Pick<CommandOutput, 'turnId' | 'threadId' | 'epoch' | 'branchId'> | null {
        const command = this.commands.get(id) ?? this.completed.get(id)?.command;
        return command ? { turnId: command.turnId, threadId: command.threadId, epoch: command.epoch, branchId: command.branchId } : null;
    }

    /** An authoritative interrupted/failed turn closes tool cards even when the provider omits item/completed. */
    finishTurn(turnId: string, status: 'interrupted' | 'failed', confirmedItemIds: ReadonlySet<string> = new Set()): Record<string, unknown>[] {
        const completed: Record<string, unknown>[] = [];
        for (const [id, command] of this.commands) {
            if (command.turnId !== turnId) continue;
            completed.push(this.complete(id, {
                type: 'exec_command_end', call_id: id, item_id: id, turn_id: turnId, status, completedByTurn: true,
                ...(confirmedItemIds.has(id) ? { commandTerminationConfirmed: true } : {}),
                ...(command.subagent ? { subagent: command.subagent } : {}),
                ...(command.parent_call_id ? { parent_call_id: command.parent_call_id } : {}),
                ...(command.parentCallId ? { parentCallId: command.parentCallId } : {}),
            }));
        }
        return completed;
    }

    dispose(): void {
        for (const command of this.commands.values()) this.close(command);
        this.commands.clear();
        this.completed.clear();
        this.completedBytes = 0;
    }

    private rememberCompleted(id: string, command: CommandOutput, message: Record<string, unknown>): void {
        const previous = this.completed.get(id);
        if (previous) this.completedBytes -= previous.bytes;
        this.completed.delete(id);
        const retained = { ...command, streamHash: command.streamHash.copy(), fd: null, tail: Buffer.from(utf8Tail(command.tail, COMMAND_PREVIEW_OUTPUT_BYTES)) };
        const metadata: Record<string, unknown> = {};
        for (const key of ['status', 'exit_code', 'exitCode', 'duration_ms', 'durationMs', 'completedByTurn', 'commandNotStarted', 'commandTerminationConfirmed', 'subagent', 'parent_call_id', 'parentCallId']) {
            if (message[key] !== undefined) metadata[key] = message[key];
        }
        const bytes = retained.tail.length + 256 + Buffer.byteLength(JSON.stringify({ ...retained, tail: undefined, streamHash: undefined, metadata }), 'utf8');
        if (bytes > this.completedLimits.bytes) return;
        this.completed.set(id, { command: retained, metadata, bytes });
        this.completedBytes += bytes;
        while (this.completed.size > this.completedLimits.count || this.completedBytes > this.completedLimits.bytes) {
            const oldest = this.completed.entries().next().value;
            if (!oldest) break;
            this.completedBytes -= oldest[1].bytes;
            this.completed.delete(oldest[0]);
        }
    }

    private appendBytes(command: CommandOutput, bytes: Buffer): void {
        if (command.fd !== null) {
            try {
                let offset = 0;
                while (offset < bytes.length) {
                    offset += writeSync(command.fd, bytes, offset, bytes.length - offset, command.totalBytes + offset);
                }
            } catch (error) { this.failLog(command, error); }
        }
        command.totalBytes += bytes.length;
        command.streamHash.update(bytes);
        const kept = bytes.length >= COMMAND_LIVE_OUTPUT_BYTES
            ? utf8Tail(bytes, COMMAND_LIVE_OUTPUT_BYTES)
            : utf8Tail(Buffer.concat([command.tail, bytes]), COMMAND_LIVE_OUTPUT_BYTES);
        // Copy a short tail so it cannot retain an arbitrarily large incoming Buffer allocation.
        command.tail = Buffer.from(kept);
    }

    private preview(command: CommandOutput, maxBytes: number): CommandOutputPreview {
        const tail = utf8Tail(command.tail, maxBytes);
        const sanitized = Buffer.from(sanitizeCommandOutput(tail.toString('utf8')), 'utf8');
        return {
            output: utf8Tail(sanitized, maxBytes).toString('utf8'),
            totalBytes: command.totalBytes,
            truncated: command.totalBytes > tail.length || sanitized.length > maxBytes,
            ...(command.logPath ? { logPath: command.logPath } : {}),
        };
    }

    private failLog(command: CommandOutput, error: unknown): void {
        this.close(command);
        delete command.logPath;
        this.onError(error);
    }

    private close(command: CommandOutput): void {
        if (command.fd === null) return;
        try { closeSync(command.fd); } catch (error) { this.onError(error); }
        command.fd = null;
    }
}
