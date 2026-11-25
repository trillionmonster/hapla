/**
 * Session operations for remote procedure calls
 * Provides strictly typed functions for all session-related RPC operations
 */

import { apiSocket } from './apiSocket';
import { sync } from './sync';
import type { MachineMetadata, Metadata } from './storageTypes';
import { storage } from './storage';
import { assertPermissionRpcSuccess } from './permissionRpcResult';
import { readSessionFile } from './sessionFileRead';
import { readVideoPreview } from './sessionVideoPreview';
import type { CodexUpdateResponse } from '@hapla/wire';

// Strict type definitions for all operations

// Permission operation types
interface SessionPermissionRequest {
    id: string;
    approved: boolean;
    reason?: string;
    mode?: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan';
    allowTools?: string[];
    updatedInput?: Record<string, unknown>;
    decision?: 'approved' | 'approved_for_session' | 'denied' | 'abort';
}

// Mode change operation types
interface SessionModeChangeRequest {
    to: 'remote' | 'local';
}

// Bash operation types
interface SessionBashRequest {
    command: string;
    cwd?: string;
    timeout?: number;
}

interface SessionBashResponse {
    success: boolean;
    stdout: string;
    stderr: string;
    exitCode: number;
    error?: string;
}

export type SessionTerminalStartResponse = {
    terminalId: string;
    pid: number;
    shell: string;
};

export type SessionTerminalReadResponse = {
    data: string;
    cursor: number;
    dataLost: boolean;
    exited: boolean;
    exitCode: number | null;
    signal: number | null;
};

export type McpAppResourceContent =
    | { uri: string; mimeType?: string; text: string; _meta?: unknown }
    | { uri: string; mimeType?: string; blob: string; _meta?: unknown };

export type McpAppToolCallResponse = {
    content: unknown[];
    structuredContent?: unknown;
    isError?: boolean;
    _meta?: unknown;
};

// Read file operation types
interface SessionReadFileRequest {
    path: string;
    maxBytes?: number;
    offset?: number;
    length?: number;
}

interface SessionReadFileResponse {
    success: boolean;
    content?: string; // base64 encoded
    totalSize?: number;
    nextOffset?: number;
    error?: string;
}

// Write file operation types
interface SessionWriteFileRequest {
    path: string;
    content: string; // base64 encoded
    expectedHash?: string | null;
}

interface SessionWriteFileResponse {
    success: boolean;
    hash?: string;
    error?: string;
}

export type SessionFileDownloadInfoResponse =
    | { success: true; name: string; size: number; modified: number; chunkSize: number }
    | { success: false; error: string };

export type SessionFileDownloadChunkResponse =
    | { success: true; content: string; bytesRead: number; eof: boolean }
    | { success: false; error: string };

export type SessionFileUploadBeginResponse =
    | { success: true; uploadId: string; chunkSize: number }
    | { success: false; error: string; conflict?: boolean };

export type SessionFileUploadChunkResponse =
    | { success: true; received: number }
    | { success: false; error: string };

export type SessionFileUploadFinishResponse =
    | { success: true; path: string; size: number; sha256?: string }
    | { success: false; error: string; conflict?: boolean };

// List directory operation types
interface SessionListDirectoryRequest {
    path: string;
}

interface DirectoryEntry {
    name: string;
    type: 'file' | 'directory' | 'other';
    size?: number;
    modified?: number;
}

interface SessionListDirectoryResponse {
    success: boolean;
    entries?: DirectoryEntry[];
    error?: string;
}

// Directory tree operation types
interface SessionGetDirectoryTreeRequest {
    path: string;
    maxDepth: number;
}

interface TreeNode {
    name: string;
    path: string;
    type: 'file' | 'directory';
    size?: number;
    modified?: number;
    children?: TreeNode[];
}

interface SessionGetDirectoryTreeResponse {
    success: boolean;
    tree?: TreeNode;
    error?: string;
}

// Ripgrep operation types
interface SessionRipgrepRequest {
    args: string[];
    cwd?: string;
}

interface SessionRipgrepResponse {
    success: boolean;
    exitCode?: number;
    stdout?: string;
    stderr?: string;
    error?: string;
}

// Kill session operation types
interface SessionKillRequest {
    // No parameters needed
}

interface SessionKillResponse {
    success: boolean;
    message: string;
}

// Response types for spawn session
export type SpawnSessionResult =
    | { type: 'success'; sessionId: string }
    | { type: 'requestToApproveDirectoryCreation'; directory: string }
    | { type: 'error'; errorMessage: string; confirmed?: boolean };

// Options for spawning a session
export interface SpawnSessionOptions {
    requestId?: string;
    machineId: string;
    directory: string;
    approvedNewDirectoryCreation?: boolean;
    token?: string;
    agent?: 'codex' | 'claude';
    environmentVariables?: Record<string, string>;
}

export interface ResumeSessionOptions {
    machineId: string;
    sessionId: string;
    conversationId: string;
    metadata: Pick<Metadata, 'path' | 'flavor' | 'codexThreadId' | 'claudeSessionId' | 'conversationRootSessionId' | 'codexBranches' | 'activeCodexBranchId' | 'launchSpecId' | 'executionConfiguration'>;
}

export async function machineStopSession(machineId: string, sessionId: string): Promise<void> {
    await apiSocket.machineRPC<{ message: string }, { sessionId: string }>(
        machineId,
        'stop-session',
        { sessionId },
    );
}

// Exported session operation functions

/**
 * Spawn a new remote session on a specific machine
 */
export async function machineSpawnNewSession(options: SpawnSessionOptions): Promise<SpawnSessionResult> {

    const { machineId, directory, approvedNewDirectoryCreation = false, token, agent, environmentVariables, requestId } = options;

    try {
        const result = await apiSocket.machineRPC<SpawnSessionResult, {
            type: 'spawn-in-directory'
            requestId?: string
            directory: string
            approvedNewDirectoryCreation?: boolean,
            token?: string,
            agent?: 'codex' | 'claude',
            environmentVariables?: Record<string, string>,
        }>(
            machineId,
            'spawn-hapla-session',
            { type: 'spawn-in-directory', directory, approvedNewDirectoryCreation, token, agent, environmentVariables, requestId }
        );
        return result;
    } catch (error) {
        // Handle RPC errors
        return {
            type: 'error',
            errorMessage: error instanceof Error ? error.message : 'Failed to spawn session'
        };
    }
}

export async function machineResumeSession(options: ResumeSessionOptions): Promise<SpawnSessionResult> {
    const { machineId, sessionId } = options;

    try {
        const result = await apiSocket.machineRPC<SpawnSessionResult, { sessionId: string; conversationId: string; metadata: ResumeSessionOptions['metadata'] }>(
            machineId,
            'resume-hapla-session',
            { sessionId, conversationId: options.conversationId, metadata: options.metadata },
        );
        return result;
    } catch (error) {
        return {
            type: 'error',
            errorMessage: error instanceof Error ? error.message : 'Failed to continue this conversation',
        };
    }
}

/**
 * Permanently remove a machine from the server. Sessions spawned by the
 * machine are preserved; only the Machine row and its AccessKeys are deleted.
 */
export async function machineDelete(machineId: string): Promise<{ success: boolean; message?: string }> {
    try {
        const response = await apiSocket.request(`/v1/machines/${machineId}`, {
            method: 'DELETE'
        });
        if (response.ok) {
            return { success: true };
        }
        const error = await response.text();
        return { success: false, message: error || 'Failed to delete machine' };
    } catch (error) {
        return {
            success: false,
            message: error instanceof Error ? error.message : 'Unknown error'
        };
    }
}

/**
 * Stop the daemon on a specific machine
 */
export async function machineStopDaemon(machineId: string): Promise<{ message: string }> {
    const result = await apiSocket.machineRPC<{ message: string }, {}>(
        machineId,
        'stop-daemon',
        {}
    );
    return result;
}

export async function machineRefreshCliCapabilities(machineId: string) {
    const capabilities = await apiSocket.machineRPC<MachineMetadata['cliCapabilities'] | null, {}>(
        machineId,
        'refresh-cli-capabilities',
        {},
    );
    await sync.refreshMachines();
    return capabilities;
}

/** The daemon owns the update job; this RPC only reads its current state. */
export async function machineCodexUpdateStatus(machineId: string): Promise<CodexUpdateResponse> {
    return apiSocket.machineRPC<CodexUpdateResponse, Record<string, never>>(
        machineId, 'codex-update-status', {}, 20_000,
    );
}

/** Returns promptly after scheduling an update, even when installation takes minutes. */
export async function machineCodexUpdateStart(machineId: string): Promise<CodexUpdateResponse> {
    return apiSocket.machineRPC<CodexUpdateResponse, Record<string, never>>(
        machineId, 'codex-update-start', {}, 20_000,
    );
}

export async function machineSetCodexSkillEnabled(options: {
    machineId: string;
    name: string;
    path: string;
    enabled: boolean;
    cwd?: string;
}) {
    const { machineId, ...params } = options;
    const result = await apiSocket.machineRPC<{
        effectiveEnabled: boolean;
        skills: NonNullable<NonNullable<MachineMetadata['cliCapabilities']>['codex']>['skills'];
    }, typeof params>(
        machineId,
        'set-codex-skill-enabled',
        params,
    );
    await sync.refreshMachines();
    return result;
}

export type CliSkillProvider = 'codex' | 'claude';

export async function machineReadCliSkill(options: {
    machineId: string;
    provider: CliSkillProvider;
    path: string;
    cwd?: string;
}) {
    const { machineId, ...params } = options;
    return apiSocket.machineRPC<{
        source: string;
        path: string;
        editable: boolean;
        scope: 'user' | 'project' | 'system';
        interactiveManifest: string | null;
    }, typeof params>(machineId, 'read-cli-skill', params);
}

export async function machineSaveCliSkill(options: {
    machineId: string;
    provider: CliSkillProvider;
    name: string;
    description?: string;
    source?: string;
    interactiveManifest?: string | null;
    path?: string | null;
    cwd?: string;
}) {
    const { machineId, ...params } = options;
    const result = await apiSocket.machineRPC<{ path: string; created: boolean; interactive: boolean }, typeof params>(
        machineId,
        'save-cli-skill',
        params,
    );
    await sync.refreshMachines();
    return result;
}

export async function machineTrashCliSkill(options: {
    machineId: string;
    provider: CliSkillProvider;
    path: string;
    cwd?: string;
}) {
    const { machineId, ...params } = options;
    const result = await apiSocket.machineRPC<{ trashedPath: string }, typeof params>(
        machineId,
        'trash-cli-skill',
        params,
    );
    await sync.refreshMachines();
    return result;
}

/**
 * Execute a bash command on a specific machine
 */
export async function machineBash(
    machineId: string,
    command: string,
    cwd: string
): Promise<{
    success: boolean;
    stdout: string;
    stderr: string;
    exitCode: number;
}> {
    try {
        const result = await apiSocket.machineRPC<{
            success: boolean;
            stdout: string;
            stderr: string;
            exitCode: number;
        }, {
            command: string;
            cwd: string;
        }>(
            machineId,
            'bash',
            { command, cwd }
        );
        return result;
    } catch (error) {
        return {
            success: false,
            stdout: '',
            stderr: error instanceof Error ? error.message : 'Unknown error',
            exitCode: -1
        };
    }
}

/**
 * Update machine metadata with optimistic concurrency control and automatic retry
 */
export async function machineUpdateMetadata(
    machineId: string,
    metadata: MachineMetadata,
    expectedVersion: number,
    maxRetries: number = 3
): Promise<{ version: number; metadata: string }> {
    let currentVersion = expectedVersion;
    let currentMetadata = { ...metadata };
    let retryCount = 0;

    const machineEncryption = sync.encryption.getMachineEncryption(machineId);
    if (!machineEncryption) {
        throw new Error(`Machine encryption not found for ${machineId}`);
    }

    while (retryCount < maxRetries) {
        const encryptedMetadata = await machineEncryption.encryptRaw(currentMetadata);

        const result = await apiSocket.emitWithAck<{
            result: 'success' | 'version-mismatch' | 'error';
            version?: number;
            metadata?: string;
            message?: string;
        }>('machine-update-metadata', {
            machineId,
            metadata: encryptedMetadata,
            expectedVersion: currentVersion
        });

        if (result.result === 'success') {
            return {
                version: result.version!,
                metadata: result.metadata!
            };
        } else if (result.result === 'version-mismatch') {
            // Get the latest version and metadata from the response
            currentVersion = result.version!;
            const latestMetadata = await machineEncryption.decryptRaw(result.metadata!) as MachineMetadata;

            // Merge our changes with the latest metadata
            // Preserve the displayName we're trying to set, but use latest values for other fields
            currentMetadata = {
                ...latestMetadata,
                displayName: metadata.displayName // Keep our intended displayName change
            };

            retryCount++;

            // If we've exhausted retries, throw error
            if (retryCount >= maxRetries) {
                throw new Error(`Failed to update after ${maxRetries} retries due to version conflicts`);
            }

            // Otherwise, loop will retry with updated version and merged metadata
        } else {
            throw new Error(result.message || 'Failed to update machine metadata');
        }
    }

    throw new Error('Unexpected error in machineUpdateMetadata');
}

/**
 * Abort the current session operation
 */
const pendingSessionAborts = new Map<string, Promise<void>>();

export function sessionAbort(sessionId: string): Promise<void> {
    const runtime = storage.getState().sessions[sessionId]?.agentState?.codexRuntime;
    const key = JSON.stringify([sessionId, runtime?.epoch, runtime?.threadId, runtime?.turnId, runtime?.startId]);
    const pending = pendingSessionAborts.get(key);
    if (pending) return pending;
    const operation = apiSocket.sessionCommand<void, Record<string, unknown>>(sessionId, 'abort', {
        ...(runtime ? {
            epoch: runtime.epoch,
            threadId: runtime.threadId,
            turnId: runtime.turnId,
            startId: runtime.startId ?? null,
            requestId: `interrupt:${runtime.epoch}:${runtime.turnId ?? runtime.startId}`,
        } : {}),
        reason: `The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). STOP what you are doing and wait for the user to tell you how to proceed.`
    });
    pendingSessionAborts.set(key, operation);
    void operation.finally(() => {
        if (pendingSessionAborts.get(key) === operation) pendingSessionAborts.delete(key);
    }).catch(() => undefined);
    return operation;
}

export type CodexBranchForkResult = {
    branchId: string;
    threadId: string;
    parentId: string;
    label: string;
};

export function sessionForkCodexThread(sessionId: string, request: {
    userOrdinal: number;
    userText: string;
    forkMessageId: string;
    forkMessageCreatedAt: number;
    label?: string;
}): Promise<CodexBranchForkResult> {
    return apiSocket.sessionCommand(sessionId, 'codex-thread-fork', request);
}

export function sessionSwitchCodexBranch(sessionId: string, branchId: string): Promise<{ branchId: string; threadId: string }> {
    return apiSocket.sessionCommand(sessionId, 'codex-thread-switch', { branchId });
}

export function sessionGetCodexThreadStatus(sessionId: string): Promise<{ branchId: string; threadId: string }> {
    return apiSocket.sessionCommand(sessionId, 'codex-thread-status', {});
}

export function sessionReadMcpAppResource(
    sessionId: string,
    request: { server: string; resourceUri: string },
): Promise<{ contents: McpAppResourceContent[] }> {
    return apiSocket.sessionRPC(sessionId, 'codex-mcp-resource-read', request);
}

export function sessionCallMcpAppTool(
    sessionId: string,
    request: {
        server: string;
        resourceUri: string;
        tool: string;
        arguments?: unknown;
        meta?: unknown;
    },
): Promise<McpAppToolCallResponse> {
    return apiSocket.sessionRPC(sessionId, 'codex-mcp-tool-call', request);
}

export function sessionSubmitMcpAppIntent(
    sessionId: string,
    request: {
        server: string;
        resourceUri: string;
        text: string;
        images?: string[];
        skill?: { name: string; path?: string };
    },
): Promise<{ queued: true }> {
    return apiSocket.sessionRPC(sessionId, 'codex-interactive-submit', request);
}

/**
 * Allow a permission request
 */
export async function sessionAllow(sessionId: string, id: string, mode?: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan', allowedTools?: string[], decision?: 'approved' | 'approved_for_session', updatedInput?: Record<string, unknown>): Promise<void> {
    const request: SessionPermissionRequest = { id, approved: true, mode, allowTools: allowedTools, decision, updatedInput };
    const response = await apiSocket.sessionRPC(sessionId, 'permission', request);
    assertPermissionRpcSuccess(response);
}

/**
 * Deny a permission request
 */
export async function sessionDeny(sessionId: string, id: string, mode?: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan', allowedTools?: string[], decision?: 'denied' | 'abort'): Promise<void> {
    const request: SessionPermissionRequest = { id, approved: false, mode, allowTools: allowedTools, decision };
    const response = await apiSocket.sessionRPC(sessionId, 'permission', request);
    assertPermissionRpcSuccess(response);
}

/**
 * Request mode change for a session
 */
export async function sessionSwitch(sessionId: string, to: 'remote' | 'local'): Promise<boolean> {
    const request: SessionModeChangeRequest = { to };
    const response = await apiSocket.sessionRPC<boolean, SessionModeChangeRequest>(
        sessionId,
        'switch',
        request,
    );
    return response;
}

/**
 * Execute a bash command in the session
 */
export async function sessionBash(sessionId: string, request: SessionBashRequest): Promise<SessionBashResponse> {
    try {
        const response = await apiSocket.sessionRPC<SessionBashResponse, SessionBashRequest>(
            sessionId,
            'bash',
            request
        );
        return response;
    } catch (error) {
        return {
            success: false,
            stdout: '',
            stderr: error instanceof Error ? error.message : 'Unknown error',
            exitCode: -1,
            error: error instanceof Error ? error.message : 'Unknown error'
        };
    }
}

export function sessionTerminalStart(
    sessionId: string,
    request: { cwd?: string; cols: number; rows: number },
): Promise<SessionTerminalStartResponse> {
    return apiSocket.sessionRPC(sessionId, 'terminal-start', request);
}

export function sessionTerminalWrite(sessionId: string, terminalId: string, data: string): Promise<{ success: true }> {
    return apiSocket.sessionRPC(sessionId, 'terminal-write', { terminalId, data });
}

export function sessionTerminalResize(
    sessionId: string,
    terminalId: string,
    cols: number,
    rows: number,
): Promise<{ success: true }> {
    return apiSocket.sessionRPC(sessionId, 'terminal-resize', { terminalId, cols, rows });
}

export function sessionTerminalRead(
    sessionId: string,
    terminalId: string,
    cursor: number,
): Promise<SessionTerminalReadResponse> {
    return apiSocket.sessionRPC(sessionId, 'terminal-read', { terminalId, cursor });
}

export function sessionTerminalClose(sessionId: string, terminalId: string): Promise<{ success: true }> {
    return apiSocket.sessionRPC(sessionId, 'terminal-close', { terminalId });
}

export function machineTerminalStart(machineId: string, request: { cwd?: string; cols: number; rows: number }): Promise<SessionTerminalStartResponse> {
    return apiSocket.machineRPC(machineId, 'terminal-start', request);
}
export function machineTerminalWrite(machineId: string, terminalId: string, data: string): Promise<{ success: true }> {
    return apiSocket.machineRPC(machineId, 'terminal-write', { terminalId, data });
}
export function machineTerminalResize(machineId: string, terminalId: string, cols: number, rows: number): Promise<{ success: true }> {
    return apiSocket.machineRPC(machineId, 'terminal-resize', { terminalId, cols, rows });
}
export function machineTerminalRead(machineId: string, terminalId: string, cursor: number): Promise<SessionTerminalReadResponse> {
    return apiSocket.machineRPC(machineId, 'terminal-read', { terminalId, cursor });
}
export function machineTerminalClose(machineId: string, terminalId: string): Promise<{ success: true }> {
    return apiSocket.machineRPC(machineId, 'terminal-close', { terminalId });
}

/**
 * Read a file from the session
 */
export async function sessionReadFile(sessionId: string, path: string, maxBytes?: number): Promise<SessionReadFileResponse> {
    try {
        // 384 KiB is divisible by three, so intermediate base64 chunks can be
        // concatenated without padding in the middle of the resulting data URL.
        const chunkSize = 384 * 1024;
        const chunks: string[] = [];
        let offset = 0;
        let totalSize: number | undefined;

        do {
            const request: SessionReadFileRequest = { path, maxBytes, offset, length: chunkSize };
            const operation = apiSocket.sessionRPC<SessionReadFileResponse, SessionReadFileRequest>(
                sessionId,
                'readFile',
                request
            );
            const response = await Promise.race([
                operation,
                new Promise<SessionReadFileResponse>((resolve) => {
                    const timer = setTimeout(() => resolve({ success: false, error: 'Session file request timed out' }), 5_000);
                    operation.finally(() => clearTimeout(timer)).catch(() => undefined);
                }),
            ]);
            if (!response.success || response.content === undefined) {
                return response;
            }

            // Older CLIs ignore chunk parameters. Their one-shot response has no
            // totalSize field, so return it as-is for backwards compatibility.
            if (response.totalSize === undefined || response.nextOffset === undefined) {
                return response;
            }
            if (response.nextOffset <= offset && response.nextOffset < response.totalSize) {
                return { success: false, error: 'File transfer made no progress' };
            }
            chunks.push(response.content);
            offset = response.nextOffset;
            totalSize = response.totalSize;
        } while (offset < (totalSize ?? 0));

        return { success: true, content: chunks.join(''), totalSize, nextOffset: offset };
    } catch (error) {
        return {
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error'
        };
    }
}

export async function machineReadFile(machineId: string, path: string, maxBytes?: number): Promise<SessionReadFileResponse> {
    try {
        const chunkSize = 384 * 1024;
        const chunks: string[] = [];
        let offset = 0;
        let totalSize: number | undefined;
        do {
            const request: SessionReadFileRequest = { path, maxBytes, offset, length: chunkSize };
            const response = await apiSocket.machineRPC<SessionReadFileResponse, SessionReadFileRequest>(machineId, 'readFile', request);
            if (!response.success || response.content === undefined) return response;
            if (response.totalSize === undefined || response.nextOffset === undefined) return response;
            if (response.nextOffset <= offset && response.nextOffset < response.totalSize) return { success: false, error: 'File transfer made no progress' };
            chunks.push(response.content);
            offset = response.nextOffset;
            totalSize = response.totalSize;
        } while (offset < (totalSize ?? 0));
        return { success: true, content: chunks.join(''), totalSize, nextOffset: offset };
    } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
}

/**
 * Write a file to the session
 */
export async function sessionWriteFile(
    sessionId: string,
    path: string,
    content: string,
    expectedHash?: string | null
): Promise<SessionWriteFileResponse> {
    try {
        const request: SessionWriteFileRequest = { path, content, expectedHash };
        const response = await apiSocket.sessionRPC<SessionWriteFileResponse, SessionWriteFileRequest>(
            sessionId,
            'writeFile',
            request
        );
        return response;
    } catch (error) {
        return {
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error'
        };
    }
}

export function sessionFileDownloadInfo(sessionId: string, path: string): Promise<SessionFileDownloadInfoResponse> {
    return readSessionFile<SessionFileDownloadInfoResponse>(sessionFileReadDependencies, sessionId, 'file-download-info', { path });
}

export function sessionVideoPreview(sessionId: string, path: string) {
    return readVideoPreview({
        read: () => readSessionFile(sessionFileReadDependencies, sessionId, 'getVideoPreview', { path }),
        session: storage.getState().sessions[sessionId],
        online: sessionFileReadDependencies.isMachineOnline,
        machineBash: (machineId, request) => apiSocket.machineRPC(machineId, 'bash', request, 35_000),
    }, path);
}

export function sessionFileDownloadChunk(
    sessionId: string,
    path: string,
    offset: number,
    length: number,
    expectedModified?: number,
): Promise<SessionFileDownloadChunkResponse> {
    return readSessionFile<SessionFileDownloadChunkResponse>(sessionFileReadDependencies, sessionId, 'file-download-chunk', { path, offset, length, expectedModified });
}

const sessionFileReadDependencies = {
    getSession: (id: string) => storage.getState().sessions[id],
    isMachineOnline: (id: string) => storage.getState().machines[id]?.active === true,
    sessionRPC: <R, A>(id: string, method: string, params: A, timeoutMs: number) => apiSocket.sessionRPC<R, A>(id, method, params, timeoutMs),
    machineRPC: <R, A>(id: string, method: string, params: A, timeoutMs: number) => apiSocket.machineRPC<R, A>(id, method, params, timeoutMs),
};

export function sessionFileUploadBegin(
    sessionId: string,
    path: string,
    size: number,
    overwrite: boolean,
    sha256?: string,
): Promise<SessionFileUploadBeginResponse> {
    return apiSocket.sessionRPC(sessionId, 'file-upload-begin', { path, size, overwrite, sha256 });
}

export function sessionFileUploadStatus(sessionId: string, uploadId: string): Promise<
    { success: true; received: number; size: number; sha256?: string; complete: boolean } | { success: false; error: string }
> {
    return apiSocket.sessionRPC(sessionId, 'file-upload-status', { uploadId });
}

export function sessionFileUploadChunk(
    sessionId: string,
    uploadId: string,
    offset: number,
    content: string,
): Promise<SessionFileUploadChunkResponse> {
    return apiSocket.sessionRPC(sessionId, 'file-upload-chunk', { uploadId, offset, content });
}

export function sessionFileUploadFinish(sessionId: string, uploadId: string): Promise<SessionFileUploadFinishResponse> {
    return apiSocket.sessionRPC(sessionId, 'file-upload-finish', { uploadId });
}

export function sessionFileUploadAbort(sessionId: string, uploadId: string): Promise<{ success: true }> {
    return apiSocket.sessionRPC(sessionId, 'file-upload-abort', { uploadId });
}

export function machineFileDownloadInfo(machineId: string, path: string): Promise<SessionFileDownloadInfoResponse> {
    return apiSocket.machineRPC(machineId, 'file-download-info', { path });
}
export function machineFileDownloadChunk(machineId: string, path: string, offset: number, length: number, expectedModified?: number): Promise<SessionFileDownloadChunkResponse> {
    return apiSocket.machineRPC(machineId, 'file-download-chunk', { path, offset, length, expectedModified });
}
export function machineFileUploadBegin(machineId: string, path: string, size: number, overwrite: boolean): Promise<SessionFileUploadBeginResponse> {
    return apiSocket.machineRPC(machineId, 'file-upload-begin', { path, size, overwrite });
}
export function machineFileUploadChunk(machineId: string, uploadId: string, offset: number, content: string): Promise<SessionFileUploadChunkResponse> {
    return apiSocket.machineRPC(machineId, 'file-upload-chunk', { uploadId, offset, content });
}
export function machineFileUploadFinish(machineId: string, uploadId: string): Promise<SessionFileUploadFinishResponse> {
    return apiSocket.machineRPC(machineId, 'file-upload-finish', { uploadId });
}
export function machineFileUploadAbort(machineId: string, uploadId: string): Promise<{ success: true }> {
    return apiSocket.machineRPC(machineId, 'file-upload-abort', { uploadId });
}

/**
 * List directory contents in the session
 */
export async function sessionListDirectory(sessionId: string, path: string): Promise<SessionListDirectoryResponse> {
    try {
        const request: SessionListDirectoryRequest = { path };
        const response = await apiSocket.sessionRPC<SessionListDirectoryResponse, SessionListDirectoryRequest>(
            sessionId,
            'listDirectory',
            request
        );
        return response;
    } catch (error) {
        return {
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error'
        };
    }
}

export async function machineListDirectory(machineId: string, path: string): Promise<SessionListDirectoryResponse> {
    try {
        return await apiSocket.machineRPC<SessionListDirectoryResponse, SessionListDirectoryRequest>(machineId, 'listDirectory', { path });
    } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
}

/**
 * Get directory tree from the session
 */
export async function sessionGetDirectoryTree(
    sessionId: string,
    path: string,
    maxDepth: number
): Promise<SessionGetDirectoryTreeResponse> {
    try {
        const request: SessionGetDirectoryTreeRequest = { path, maxDepth };
        const response = await apiSocket.sessionRPC<SessionGetDirectoryTreeResponse, SessionGetDirectoryTreeRequest>(
            sessionId,
            'getDirectoryTree',
            request
        );
        return response;
    } catch (error) {
        return {
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error'
        };
    }
}

/**
 * Run ripgrep in the session
 */
export async function sessionRipgrep(
    sessionId: string,
    args: string[],
    cwd?: string
): Promise<SessionRipgrepResponse> {
    try {
        const request: SessionRipgrepRequest = { args, cwd };
        const response = await apiSocket.sessionRPC<SessionRipgrepResponse, SessionRipgrepRequest>(
            sessionId,
            'ripgrep',
            request
        );
        return response;
    } catch (error) {
        return {
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error'
        };
    }
}

/**
 * Kill the session process immediately
 */
export async function sessionKill(sessionId: string): Promise<SessionKillResponse> {
    try {
        const response = await apiSocket.sessionRPC<SessionKillResponse, {}>(
            sessionId,
            'killSession',
            {}
        );
        return response;
    } catch (error) {
        return {
            success: false,
            message: error instanceof Error ? error.message : 'Unknown error'
        };
    }
}

/**
 * Archive a session by deactivating it on the server.
 * Use this when the CLI process is already dead and sessionKill can't reach it.
 */
export async function sessionArchive(sessionId: string): Promise<{ success: boolean; message?: string }> {
    try {
        const response = await apiSocket.request(`/v1/sessions/${sessionId}/archive`, {
            method: 'POST'
        });
        if (!response.ok) {
            return { success: false, message: `Server error: ${response.status}` };
        }
        return { success: true };
    } catch (error) {
        return { success: false, message: error instanceof Error ? error.message : 'Unknown error' };
    }
}

/**
 * Permanently delete a session from the server
 * This will remove the session and all its associated data (messages, usage reports, access keys)
 * The session should be inactive/archived before deletion
 */
export async function sessionDelete(sessionId: string): Promise<{ success: boolean; message?: string }> {
    return sessionDeleteMany([sessionId]);
}

export async function sessionDeleteMany(sessionIds: string[]): Promise<{ success: boolean; deletedCount?: number; message?: string }> {
    try {
        const response = await apiSocket.request('/v1/sessions/delete', {
            method: 'POST',
            body: JSON.stringify({ sessionIds }),
            headers: {
                'Content-Type': 'application/json'
            }
        });
        
        if (response.ok) {
            const result = await response.json() as { deletedCount?: number };
            return { success: true, deletedCount: result.deletedCount };
        } else {
            const error = await response.text();
            return {
                success: false,
                message: error || 'Failed to delete session'
            };
        }
    } catch (error) {
        return {
            success: false,
            message: error instanceof Error ? error.message : 'Unknown error'
        };
    }
}

export async function conversationDelete(conversationId: string): Promise<{ success: boolean; deletedCount?: number; message?: string }> {
    try {
        const response = await apiSocket.request(`/v1/conversations/${encodeURIComponent(conversationId)}`, {
            method: 'DELETE',
        });
        if (response.ok) {
            const result = await response.json() as { deletedCount?: number };
            return { success: true, deletedCount: result.deletedCount };
        }
        return { success: false, message: await response.text() || 'Failed to delete conversation' };
    } catch (error) {
        return {
            success: false,
            message: error instanceof Error ? error.message : 'Unknown error',
        };
    }
}

// Export types for external use
export type {
    SessionBashRequest,
    SessionBashResponse,
    SessionReadFileResponse,
    SessionWriteFileResponse,
    SessionListDirectoryResponse,
    DirectoryEntry,
    SessionGetDirectoryTreeResponse,
    TreeNode,
    SessionRipgrepResponse,
    SessionKillResponse
};
