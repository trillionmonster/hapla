/** Worktree mutations run as validated, serialized operations on the owning worker. */
import { worktreeRpc } from '@/sync/worktreeRpc';
export const WORKTREE_DIR = '.dev/worktree';
export const WORKTREE_PATH_MARKER = `/${WORKTREE_DIR}/`;
export interface WorktreeInfo { path: string; branch: string }
export async function createWorktree(machineId: string, basePath: string) {
    try {
        const result = await worktreeRpc(machineId, { operation: 'create', directory: basePath });
        return { success: true, worktreePath: result.path!, branchName: result.branch!, head: result.head };
    } catch (error) { return { success: false, worktreePath: '', branchName: '', error: error instanceof Error ? error.message : String(error) }; }
}
export async function listWorktrees(machineId: string, basePath: string): Promise<WorktreeInfo[]> {
    try { return (await worktreeRpc(machineId, { operation: 'list', directory: basePath })).worktrees ?? []; }
    catch (error) { if (/not a git repository|outside the configured root/i.test(String(error))) return []; throw error; }
}
export async function removeWorktree(machineId: string, worktreePath: string, expectedHead?: string) {
    try {
        await worktreeRpc(machineId, { operation: 'remove', directory: getRepoPath(worktreePath), path: worktreePath, expectedHead });
        return { success: true };
    } catch (error) { return { success: false, error: error instanceof Error ? error.message : String(error) }; }
}
export const isWorktreePath = (path: string) => path.includes(WORKTREE_PATH_MARKER);
export function getRepoPath(path: string) { const at = path.indexOf(WORKTREE_PATH_MARKER); return at < 0 ? path : path.slice(0, at); }
export function getWorktreeName(path: string) { const at = path.indexOf(WORKTREE_PATH_MARKER); return at < 0 ? null : path.slice(at + WORKTREE_PATH_MARKER.length); }
