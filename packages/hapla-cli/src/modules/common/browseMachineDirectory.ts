import { access, lstat, readdir, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import type { MachineDirectoryEntry, MachineDirectoryRequest, MachineDirectoryResponse } from '@hapla/wire';

const PAGE_SIZE = 200;

/** Machine-only RPC: like spawning a session, navigation follows the OS user's permissions.
 * Session file-read/write RPCs retain their independent workspace sandbox. */
export async function browseMachineDirectory(request: MachineDirectoryRequest): Promise<MachineDirectoryResponse> {
    if (!request || typeof request.path !== 'string' || !request.path.trim() || request.path.includes('\0') ||
        request.path.length > 32768 || (request.mode !== undefined && !['list', 'check'].includes(request.mode)) ||
        (request.offset !== undefined && (!Number.isSafeInteger(request.offset) || request.offset < 0))) {
        return { success: false, code: 'invalid_path', error: '请输入有效的目录路径。' };
    }
    const homePath = homedir();
    const input = request.path.trim();
    if (input.startsWith('~') && input !== '~' && !input.startsWith(`~${sep}`) && !input.startsWith('~/')) {
        return { success: false, code: 'invalid_path', error: '请使用绝对路径，或用 ~/ 表示当前用户的主目录。' };
    }
    const path = input === '~' ? homePath : resolve(homePath, input.startsWith('~/') || input.startsWith(`~${sep}`) ? input.slice(2) : input);
    const parentPath = dirname(path) === path ? null : dirname(path);
    const result = { success: true as const, path, parentPath, homePath, entries: [] as MachineDirectoryEntry[], total: 0, nextOffset: null as number | null };
    try {
        let info;
        try {
            info = await stat(path);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
            // A dangling link is an existing non-directory, not a new project path.
            const existing = await lstat(path).catch((cause: NodeJS.ErrnoException) => {
                if (cause.code !== 'ENOENT') throw cause;
                return null;
            });
            if (existing) return { success: false, code: 'not_directory', error: '此路径不是可用的文件夹，请选择其他目录。' };
            // Check ancestors too: /existing-file/child must never offer directory creation.
            let ancestor = dirname(path);
            while (true) {
                try {
                    if (!(await stat(ancestor)).isDirectory()) {
                        return { success: false, code: 'not_directory', error: '父路径包含文件，无法在这里选择或创建目录。' };
                    }
                    break;
                } catch (cause) {
                    if ((cause as NodeJS.ErrnoException).code !== 'ENOENT' || dirname(ancestor) === ancestor) throw cause;
                    if (await lstat(ancestor).catch((e: NodeJS.ErrnoException) => { if (e.code !== 'ENOENT') throw e; return null; })) {
                        return { success: false, code: 'not_directory', error: '父路径包含不可用的链接，请选择其他目录。' };
                    }
                    ancestor = dirname(ancestor);
                }
            }
            return { ...result, kind: 'missing' };
        }
        if (!info.isDirectory()) return { success: false, code: 'not_directory', error: '此路径是文件，不是文件夹，请选择目录。' };
        await access(path, constants.X_OK);
        if (request.mode === 'check') return { ...result, kind: 'directory' };
        const items = (await readdir(path, { withFileTypes: true })).filter(item => request.showHidden || !item.name.startsWith('.'));
        const entries: MachineDirectoryEntry[] = [];
        // Only links need stat; bound concurrent filesystem work on network mounts.
        for (let start = 0; start < items.length; start += 32) {
            entries.push(...await Promise.all(items.slice(start, start + 32).map(async item => {
                const itemPath = join(path, item.name);
                const target = item.isSymbolicLink() ? await stat(itemPath).catch(() => null) : item;
                return { name: item.name, path: itemPath, type: target?.isDirectory() ? 'directory' as const : target?.isFile() ? 'file' as const : 'other' as const, symlink: item.isSymbolicLink() };
            })));
        }
        entries.sort((a, b) => Number(b.type === 'directory') - Number(a.type === 'directory') || a.name.localeCompare(b.name));
        const offset = request.offset ?? 0;
        return { ...result, kind: 'directory', entries: entries.slice(offset, offset + PAGE_SIZE), total: entries.length,
            nextOffset: offset + PAGE_SIZE < entries.length ? offset + PAGE_SIZE : null };
    } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ENOTDIR') return { success: false, code: 'not_directory', error: '路径中包含文件，请选择文件夹。' };
        if (code === 'EACCES' || code === 'EPERM') return { success: false, code: 'permission_denied', error: '当前机器用户没有访问此目录的权限。' };
        return { success: false, code: 'unavailable', error: `无法读取目录，请检查路径后重试${code ? `（${code}）` : ''}。` };
    }
}
