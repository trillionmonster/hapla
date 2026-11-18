import { createHash } from 'node:crypto';
import { closeSync, existsSync, openSync, readFileSync, readSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { projectPath } from '@/projectPath';
import { codexToolsDirectory, managedCodexExecutable } from './managedCodex';

const VERIFIED_UPSTREAMS: Record<string, string> = {
    '0.153.4': '3d2ee51ca2d5db578f328aa75e20aa22c0197c9a',
    '0.156.1': 'b412ff32c417f855c2b2d1581b77058eed87c84b',
};
const verifiedFiles = new Map<string, string>();

function containedPath(root: string, path: unknown): string {
    if (typeof path !== 'string' || !path || isAbsolute(path)) throw new Error('Runtime artifact path must be relative');
    const actual = realpathSync(resolve(root, path));
    const difference = relative(root, actual);
    if (difference === '..' || difference.startsWith(`..${sep}`) || isAbsolute(difference)) throw new Error('Runtime artifact is outside the project');
    return actual;
}

function verifyArtifact(root: string, artifact: unknown): string {
    if (!artifact || typeof artifact !== 'object') throw new Error('Missing runtime artifact');
    const entry = artifact as { path?: unknown; sha256?: unknown };
    if (typeof entry.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(entry.sha256)) throw new Error('Invalid runtime artifact digest');
    const path = containedPath(root, entry.path);
    const metadata = statSync(path, { bigint: true });
    if (!metadata.isFile() || (metadata.mode & 0o111n) === 0n) throw new Error('Runtime artifact is not executable');
    const identity = `${path}:${metadata.dev}:${metadata.ino}:${metadata.size}:${metadata.mtimeNs}:${metadata.ctimeNs}:${entry.sha256}`;
    if (verifiedFiles.get(path) === identity) return path;
    const fd = openSync(path, 'r');
    const hash = createHash('sha256');
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    try {
        let bytes: number;
        while ((bytes = readSync(fd, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, bytes));
    } finally { closeSync(fd); }
    if (hash.digest('hex') !== entry.sha256) throw new Error(`Runtime artifact digest mismatch: ${entry.path}`);
    verifiedFiles.set(path, identity);
    return path;
}

/** Select only this CLI installation's prepared runtime; never discover executable config in a session's cwd. */
export function resolveConfiguredCodexExecutable(options: { installationRoot?: string; env?: NodeJS.ProcessEnv } = {}): string {
    const env = options.env ?? process.env;
    if (env.HAPLA_CODEX_PATH?.trim()) return env.HAPLA_CODEX_PATH.trim();
    let directory = resolve(options.installationRoot ?? projectPath());
    while (true) {
        const configPath = join(directory, '.hapla', 'codex-app-server.json');
        if (existsSync(configPath)) {
            try {
                const root = realpathSync(directory);
                const config = JSON.parse(readFileSync(configPath, 'utf8'));
                if (config.kind !== 'hapla-codex-lossless' || config.version !== 1) throw new Error('Unsupported runtime configuration');
                const manifest = JSON.parse(readFileSync(containedPath(root, config.manifest), 'utf8'));
                if (!VERIFIED_UPSTREAMS[manifest.version] || manifest.upstreamCommit !== VERIFIED_UPSTREAMS[manifest.version] || manifest.patchRevision !== 1) {
                    throw new Error('Unexpected Codex runtime version or patch revision');
                }
                const executable = verifyArtifact(root, manifest.executable);
                verifyArtifact(root, manifest.appServer);
                verifyArtifact(root, manifest.codeModeHost);
                return executable;
            } catch (error) {
                throw new Error(`Prepared Codex runtime is unavailable: ${error instanceof Error ? error.message : error}. Run ${join(directory, 'scripts/codex-lossless/build.sh')} before starting a new session.`);
            }
        }
        const parent = dirname(directory);
        if (parent === directory) return 'codex';
        directory = parent;
    }
}

export function resolveCodexExecutable(options: { installationRoot?: string; env?: NodeJS.ProcessEnv } = {}): string {
    const source = resolveConfiguredCodexExecutable(options);
    return managedCodexExecutable(source, codexToolsDirectory(options.env ?? process.env)) ?? source;
}
