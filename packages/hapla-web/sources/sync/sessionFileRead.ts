import { resolveSessionFilePath } from '@/utils/sessionFileLinks';

type FileReadMethod = 'file-download-info' | 'file-download-chunk' | 'getVideoPreview';
type FileRequest = { path: string; offset?: number; length?: number; expectedModified?: number };
type FileSession = { active: boolean; metadata: { path: string; machineId?: string; lifecycleState?: string } | null };
type ReadTransport = (id: string, method: string, params: FileRequest, timeoutMs: number) => Promise<unknown>;
type FileReadDependencies = {
    getSession: (id: string) => FileSession | undefined;
    isMachineOnline: (id: string) => boolean;
    sessionRPC: ReadTransport;
    machineRPC: ReadTransport;
};

const FILE_READ_TIMEOUT_MS = 15_000;
const unavailable = (error: unknown) => error instanceof Error
    && /RPC method not available|RPC target disconnected|timed out|timeout|Session encryption not found/i.test(error.message);

/** Read historical files through their owning machine when the session process is gone. */
export async function readSessionFile<R extends { success: boolean; error?: string }>(
    dependencies: FileReadDependencies,
    sessionId: string,
    method: FileReadMethod,
    request: FileRequest,
): Promise<R> {
    const session = dependencies.getSession(sessionId);
    const timeout = method === 'getVideoPreview' ? 30_000 : FILE_READ_TIMEOUT_MS;
    const root = session?.metadata?.path;
    if (!session || !root) throw new Error('会话工作区信息尚未加载，请重试');
    const resolved = resolveSessionFilePath(request.path, root);
    if (!resolved?.withinSessionRoot) throw new Error('文件不在当前会话工作区内');
    const params = { ...request, path: resolved.absolutePath };
    const machineId = session.metadata?.machineId;
    const canReadFromMachine = () => Boolean(machineId && dependencies.isMachineOnline(machineId));
    const checkResponse = (response: unknown): R => {
        if (response && typeof response === 'object' && 'success' in response && typeof response.success === 'boolean') return response as R;
        if (response && typeof response === 'object' && 'error' in response && typeof response.error === 'string') throw new Error(response.error);
        throw new Error('文件读取返回了无效响应，请重试');
    };
    const readFromMachine = async (): Promise<R> => {
        if (!machineId) throw new Error('找不到此会话所属的工作台，请重新连接后重试');
        if (!canReadFromMachine()) throw new Error('此会话所属的工作台未连接，连接后可重试读取文件');
        return checkResponse(await dependencies.machineRPC(machineId, method, { ...params, sessionId, workspaceRoot: root } as FileRequest, timeout));
    };
    if (!session.active || session.metadata?.lifecycleState === 'sleeping') return readFromMachine();
    try {
        const result = checkResponse(await dependencies.sessionRPC(sessionId, method, params, timeout));
        if (method === 'file-download-info' && !result.success && /transfer limit/.test(result.error ?? '') && canReadFromMachine()) return readFromMachine();
        return result;
    } catch (error) {
        // Retrying this read is safe; writes, approvals and model operations do
        // not use this fallback. Never pick a different user's/host's machine.
        if (unavailable(error) && canReadFromMachine()) return readFromMachine();
        throw error;
    }
}
