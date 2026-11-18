import { homedir } from 'node:os';
import { realpath, readFile } from 'node:fs/promises';
import { delimiter, resolve, sep, join, isAbsolute } from 'node:path';
import { configuration } from '@/configuration';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { CloudFileManager } from './CloudFileManager';
import { WorkspaceVideoPreviewManager } from './workspaceVideoPreview';

type CloudRequest = { path: string; size: number; modified: number; consumerId: string; jobId?: string; sessionId?: string; workspaceRoot?: string; offset?: number; length?: number; expectedModified?: number };

export function registerCloudFileHandlers(rpc: RpcHandlerManager, root: string, token: string, resolveSessionRoot?: (sessionId: string) => string | undefined) {
    const managers = new Map<string, CloudFileManager>();
    const jobs = new Map<string, CloudFileManager>();
    const previews = new Map<string, WorkspaceVideoPreviewManager>();
    const getManager = async (request: CloudRequest) => {
        for (const [id, manager] of jobs) if (!manager.has(id)) jobs.delete(id);
        let directory = root;
        if (resolveSessionRoot && request.sessionId) {
            const registered = resolveSessionRoot(request.sessionId);
            if (registered) directory = registered;
            else if (request.workspaceRoot) {
                // Operator-configured roots cover historical projects whose
                // worker no longer exists. A browser cannot add new roots.
                const selected = await realpath(resolve(request.workspaceRoot));
                let configured: string[] = [];
                try {
                    const value = JSON.parse(await readFile(join(configuration.haplaHomeDir, 'file-roots.json'), 'utf8'));
                    if (Array.isArray(value) && value.length <= 32 && value.every(path => typeof path === 'string' && isAbsolute(path))) configured = value;
                } catch { /* Optional operator-owned roots, never supplied by a browser. */ }
                const allowed = [homedir(), ...configured, ...(process.env.HAPLA_FILE_ROOTS || '').split(delimiter).filter(Boolean)];
                const roots = await Promise.all(allowed.map(path => realpath(path).catch(() => null)));
                if (!roots.some(path => path && (selected === path || selected.startsWith(path + sep)))) throw new Error('此工作区不在工作台已授权的文件目录内');
                directory = selected;
            }
        }
        let manager = managers.get(directory);
        if (!manager) {
            if (managers.size >= 64) throw new Error('工作区文件服务繁忙，请重试');
            manager = new CloudFileManager(directory, { token, serverUrl: configuration.serverUrl }); managers.set(directory, manager);
        }
        return { directory, manager };
    };
    if (resolveSessionRoot) {
        rpc.registerHandler('file-download-info', async (request: CloudRequest) => (await getManager(request)).manager.downloadInfo(request.path));
        rpc.registerHandler('file-download-chunk', async (request: CloudRequest) => (await getManager(request)).manager.downloadChunk(request.path, request.offset ?? -1, request.length ?? -1, request.expectedModified));
        rpc.registerHandler('getVideoPreview', async (request: CloudRequest) => {
            const { directory } = await getManager(request);
            if (!previews.has(directory)) previews.set(directory, new WorkspaceVideoPreviewManager(directory));
            return previews.get(directory)!.getPreview(request.path);
        });
    }
    rpc.registerHandler('file-cloud-prepare', async (request: CloudRequest) => {
        const { manager } = await getManager(request);
        const result = await manager.prepare(request);
        if (result.jobId) jobs.set(result.jobId, manager);
        return result;
    });
    rpc.registerHandler('file-cloud-status', async (request: CloudRequest) => jobs.get(request.jobId ?? '')?.status(request.jobId!, request.consumerId) ?? { success: false, error: '文件准备任务不存在，请重试' });
    rpc.registerHandler('file-cloud-release', async (request: CloudRequest) => jobs.get(request.jobId ?? '')?.release(request.jobId!, request.consumerId) ?? { success: true });
    // Separate names make an older CLI fail explicitly instead of silently
    // uploading to R2 when the browser requested local delivery.
    rpc.registerHandler('file-direct-prepare', async (request: CloudRequest) => {
        const { manager } = await getManager(request);
        const result = await manager.prepare({ ...request, delivery: 'direct' });
        if (result.jobId) jobs.set(result.jobId, manager);
        return result;
    });
    rpc.registerHandler('file-direct-status', async (request: CloudRequest) => jobs.get(request.jobId ?? '')?.status(request.jobId!, request.consumerId) ?? { success: false, error: '本地文件任务不存在，请重试' });
    rpc.registerHandler('file-direct-release', async (request: CloudRequest) => jobs.get(request.jobId ?? '')?.release(request.jobId!, request.consumerId) ?? { success: true });
}
