import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, open, readFile, unlink, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
const execute = promisify(execFile);
export async function command(cwd: string, executable: string, args: string[], env: NodeJS.ProcessEnv = {}) {
    try {
        const result = await execute(executable, args, { cwd, encoding: 'utf8', timeout: 120_000, maxBuffer: 64 * 1024 * 1024,
            windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GH_PROMPT_DISABLED: '1', ...env } });
        return result.stdout;
    } catch (error: any) {
        throw new Error(`${executable} failed: ${String(error.stderr || error.message).trim().slice(0, 4000)}`);
    }
}
export const git = (cwd: string, args: string[], env?: NodeJS.ProcessEnv) => command(cwd, 'git', ['--no-pager', '-c', 'core.quotePath=false', ...args], { GIT_DIR: undefined, GIT_WORK_TREE: undefined, GIT_COMMON_DIR: undefined, GIT_INDEX_FILE: undefined, ...env });
export const within = (parent: string, child: string) => { const r = relative(parent, child); return r === '' || (!r.startsWith('..' + '/') && r !== '..' && !isAbsolute(r)); };
export async function workspaceDirectory(base: string, requested = base) {
    const parent = await realpath(base); const child = await realpath(resolve(base, requested));
    if (!within(parent, child)) throw new Error('Workspace is outside the configured root.');
    return child;
}
export async function repository(cwd: string) { return (await git(cwd, ['rev-parse', '--show-toplevel'])).trim(); }
export async function gitDirectory(cwd: string) { return resolve(cwd, (await git(cwd, ['rev-parse', '--git-common-dir'])).trim()); }
export async function serialized<T>(root: string, operation: () => Promise<T>): Promise<T> {
    const file = resolve(await gitDirectory(root), 'hapla', 'operation.lock');
    await mkdir(dirname(file), { recursive: true });
    let lock;
    for (let attempt = 0; attempt < 2; attempt++) {
        try { lock = await open(file, 'wx'); await lock.writeFile(JSON.stringify({ pid: process.pid })); break; }
        catch (error: any) {
            if (error.code !== 'EEXIST') throw error;
            const owner = await readFile(file, 'utf8').then(JSON.parse).catch(() => null);
            if (!owner?.pid || alive(owner.pid)) throw new Error('Another Git operation is running. Retry after it finishes.');
            await unlink(file).catch(() => undefined);
        }
    }
    if (!lock) throw new Error('Could not acquire the repository lock.');
    try { return await operation(); } finally { await lock.close(); await unlink(file).catch(() => undefined); }
}
export function alive(pid: number) { try { process.kill(pid, 0); return true; } catch (e: any) { return e.code === 'EPERM'; } }
