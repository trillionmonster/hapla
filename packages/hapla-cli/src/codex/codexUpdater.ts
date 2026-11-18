import { execFile, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { mkdir, rename, rm } from 'node:fs/promises';
import { delimiter, dirname, join, resolve, sep } from 'node:path';
import type { CodexUpdateStatus } from '@hapla/wire';
import { CodexAppServerClient } from './codexAppServerClient';
import { codexToolsDirectory, managedCodexExecutable, type ManagedCodexInstallation } from './utils/managedCodex';
import { resolveCodexExecutable, resolveConfiguredCodexExecutable } from './utils/resolveCodexExecutable';

type Installation = Pick<CodexUpdateStatus, 'currentVersion' | 'installation' | 'updateSupported' | 'unsupportedReason'> & { source: string };
export interface CodexUpdaterDependencies {
    directory: string;
    inspect: () => Installation;
    latest: () => Promise<string>;
    install: (directory: string, version: string) => Promise<string>;
    verify: (executable: string, version: string) => Promise<void>;
    refresh: () => Promise<void>;
}
const BUSY = new Set(['checking', 'installing', 'verifying', 'refreshing']);
const versionNumber = (value: string | null | undefined) => value?.match(/\b(\d+\.\d+\.\d+(?:-[\w.-]+)?)\b/)?.[1] ?? null;
function newerVersion(latest: string, current: string | null | undefined): boolean {
    const existing = versionNumber(current);
    if (!existing) return true;
    const currentParts = existing.split(/[.-]/).slice(0, 3).map(Number);
    const targetParts = latest.split('.').map(Number);
    for (let i = 0; i < 3; i++) {
        if (currentParts[i] !== targetParts[i]) return targetParts[i] > currentParts[i];
    }
    return existing.includes('-');
}

function writeJson(path: string, value: unknown) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.${randomUUID()}.tmp`;
    writeFileSync(temporary, JSON.stringify(value), { mode: 0o600 });
    renameSync(temporary, path);
}

/** One daemon-owned job per machine. Every installed release is immutable;
 * only current.json changes, so existing processes keep their original files. */
export class CodexUpdateController {
    private status: CodexUpdateStatus = { state: 'idle', message: '可更新 Codex 并同步模型与档位说明。' };
    private running: Promise<void> | null = null;
    private inspectedAt = 0;
    constructor(private readonly dependencies: CodexUpdaterDependencies) {
        try {
            const saved = JSON.parse(readFileSync(join(dependencies.directory, 'update.json'), 'utf8'));
            if (saved && ['idle', ...BUSY, 'completed', 'failed'].includes(saved.state)) this.status = saved;
            if (BUSY.has(this.status.state)) {
                this.status = { ...this.status, state: 'failed', finishedAt: Date.now(), modelsRefreshed: false,
                    error: '机器进程在更新期间重启，未确认完成。请重新检查更新。', message: '上次更新未确认完成，请重试。' };
                this.save();
            }
        } catch { /* First run; installation state is probed on first request. */ }
    }
    getStatus(): CodexUpdateStatus {
        if (!this.running && Date.now() - this.inspectedAt > 30_000) {
            const { source: _source, ...installation } = this.dependencies.inspect();
            this.status = { ...this.status, ...installation };
            this.inspectedAt = Date.now();
        }
        return { ...this.status };
    }
    start(): CodexUpdateStatus {
        if (this.running) return this.getStatus();
        const installation = this.dependencies.inspect();
        this.inspectedAt = Date.now();
        if (!installation.updateSupported) {
            const { source: _source, ...info } = installation;
            this.status = { ...info, state: 'failed', message: installation.unsupportedReason || '此安装不支持自动更新。',
                error: installation.unsupportedReason, finishedAt: Date.now(), modelsRefreshed: false };
            this.save();
            return this.getStatus();
        }
        this.status = { state: 'checking', message: '正在检查官方最新版本…', operationId: randomUUID(),
            currentVersion: installation.currentVersion, previousVersion: installation.currentVersion, startedAt: Date.now(),
            updateSupported: true, installation: installation.installation, modelsRefreshed: false };
        this.save();
        // Install is scheduled after the RPC can acknowledge; a disconnected browser does not cancel it.
        this.running = Promise.resolve().then(() => this.run(installation)).catch(() => {
            // A disk failure must not create an unhandled daemon rejection.
            this.status = { ...this.status, state: 'failed', modelsRefreshed: false, finishedAt: Date.now(),
                message: '更新未确认完成，请检查机器的数据目录后重试。', error: '无法保存更新状态。' };
        }).finally(() => { this.running = null; });
        return this.getStatus();
    }
    async waitForCompletion(): Promise<void> { await this.running; }
    private save() { writeJson(join(this.dependencies.directory, 'update.json'), this.status); }
    private progress(state: CodexUpdateStatus['state'], message: string) {
        this.status = { ...this.status, state, message }; this.save();
    }
    private async run(installation: Installation) {
        const d = this.dependencies;
        const pointerPath = join(d.directory, 'current.json');
        let previousPointer: string | null = null;
        let switched = false;
        let stage: string | null = null;
        let installedVersion = installation.currentVersion;
        try {
            previousPointer = existsSync(pointerPath) ? readFileSync(pointerPath, 'utf8') : null;
            const latest = await d.latest();
            if (!/^\d+\.\d+\.\d+$/.test(latest)) throw new Error('官方版本号无效，请稍后重试。');
            if (newerVersion(latest, installation.currentVersion)) {
                this.progress('installing', `正在下载 Codex ${latest}…`);
                stage = join(d.directory, `staging-${this.status.operationId}`);
                await mkdir(stage, { recursive: true, mode: 0o700 });
                const stagedExecutable = await d.install(stage, latest);
                this.progress('verifying', '正在验证新版 Codex 和模型接口…');
                await d.verify(stagedExecutable, latest);
                const release = `${latest}-${this.status.operationId}`;
                await mkdir(join(d.directory, 'releases'), { recursive: true, mode: 0o700 });
                await rename(stage, join(d.directory, 'releases', release));
                stage = null;
                const next: ManagedCodexInstallation = { version: 1, source: installation.source, release, cliVersion: latest };
                writeJson(pointerPath, next);
                switched = true;
                installedVersion = `codex-cli ${latest}`;
                this.status = { ...this.status, currentVersion: installedVersion, installation: 'managed' };
            }
            this.progress('refreshing', '正在同步模型列表和各档位说明…');
            await d.refresh();
            this.status = { ...this.status, state: 'completed', currentVersion: installedVersion, finishedAt: Date.now(), modelsRefreshed: true,
                message: switched ? 'Codex 已更新，模型与档位已同步。新启动的 Codex 使用新版，现有任务继续原版本。' : '当前已是最新版本，模型与档位说明已同步。' };
        } catch (error) {
            let rollbackFailed = false;
            if (switched) {
                try {
                    if (previousPointer === null) await rm(pointerPath, { force: true });
                    else writeJson(pointerPath, JSON.parse(previousPointer));
                } catch { rollbackFailed = true; }
            }
            const reason = error instanceof Error ? error.message : '更新未完成，请重试。';
            this.status = { ...this.status, state: 'failed', finishedAt: Date.now(), modelsRefreshed: false,
                currentVersion: rollbackFailed ? installedVersion : installation.currentVersion,
                installation: rollbackFailed ? 'managed' : installation.installation,
                message: rollbackFailed ? '更新未完成，恢复原版本失败。请检查机器上的 Codex 安装。' : '更新未完成，原版本仍可使用。', error: reason };
        } finally {
            if (stage) await rm(stage, { recursive: true, force: true }).catch(() => undefined);
            this.save();
        }
    }
}

function executableOnPath(name: string): string | null {
    for (const entry of (process.env.PATH ?? '').split(delimiter)) {
        if (!entry) continue;
        try { const path = realpathSync(join(entry, name)); if (existsSync(path)) return path; } catch { /* next entry */ }
    }
    return null;
}
function npmCliPath(): string | null {
    const path = executableOnPath('npm');
    if (path?.endsWith('npm-cli.js')) return path;
    const candidate = join(dirname(process.execPath), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js');
    return existsSync(candidate) ? resolve(candidate) : null;
}
function officialNpmExecutable(source: string): boolean {
    try {
        const path = realpathSync(source === 'codex' ? executableOnPath('codex') || '' : source);
        const pkg = JSON.parse(readFileSync(join(dirname(path), '..', 'package.json'), 'utf8'));
        return pkg.name === '@openai/codex' && path.endsWith(`${sep}bin${sep}codex.js`);
    } catch { return false; }
}

function runNode(args: string[], timeout: number, action: string): Promise<string> {
    return new Promise((resolveOutput, reject) => {
        execFile(process.execPath, args, { timeout, maxBuffer: 512 * 1024, windowsHide: true,
            cwd: codexToolsDirectory(), env: { ...process.env, CI: '1', npm_config_update_notifier: 'false' } }, (error, stdout) => {
            if (error) reject(new Error(error.killed ? `${action}超时，请检查网络后重试。` : `${action}失败，请检查网络、磁盘空间和目录权限后重试。`));
            else resolveOutput(stdout.trim());
        });
    });
}

export function createCodexUpdater(refresh: () => Promise<void>): CodexUpdateController {
    const directory = codexToolsDirectory();
    return new CodexUpdateController({
        directory,
        inspect: () => {
            let source: string;
            try { source = resolveConfiguredCodexExecutable(); } catch {
                return { source: '', installation: 'custom', currentVersion: null, updateSupported: false, unsupportedReason: '定制 Codex 运行时尚未准备完成，请先修复其安装。' };
            }
            let currentVersion: string | null = null;
            let managed = false;
            try {
                managed = !!managedCodexExecutable(source, directory);
                currentVersion = execFileSync(resolveCodexExecutable(), ['--version'], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
            } catch { /* Allow an official installation to be repaired. */ }
            const official = officialNpmExecutable(source);
            const installation = managed ? 'managed' as const : official ? 'npm' as const : currentVersion ? 'custom' as const : 'missing' as const;
            const reason = process.platform === 'win32' ? '此 Windows 安装请使用本机包管理器更新；仍可单独刷新模型与档位。'
                : !npmCliPath() ? '这台机器没有可用的 npm，请先安装 npm；仍可单独刷新模型与档位。' : undefined;
            return { source, currentVersion, installation, updateSupported: !reason, unsupportedReason: reason };
        },
        latest: async () => {
            const output = await runNode([npmCliPath()!, 'view', '@openai/codex', 'dist-tags.latest', '--json', '--registry=https://registry.npmjs.org', '--fetch-timeout=30000', '--fetch-retries=1'], 75_000, '检查版本');
            return JSON.parse(output);
        },
        install: async (stage, version) => {
            await runNode([npmCliPath()!, 'install', '--prefix', stage, '--no-save', '--package-lock=false', '--ignore-scripts', '--no-audit', '--no-fund', '--include=optional', '--registry=https://registry.npmjs.org', '--fetch-timeout=60000', '--fetch-retries=2', `@openai/codex@${version}`], 10 * 60_000, '下载 Codex');
            return join(stage, 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
        },
        verify: async (executable, version) => {
            const detected = await runNode([executable, '--version'], 15_000, '验证 Codex');
            if (versionNumber(detected) !== version) throw new Error('下载后的 Codex 版本不一致，请重试。');
            const client = new CodexAppServerClient(undefined, [], executable);
            try {
                await client.connect();
                if (!(await client.listModels()).length) throw new Error('新版 Codex 没有返回可用模型。');
            } catch { throw new Error('新版 Codex 模型接口验证失败，请检查登录状态后重试。'); }
            finally { await client.disconnect().catch(() => undefined); }
        },
        refresh,
    });
}
