import { logger } from '@/ui/logger';
import { exec, ExecOptions } from 'child_process';
import { promisify } from 'util';
import { open, readFile, writeFile, readdir, stat } from 'fs/promises';
import { createHash } from 'crypto';
import { join } from 'path';
import { run as runRipgrep } from '@/modules/ripgrep/index';
import { run as runDifftastic } from '@/modules/difftastic/index';
import { RpcHandlerManager } from '../../api/rpc/RpcHandlerManager';
import { validatePath } from './pathSecurity';
import { PtyTerminalManager } from './PtyTerminalManager';
import { FileTransferManager } from './FileTransferManager';
import { WorkspaceVideoPreviewManager } from './workspaceVideoPreview';
import { createWorkspacePreview } from './workspacePreview';

const execAsync = promisify(exec);

interface BashRequest {
    command: string;
    cwd?: string;
    timeout?: number; // timeout in milliseconds
}

interface BashResponse {
    success: boolean;
    stdout?: string;
    stderr?: string;
    exitCode?: number;
    error?: string;
}

interface ReadFileRequest {
    path: string;
    maxBytes?: number;
    offset?: number;
    length?: number;
}

interface ReadFileResponse {
    success: boolean;
    content?: string; // base64 encoded
    totalSize?: number;
    nextOffset?: number;
    error?: string;
}

interface WriteFileRequest {
    path: string;
    content: string; // base64 encoded
    expectedHash?: string | null; // null for new files, hash for existing files
}

interface WriteFileResponse {
    success: boolean;
    hash?: string; // hash of written file
    error?: string;
}

interface ListDirectoryRequest {
    path: string;
}

interface DirectoryEntry {
    name: string;
    type: 'file' | 'directory' | 'other';
    size?: number;
    modified?: number; // timestamp
}

interface ListDirectoryResponse {
    success: boolean;
    entries?: DirectoryEntry[];
    error?: string;
}

interface GetDirectoryTreeRequest {
    path: string;
    maxDepth: number;
}

interface TreeNode {
    name: string;
    path: string;
    type: 'file' | 'directory';
    size?: number;
    modified?: number;
    children?: TreeNode[]; // Only present for directories
}

interface GetDirectoryTreeResponse {
    success: boolean;
    tree?: TreeNode;
    error?: string;
}

interface RipgrepRequest {
    args: string[];
    cwd?: string;
}

interface RipgrepResponse {
    success: boolean;
    exitCode?: number;
    stdout?: string;
    stderr?: string;
    error?: string;
}

interface DifftasticRequest {
    args: string[];
    cwd?: string;
}

interface DifftasticResponse {
    success: boolean;
    exitCode?: number;
    stdout?: string;
    stderr?: string;
    error?: string;
}

/*
 * Spawn Session Options and Result
 * This rpc type is used by the daemon, all other RPCs here are for sessions
*/

export interface SpawnSessionOptions {
    machineId?: string;
    directory: string;
    sessionId?: string;
    approvedNewDirectoryCreation?: boolean;
    agent?: 'claude' | 'codex';
    environmentVariables?: Record<string, string>;
    token?: string;
}

export type SpawnSessionResult =
    | { type: 'success'; sessionId: string }
    | { type: 'requestToApproveDirectoryCreation'; directory: string }
    | { type: 'error'; errorMessage: string };

/**
 * Register all RPC handlers with the session
 */
export function registerCommonHandlers(rpcHandlerManager: RpcHandlerManager, workingDirectory: string) {
    rpcHandlerManager.registerHandler('preview-document', async (data: { target?: string }) => {
        try { return { success: true, ...await createWorkspacePreview(workingDirectory, data?.target ?? '') }; }
        catch (problem) { return { success: false, error: problem instanceof Error ? problem.message : '网页预览失败' }; }
    });
    const terminalManager = new PtyTerminalManager();
    const fileTransferManager = new FileTransferManager(workingDirectory);
    const videoPreviewManager = new WorkspaceVideoPreviewManager(workingDirectory);

    rpcHandlerManager.registerHandler('getVideoPreview', async (data: { path?: string }) => {
        return videoPreviewManager.getPreview(data?.path);
    });

    rpcHandlerManager.registerHandler('file-download-info', async (data: { path?: string }) => {
        return fileTransferManager.downloadInfo(data?.path ?? '');
    });

    rpcHandlerManager.registerHandler('file-download-chunk', async (data: { path?: string; offset?: number; length?: number; expectedModified?: number }) => {
        return fileTransferManager.downloadChunk(data?.path ?? '', data?.offset ?? -1, data?.length ?? -1, data?.expectedModified);
    });

    rpcHandlerManager.registerHandler('file-upload-begin', async (data: { path?: string; size?: number; overwrite?: boolean; sha256?: string }) => {
        return fileTransferManager.beginUpload(data?.path ?? '', data?.size ?? -1, data?.overwrite === true, data?.sha256);
    });

    rpcHandlerManager.registerHandler('file-upload-status', async (data: { uploadId?: string }) => {
        return fileTransferManager.uploadStatus(data?.uploadId ?? '');
    });

    rpcHandlerManager.registerHandler('file-upload-chunk', async (data: { uploadId?: string; offset?: number; content?: string }) => {
        return fileTransferManager.uploadChunk(data?.uploadId ?? '', data?.offset ?? -1, data?.content ?? '');
    });

    rpcHandlerManager.registerHandler('file-upload-finish', async (data: { uploadId?: string }) => {
        return fileTransferManager.finishUpload(data?.uploadId ?? '');
    });

    rpcHandlerManager.registerHandler('file-upload-abort', async (data: { uploadId?: string }) => {
        return fileTransferManager.abortUpload(data?.uploadId ?? '');
    });

    rpcHandlerManager.registerHandler('terminal-start', async (data: { cwd?: string; cols?: number; rows?: number }) => {
        const validation = validatePath(data.cwd || workingDirectory, workingDirectory);
        if (!validation.valid || !validation.resolvedPath) {
            throw new Error(validation.error || 'Invalid terminal working directory');
        }
        return terminalManager.start({
            cwd: validation.resolvedPath,
            cols: data.cols,
            rows: data.rows,
        });
    });

    rpcHandlerManager.registerHandler('terminal-write', async (data: { terminalId?: string; data?: string }) => {
        if (!data.terminalId || typeof data.data !== 'string') {
            throw new Error('Terminal ID and input are required');
        }
        terminalManager.write(data.terminalId, data.data);
        return { success: true };
    });

    rpcHandlerManager.registerHandler('terminal-resize', async (data: { terminalId?: string; cols?: number; rows?: number }) => {
        if (!data.terminalId) {
            throw new Error('Terminal ID is required');
        }
        terminalManager.resize(data.terminalId, data.cols, data.rows);
        return { success: true };
    });

    rpcHandlerManager.registerHandler('terminal-read', async (data: { terminalId?: string; cursor?: number }) => {
        if (!data.terminalId) {
            throw new Error('Terminal ID is required');
        }
        return terminalManager.read(data.terminalId, data.cursor);
    });

    rpcHandlerManager.registerHandler('terminal-close', async (data: { terminalId?: string }) => {
        if (data.terminalId) {
            terminalManager.close(data.terminalId);
        }
        return { success: true };
    });

    // Shell command handler - executes commands in the default shell
    rpcHandlerManager.registerHandler<BashRequest, BashResponse>('bash', async (data) => {
        logger.debug('Shell command request:', data.command);

        // Validate cwd if provided
        // Special case: "/" means "use shell's default cwd" (used by CLI detection)
        // Security: Still validate all other paths to prevent directory traversal
        if (data.cwd && data.cwd !== '/') {
            const validation = validatePath(data.cwd, workingDirectory);
            if (!validation.valid) {
                return { success: false, error: validation.error };
            }
            data.cwd = validation.resolvedPath;
        }

        try {
            // Build options with shell enabled by default
            // Note: ExecOptions doesn't support boolean for shell, but exec() uses the default shell when shell is undefined
            // If cwd is "/", use undefined to let shell use its default (respects user's PATH)
            const options: ExecOptions = {
                cwd: data.cwd === '/' ? undefined : data.cwd,
                timeout: data.timeout || 30000, // Default 30 seconds timeout
                windowsHide: true, // Prevent cmd.exe popup on Windows for every RPC bash call
            };

            logger.debug('Shell command executing...', { cwd: options.cwd, timeout: options.timeout });
            const { stdout, stderr } = await execAsync(data.command, options);
            logger.debug('Shell command executed, processing result...');

            const result = {
                success: true,
                stdout: stdout ? stdout.toString() : '',
                stderr: stderr ? stderr.toString() : '',
                exitCode: 0
            };
            logger.debug('Shell command result:', {
                success: true,
                exitCode: 0,
                stdoutLen: result.stdout.length,
                stderrLen: result.stderr.length
            });
            return result;
        } catch (error) {
            const execError = error as NodeJS.ErrnoException & {
                stdout?: string;
                stderr?: string;
                code?: number | string;
                killed?: boolean;
            };

            // Check if the error was due to timeout
            if (execError.code === 'ETIMEDOUT' || execError.killed) {
                const result = {
                    success: false,
                    stdout: execError.stdout || '',
                    stderr: execError.stderr || '',
                    exitCode: typeof execError.code === 'number' ? execError.code : -1,
                    error: 'Command timed out'
                };
                logger.debug('Shell command timed out:', {
                    success: false,
                    exitCode: result.exitCode,
                    error: 'Command timed out'
                });
                return result;
            }

            // If exec fails, it includes stdout/stderr in the error
            const result = {
                success: false,
                stdout: execError.stdout ? execError.stdout.toString() : '',
                stderr: execError.stderr ? execError.stderr.toString() : execError.message || 'Command failed',
                exitCode: typeof execError.code === 'number' ? execError.code : 1,
                error: execError.message || 'Command failed'
            };
            logger.debug('Shell command failed:', {
                success: false,
                exitCode: result.exitCode,
                error: result.error,
                stdoutLen: result.stdout.length,
                stderrLen: result.stderr.length
            });
            return result;
        }
    });

    // Read file handler - returns base64 encoded content
    rpcHandlerManager.registerHandler<ReadFileRequest, ReadFileResponse>('readFile', async (data) => {
        logger.debug('Read file request:', data.path);

        // Validate path is within working directory
        const validation = validatePath(data.path, workingDirectory);
        if (!validation.valid) {
            return { success: false, error: validation.error };
        }

        try {
            const maxBytes = Math.max(1, Math.min(data.maxBytes ?? 25 * 1024 * 1024, 60 * 1024 * 1024));
            const fileStats = await stat(validation.resolvedPath!);
            if (fileStats.size > maxBytes) {
                return {
                    success: false,
                    error: `File is too large to preview (${Math.ceil(fileStats.size / 1024 / 1024)} MiB). Limit: ${Math.floor(maxBytes / 1024 / 1024)} MiB`,
                };
            }

            // Media previews request bounded chunks. Keeping each encrypted RPC
            // response well below Socket.IO's default 1 MiB frame limit avoids
            // reconnect loops and works without raising server memory limits.
            if (data.offset !== undefined || data.length !== undefined) {
                const offset = Math.max(0, Math.floor(data.offset ?? 0));
                const length = Math.max(1, Math.min(Math.floor(data.length ?? 384 * 1024), 384 * 1024));
                if (offset > fileStats.size) {
                    return { success: false, error: 'Read offset is past the end of the file' };
                }
                const bytesToRead = Math.min(length, fileStats.size - offset);
                const buffer = Buffer.alloc(bytesToRead);
                const handle = await open(validation.resolvedPath!, 'r');
                try {
                    const { bytesRead } = await handle.read(buffer, 0, bytesToRead, offset);
                    const nextOffset = offset + bytesRead;
                    return {
                        success: true,
                        content: buffer.subarray(0, bytesRead).toString('base64'),
                        totalSize: fileStats.size,
                        nextOffset,
                    };
                } finally {
                    await handle.close();
                }
            }
            const buffer = await readFile(validation.resolvedPath!);
            const content = buffer.toString('base64');
            return { success: true, content, totalSize: fileStats.size, nextOffset: fileStats.size };
        } catch (error) {
            logger.debug('Failed to read file:', error);
            return { success: false, error: error instanceof Error ? error.message : 'Failed to read file' };
        }
    });

    // Write file handler - with hash verification
    rpcHandlerManager.registerHandler<WriteFileRequest, WriteFileResponse>('writeFile', async (data) => {
        logger.debug('Write file request:', data.path);

        // Validate path is within working directory
        const validation = validatePath(data.path, workingDirectory);
        if (!validation.valid) {
            return { success: false, error: validation.error };
        }

        try {
            // If expectedHash is provided (not null), verify existing file
            if (data.expectedHash !== null && data.expectedHash !== undefined) {
                try {
                    const existingBuffer = await readFile(validation.resolvedPath!);
                    const existingHash = createHash('sha256').update(existingBuffer).digest('hex');

                    if (existingHash !== data.expectedHash) {
                        return {
                            success: false,
                            error: `File hash mismatch. Expected: ${data.expectedHash}, Actual: ${existingHash}`
                        };
                    }
                } catch (error) {
                    const nodeError = error as NodeJS.ErrnoException;
                    if (nodeError.code !== 'ENOENT') {
                        throw error;
                    }
                    // File doesn't exist but hash was provided
                    return {
                        success: false,
                        error: 'File does not exist but hash was provided'
                    };
                }
            } else {
                // expectedHash is null - expecting new file
                try {
                    await stat(validation.resolvedPath!);
                    // File exists but we expected it to be new
                    return {
                        success: false,
                        error: 'File already exists but was expected to be new'
                    };
                } catch (error) {
                    const nodeError = error as NodeJS.ErrnoException;
                    if (nodeError.code !== 'ENOENT') {
                        throw error;
                    }
                    // File doesn't exist - this is expected
                }
            }

            // Write the file
            const buffer = Buffer.from(data.content, 'base64');
            await writeFile(validation.resolvedPath!, buffer);

            // Calculate and return hash of written file
            const hash = createHash('sha256').update(buffer).digest('hex');

            return { success: true, hash };
        } catch (error) {
            logger.debug('Failed to write file:', error);
            return { success: false, error: error instanceof Error ? error.message : 'Failed to write file' };
        }
    });

    // List directory handler
    rpcHandlerManager.registerHandler<ListDirectoryRequest, ListDirectoryResponse>('listDirectory', async (data) => {
        logger.debug('List directory request:', data.path);

        // Validate path is within working directory
        const validation = validatePath(data.path, workingDirectory);
        if (!validation.valid) {
            return { success: false, error: validation.error };
        }

        try {
            const directoryPath = validation.resolvedPath!;
            const entries = await readdir(directoryPath, { withFileTypes: true });

            const directoryEntries: DirectoryEntry[] = await Promise.all(
                entries.map(async (entry) => {
                    const fullPath = join(directoryPath, entry.name);
                    let type: 'file' | 'directory' | 'other' = 'other';
                    let size: number | undefined;
                    let modified: number | undefined;

                    if (entry.isDirectory()) {
                        type = 'directory';
                    } else if (entry.isFile()) {
                        type = 'file';
                    }

                    try {
                        const stats = await stat(fullPath);
                        size = stats.size;
                        modified = stats.mtime.getTime();
                    } catch (error) {
                        // Ignore stat errors for individual files
                        logger.debug(`Failed to stat ${fullPath}:`, error);
                    }

                    return {
                        name: entry.name,
                        type,
                        size,
                        modified
                    };
                })
            );

            // Sort entries: directories first, then files, alphabetically
            directoryEntries.sort((a, b) => {
                if (a.type === 'directory' && b.type !== 'directory') return -1;
                if (a.type !== 'directory' && b.type === 'directory') return 1;
                return a.name.localeCompare(b.name);
            });

            return { success: true, entries: directoryEntries };
        } catch (error) {
            logger.debug('Failed to list directory:', error);
            return { success: false, error: error instanceof Error ? error.message : 'Failed to list directory' };
        }
    });

    // Get directory tree handler - recursive with depth control
    rpcHandlerManager.registerHandler<GetDirectoryTreeRequest, GetDirectoryTreeResponse>('getDirectoryTree', async (data) => {
        logger.debug('Get directory tree request:', data.path, 'maxDepth:', data.maxDepth);

        // Validate path is within working directory
        const validation = validatePath(data.path, workingDirectory);
        if (!validation.valid) {
            return { success: false, error: validation.error };
        }

        // Helper function to build tree recursively
        async function buildTree(path: string, name: string, currentDepth: number): Promise<TreeNode | null> {
            try {
                const stats = await stat(path);

                // Base node information
                const node: TreeNode = {
                    name,
                    path,
                    type: stats.isDirectory() ? 'directory' : 'file',
                    size: stats.size,
                    modified: stats.mtime.getTime()
                };

                // If it's a directory and we haven't reached max depth, get children
                if (stats.isDirectory() && currentDepth < data.maxDepth) {
                    const entries = await readdir(path, { withFileTypes: true });
                    const children: TreeNode[] = [];

                    // Process entries in parallel, filtering out symlinks
                    await Promise.all(
                        entries.map(async (entry) => {
                            // Skip symbolic links completely
                            if (entry.isSymbolicLink()) {
                                logger.debug(`Skipping symlink: ${join(path, entry.name)}`);
                                return;
                            }

                            const childPath = join(path, entry.name);
                            const childNode = await buildTree(childPath, entry.name, currentDepth + 1);
                            if (childNode) {
                                children.push(childNode);
                            }
                        })
                    );

                    // Sort children: directories first, then files, alphabetically
                    children.sort((a, b) => {
                        if (a.type === 'directory' && b.type !== 'directory') return -1;
                        if (a.type !== 'directory' && b.type === 'directory') return 1;
                        return a.name.localeCompare(b.name);
                    });

                    node.children = children;
                }

                return node;
            } catch (error) {
                // Log error but continue traversal
                logger.debug(`Failed to process ${path}:`, error instanceof Error ? error.message : String(error));
                return null;
            }
        }

        try {
            // Validate maxDepth
            if (data.maxDepth < 0) {
                return { success: false, error: 'maxDepth must be non-negative' };
            }

            // Get the base name for the root node
            const rootPath = validation.resolvedPath!;
            const baseName = rootPath === '/' ? '/' : rootPath.split('/').pop() || rootPath;
            const tree = await buildTree(rootPath, baseName, 0);

            if (!tree) {
                return { success: false, error: 'Failed to access the specified path' };
            }

            return { success: true, tree };
        } catch (error) {
            logger.debug('Failed to get directory tree:', error);
            return { success: false, error: error instanceof Error ? error.message : 'Failed to get directory tree' };
        }
    });

    // Ripgrep handler - raw interface to ripgrep
    rpcHandlerManager.registerHandler<RipgrepRequest, RipgrepResponse>('ripgrep', async (data) => {
        logger.debug('Ripgrep request with args:', data.args, 'cwd:', data.cwd);

        // Validate cwd if provided
        if (data.cwd) {
            const validation = validatePath(data.cwd, workingDirectory);
            if (!validation.valid) {
                return { success: false, error: validation.error };
            }
            data.cwd = validation.resolvedPath;
        }

        try {
            const result = await runRipgrep(data.args, { cwd: data.cwd });
            return {
                success: true,
                exitCode: result.exitCode,
                stdout: result.stdout.toString(),
                stderr: result.stderr.toString()
            };
        } catch (error) {
            logger.debug('Failed to run ripgrep:', error);
            return {
                success: false,
                error: error instanceof Error ? error.message : 'Failed to run ripgrep'
            };
        }
    });

    // Difftastic handler - raw interface to difftastic
    rpcHandlerManager.registerHandler<DifftasticRequest, DifftasticResponse>('difftastic', async (data) => {
        logger.debug('Difftastic request with args:', data.args, 'cwd:', data.cwd);

        // Validate cwd if provided
        if (data.cwd) {
            const validation = validatePath(data.cwd, workingDirectory);
            if (!validation.valid) {
                return { success: false, error: validation.error };
            }
            data.cwd = validation.resolvedPath;
        }

        try {
            const result = await runDifftastic(data.args, { cwd: data.cwd });
            return {
                success: true,
                exitCode: result.exitCode,
                stdout: result.stdout.toString(),
                stderr: result.stderr.toString()
            };
        } catch (error) {
            logger.debug('Failed to run difftastic:', error);
            return {
                success: false,
                error: error instanceof Error ? error.message : 'Failed to run difftastic'
            };
        }
    });
}
