import { apiSocket } from './apiSocket';
import type { GitWorkbenchRequest, GitWorkbenchResponse } from '@hapla/wire';

const isGitHandlerMissing = (error: unknown) => /^(RPC method not available|Method not found)$/i.test(error instanceof Error ? error.message : String(error));
export async function gitWorkbenchRpc(sessionId: string, machineId: string | undefined, active: boolean, request: GitWorkbenchRequest) {
    const timeout = ['status', 'log', 'checkpoints'].includes(request.operation) ? 20_000 : request.operation === 'diff' ? 45_000 : 150_000;
    const machine = async () => {
        if (!machineId) throw new Error('Workspace is unavailable.');
        const result = await apiSocket.machineRPC<GitWorkbenchResponse & { error?: string }, GitWorkbenchRequest>(machineId, 'git-workbench', { ...request, sessionId: request.sessionId ?? sessionId }, timeout);
        if (result?.error) throw new Error(result.error);
        return result;
    };
    let value: GitWorkbenchResponse;
    if (active) {
        try { value = await apiSocket.sessionCommand<GitWorkbenchResponse, GitWorkbenchRequest>(sessionId, 'git-workbench', request, timeout); }
        catch (error) {
            // A preserved agent process can predate its upgraded daemon. Only
            // an explicit missing-handler response proves no action executed.
            if (!machineId || !isGitHandlerMissing(error)) throw error;
            value = await machine();
        }
    } else value = await machine();
    if (value && 'error' in value) throw new Error(String(value.error));
    const field = { status: 'files', log: 'commits', checkpoints: 'checkpoints', diff: 'text' }[request.operation as 'status' | 'log' | 'checkpoints' | 'diff'];
    if (!value || (field && !(field in value))) throw new Error('Invalid Git response.');
    return value;
}
