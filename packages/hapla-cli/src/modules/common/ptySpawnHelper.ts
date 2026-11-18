import { chmodSync, existsSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** Some npm/tar installers strip the executable bit from node-pty's Darwin
 * helper. Repair only that packaged executable, before trying to spawn. */
export function ensurePtySpawnHelper(packageFile: string, platform = process.platform, arch = process.arch): void {
    if (platform !== 'darwin') return;
    const root = dirname(packageFile);
    for (const directory of ['build/Release', 'build/Debug', `prebuilds/${platform}-${arch}`]) {
        const helper = join(root, directory, 'spawn-helper');
        if (!existsSync(helper)) continue;
        const mode = statSync(helper).mode;
        if ((mode & 0o100) === 0) {
            try { chmodSync(helper, mode | 0o100); }
            catch { throw new Error(`终端启动程序缺少执行权限，请修复 ${helper} 的执行权限`); }
        }
    }
}
