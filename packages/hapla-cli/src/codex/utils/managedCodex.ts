import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

export interface ManagedCodexInstallation { version: 1; source: string; release: string; cliVersion: string }

export function codexToolsDirectory(env: NodeJS.ProcessEnv = process.env): string {
    const home = env.HAPLA_HOME_DIR?.trim();
    const base = home ? resolve(home.replace(/^~/, homedir())) : join(homedir(), '.hapla');
    return join(base, 'tools', 'codex');
}

export function managedCodexExecutable(source: string, directory = codexToolsDirectory()): string | null {
    const pointer = join(directory, 'current.json');
    if (!existsSync(pointer)) return null;
    const config = JSON.parse(readFileSync(pointer, 'utf8')) as ManagedCodexInstallation;
    if (config.source !== source) return null;
    if (config.version !== 1 || typeof config.release !== 'string' || !/^[a-zA-Z0-9.-]+$/.test(config.release)) {
        throw new Error('托管 Codex 配置无效，请在机器页面重新更新。');
    }
    const releases = realpathSync(join(directory, 'releases'));
    const path = realpathSync(join(releases, config.release, 'node_modules', '@openai', 'codex', 'bin', 'codex.js'));
    const difference = relative(releases, path);
    if (isAbsolute(difference) || difference === '..' || difference.startsWith(`..${sep}`) || !statSync(path).isFile()) {
        throw new Error('托管 Codex 路径无效，请在机器页面重新更新。');
    }
    return path;
}
