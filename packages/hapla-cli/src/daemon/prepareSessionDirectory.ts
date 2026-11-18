import { mkdir } from 'node:fs/promises';
import { browseMachineDirectory } from '../modules/common/browseMachineDirectory';

export async function prepareSessionDirectory(directory: string, approved: boolean): Promise<
    { type: 'ready'; directory: string; created: boolean } |
    { type: 'requestToApproveDirectoryCreation'; directory: string } |
    { type: 'error'; errorMessage: string }
> {
    const checked = await browseMachineDirectory({ path: directory, mode: 'check' });
    if (!checked.success) return { type: 'error', errorMessage: checked.error };
    if (checked.kind === 'directory') return { type: 'ready', directory: checked.path, created: false };
    if (!approved) return { type: 'requestToApproveDirectoryCreation', directory: checked.path };
    try {
        await mkdir(checked.path, { recursive: true });
        const created = await browseMachineDirectory({ path: checked.path, mode: 'check' });
        if (!created.success || created.kind !== 'directory') return { type: 'error', errorMessage: '目录创建后无法访问，请选择其他目录。' };
        return { type: 'ready', directory: checked.path, created: true };
    } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        const reason = code === 'EACCES' || code === 'EPERM' ? '没有写入权限' :
            code === 'ENOTDIR' || code === 'EEXIST' ? '路径中已存在文件' :
            code === 'ENOSPC' ? '磁盘空间不足' : code === 'EROFS' ? '文件系统只读' : code ?? '未知错误';
        return { type: 'error', errorMessage: `无法创建目录：${reason}。请检查路径或选择其他目录。` };
    }
}
