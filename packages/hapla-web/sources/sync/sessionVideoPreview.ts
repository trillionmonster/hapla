import { resolveSessionFilePath } from '@/utils/sessionFileLinks';

type Dependencies = {
    read: () => Promise<unknown>;
    session: { metadata: { path: string; machineId?: string } | null } | undefined;
    online: (machineId: string) => boolean;
    machineBash: (machineId: string, request: { command: string; cwd: string; timeout: number }) => Promise<{ success: boolean; stdout: string; error?: string }>;
};
const quote = (value: string) => `'${value.replace(/'/g, `'"'"'`)}'`;

/** Old, busy CLIs can use the separately installed read-only helper without a
 * daemon/container restart. Never fall back to a different machine or account. */
export async function readVideoPreview(deps: Dependencies, requestedPath: string): Promise<unknown> {
    const root = deps.session?.metadata?.path;
    const machineId = deps.session?.metadata?.machineId;
    if (root && machineId && deps.online(machineId)) {
        const resolved = resolveSessionFilePath(requestedPath, root);
        if (!resolved?.withinSessionRoot) throw new Error('文件不在当前会话工作区内');
        // Old daemons wait for a missing method to register before rejecting
        // RPC. Use the installed helper first instead of spending that timeout
        // on every card while a busy worker safely keeps its current runtime.
        const result = await deps.machineBash(machineId, {
            command: `hapla-video-preview --root ${quote(root)} --path ${quote(resolved.absolutePath)}`,
            cwd: root, timeout: 30_000,
        });
        if (!result.success) return deps.read();
        if (!result.stdout || result.stdout.length > 200_000) throw new Error('视频信息暂不可用，请检查所属工作台');
        try { return JSON.parse(result.stdout); }
        catch { throw new Error('视频信息返回格式无效'); }
    }
    return deps.read();
}
