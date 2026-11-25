import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { gitWorkbenchRequestSchema, worktreeRequestSchema } from '@hapla/wire/gitWorkbench';
import { GitWorkbench } from './workbench';
import { workspaceDirectory } from './gitProcess';
import { worktreeOperation } from './worktrees';

export function registerGitHandlers(manager: RpcHandlerManager, root: string, sessionId?: string) {
    manager.registerHandler('git-workbench', async input => {
        const data = gitWorkbenchRequestSchema.parse(input);
        return new GitWorkbench(await workspaceDirectory(root, data.directory), sessionId ?? data.sessionId).execute(data);
    });
    manager.registerHandler('git-worktree', async input => {
        const data = worktreeRequestSchema.parse(input);
        const directory = await workspaceDirectory(root, data.directory);
        if (data.path) await workspaceDirectory(root, data.path);
        return worktreeOperation({ ...data, directory }, root);
    });
}
