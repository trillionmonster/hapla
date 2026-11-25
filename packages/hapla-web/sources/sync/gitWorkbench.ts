import type { GitWorkbenchRequest } from '@hapla/wire';

export async function gitWorkbenchRpc(sessionId: string, machineId: string | undefined, active: boolean, request: GitWorkbenchRequest) {
    return (await import('./gitWorkbenchTransport')).gitWorkbenchRpc(sessionId, machineId, active, request);
}
