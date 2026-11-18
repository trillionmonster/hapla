import { apiSocket } from '@/sync/apiSocket';
import type { MachineDirectoryRequest, MachineDirectoryResponse } from '@hapla/wire';

export async function browseMachineDirectory(machineId: string, request: MachineDirectoryRequest): Promise<MachineDirectoryResponse> {
    try {
        const result = await apiSocket.machineRPC<MachineDirectoryResponse, MachineDirectoryRequest>(machineId, 'browse-directory', request, 20_000);
        if (result?.success === true && ['directory', 'missing'].includes(result.kind) &&
            typeof result.path === 'string' && typeof result.homePath === 'string' && Array.isArray(result.entries)) return result;
        if (result?.success === false && typeof result.error === 'string') return result;
        throw new Error((result as { error?: string })?.error || '目录响应无效');
    } catch (error) {
        const message = error instanceof Error ? error.message : '';
        return { success: false, code: 'unavailable', error: /method not available|method not found/i.test(message)
            ? '此机器的 CLI 尚未支持目录浏览，请更新 CLI 后重试。'
            : '无法连接这台机器，请确认机器在线后重试。' };
    }
}
