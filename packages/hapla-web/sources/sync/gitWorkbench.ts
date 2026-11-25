import { apiSocket } from './apiSocket';
import type { GitWorkbenchRequest, GitWorkbenchResponse, WorktreeRequest, WorktreeResponse } from '@hapla/wire';
export async function gitWorkbenchRpc(sessionId: string, machineId: string | undefined, active: boolean, request: GitWorkbenchRequest) {
    const value = active
        ? await apiSocket.sessionCommand<GitWorkbenchResponse, GitWorkbenchRequest>(sessionId, 'git-workbench', request, 150_000)
        : await apiSocket.machineRPC<GitWorkbenchResponse, GitWorkbenchRequest>(machineId!, 'git-workbench', { ...request, sessionId: request.sessionId ?? sessionId }, 150_000);
    if (value && 'error' in value) throw new Error(String(value.error));
    return value;
}
export async function worktreeRpc(machineId: string, request: WorktreeRequest) {
    const value = await apiSocket.machineRPC<WorktreeResponse & { error?: string }, WorktreeRequest>(machineId, 'git-worktree', request, 150_000);
    if (value.error) throw new Error(value.error); return value;
}
