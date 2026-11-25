import { apiSocket } from './apiSocket';
import type { WorktreeRequest, WorktreeResponse } from '@hapla/wire';

export async function worktreeRpc(machineId: string, request: WorktreeRequest) {
    const value = await apiSocket.machineRPC<WorktreeResponse & { error?: string }, WorktreeRequest>(machineId, 'git-worktree', request, 150_000);
    if (value.error) throw new Error(value.error);
    return value;
}
