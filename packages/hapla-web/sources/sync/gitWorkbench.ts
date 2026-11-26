import type { GitWorkbenchRequest, GitWorkbenchResponse } from '@hapla/wire';

export type GitWorkbenchResult = GitWorkbenchResponse & { requiresSessionUpgrade?: boolean };

export async function gitWorkbenchRpc(sessionId: string, machineId: string | undefined, active: boolean, request: GitWorkbenchRequest) {
    return (await import('./gitWorkbenchTransport')).gitWorkbenchRpc(sessionId, machineId, active, request);
}
