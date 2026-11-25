import { hostname } from 'node:os';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, writeFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { alive, gitDirectory, within } from './gitProcess';

export async function claimWorkspace(directory: string, sessionId: string) {
    const root = await realpath(directory);
    const leases = join(await gitDirectory(root), 'hapla', 'leases');
    await mkdir(leases, { recursive: true });
    const file = join(leases, createHash('sha256').update(sessionId).digest('hex') + '.json');
    const temporary = file + '.' + process.pid;
    await writeFile(temporary, JSON.stringify({ sessionId, pid: process.pid, host: hostname(), path: root })); await rename(temporary, file);
    return () => rm(file, { force: true });
}
export async function assertWorkspaceExclusive(root: string, sessionId?: string) {
    const directory = join(await gitDirectory(root), 'hapla', 'leases');
    for (const name of await readdir(directory).catch(() => [] as string[])) {
        const file = join(directory, name);
        const lease = await readFile(file, 'utf8').then(JSON.parse).catch(() => null);
        if (!lease) throw new Error('Workspace ownership is unreadable; retry before restoring or removing it.');
        if (lease.host !== hostname()) throw new Error('Workspace is claimed by another worker host. Resolve that claim on its owning worker before restoring or removing it.');
        if (!alive(lease.pid)) { await rm(file, { force: true }); continue; }
        if (lease.sessionId !== sessionId && (within(root, lease.path) || within(lease.path, root))) {
            throw new Error('Another session uses this workspace. Sleep that session before restoring or removing it.');
        }
    }
}
