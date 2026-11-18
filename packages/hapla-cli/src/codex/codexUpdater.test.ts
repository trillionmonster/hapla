import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
const inspection = vi.hoisted(() => ({ source: '/custom/codex', version: 'codex-cli 0.153.4' }));
vi.mock('node:child_process', async importOriginal => ({
    ...await importOriginal<typeof import('node:child_process')>(),
    execFileSync: vi.fn(() => inspection.version),
}));
vi.mock('./utils/resolveCodexExecutable', () => ({
    resolveConfiguredCodexExecutable: () => inspection.source,
    resolveCodexExecutable: () => inspection.source,
}));
vi.mock('./codexAppServerClient', () => ({ CodexAppServerClient: class {} }));
import { CodexUpdateController, createCodexUpdater, type CodexUpdaterDependencies } from './codexUpdater';
import { codexToolsDirectory, managedCodexExecutable } from './utils/managedCodex';

describe('machine-owned Codex updater', () => {
    let root: string;
    let deps: CodexUpdaterDependencies;
    const binary = (base: string) => {
        const path = join(base, 'node_modules/@openai/codex/bin/codex.js');
        mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, '#!/usr/bin/env node\n'); chmodSync(path, 0o755);
        return path;
    };
    beforeEach(() => {
        root = mkdtempSync(join(tmpdir(), 'hapla-codex-update-'));
        deps = {
            directory: root,
            inspect: () => ({ source: 'codex', currentVersion: 'codex-cli 0.153.4', installation: 'npm', updateSupported: true }),
            latest: vi.fn().mockResolvedValue('0.156.1'),
            install: vi.fn(async path => binary(path)), verify: vi.fn().mockResolvedValue(undefined), refresh: vi.fn().mockResolvedValue(undefined),
        };
    });
    afterEach(() => { vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });
    function previous() {
        const executable = binary(join(root, 'releases/0.153.4-original'));
        const pointer = { version: 1, source: 'codex', release: '0.153.4-original', cliVersion: '0.153.4' };
        writeFileSync(join(root, 'current.json'), JSON.stringify(pointer));
        return { pointer, executable };
    }
    it('acknowledges immediately, coalesces duplicate clicks, and only activates verified releases', async () => {
        let finish!: (version: string) => void;
        deps.latest = vi.fn(() => new Promise<string>(resolve => { finish = resolve; }));
        const controller = new CodexUpdateController(deps);
        const first = controller.start(); const second = controller.start();
        expect(first.state).toBe('checking'); expect(second.operationId).toBe(first.operationId);
        await Promise.resolve(); expect(deps.latest).toHaveBeenCalledOnce();
        expect(existsSync(join(root, 'current.json'))).toBe(false);
        finish('0.156.1'); await controller.waitForCompletion();
        expect(deps.verify).toHaveBeenCalledOnce(); expect(deps.refresh).toHaveBeenCalledOnce();
        expect(controller.getStatus()).toMatchObject({ state: 'completed', modelsRefreshed: true, currentVersion: 'codex-cli 0.156.1' });
        expect(managedCodexExecutable('codex', root)).toContain('/releases/0.156.1-');
        expect(managedCodexExecutable('/explicit/different-codex', root)).toBeNull();
    });
    it.each(['install', 'verify'])('keeps the old executable and pointer intact when %s fails', async stage => {
        const old = previous(); deps[stage as 'install' | 'verify'] = vi.fn().mockRejectedValue(new Error('test failure'));
        const controller = new CodexUpdateController(deps); controller.start(); await controller.waitForCompletion();
        expect(controller.getStatus()).toMatchObject({ state: 'failed', modelsRefreshed: false, currentVersion: 'codex-cli 0.153.4' });
        expect(managedCodexExecutable('codex', root)).toBe(old.executable);
        expect(JSON.parse(readFileSync(join(root, 'current.json'), 'utf8'))).toEqual(old.pointer);
        expect(deps.refresh).not.toHaveBeenCalled();
    });
    it('rolls back activation when capability refresh fails', async () => {
        const old = previous();
        deps.refresh = vi.fn(async () => {
            expect(managedCodexExecutable('codex', root)).not.toBe(old.executable);
            throw new Error('model discovery failed');
        });
        const controller = new CodexUpdateController(deps); controller.start(); await controller.waitForCompletion();
        expect(controller.getStatus()).toMatchObject({ state: 'failed', modelsRefreshed: false, error: 'model discovery failed' });
        expect(managedCodexExecutable('codex', root)).toBe(old.executable);
        expect(existsSync(old.executable)).toBe(true);
    });
    it('removes a first activation on refresh failure to restore the original system executable', async () => {
        deps.refresh = vi.fn().mockRejectedValue(new Error('offline'));
        const controller = new CodexUpdateController(deps); controller.start(); await controller.waitForCompletion();
        expect(managedCodexExecutable('codex', root)).toBeNull();
        expect(controller.getStatus().state).toBe('failed');
    });
    it.each(['0.156.1', '0.157.0'])('refreshes catalogs without reinstalling or downgrading version %s', async version => {
        deps.inspect = () => ({ source: 'codex', currentVersion: `codex-cli ${version}`, installation: 'npm', updateSupported: true });
        const controller = new CodexUpdateController(deps); controller.start(); await controller.waitForCompletion();
        expect(deps.install).not.toHaveBeenCalled(); expect(deps.refresh).toHaveBeenCalledOnce();
        expect(controller.getStatus()).toMatchObject({ state: 'completed', currentVersion: `codex-cli ${version}`, modelsRefreshed: true });
    });
    it('allows custom installations to use the managed updater when npm is available', () => {
        const npm = join(root, 'npm-cli.js');
        writeFileSync(npm, ''); symlinkSync(npm, join(root, 'npm'));
        vi.stubEnv('HAPLA_HOME_DIR', root); vi.stubEnv('PATH', root);
        expect(createCodexUpdater(async () => {}).getStatus()).toMatchObject({
            currentVersion: 'codex-cli 0.153.4', installation: 'custom', updateSupported: process.platform !== 'win32',
        });
    });
    it('activates a verified managed release for a custom source while preserving its original files', async () => {
        const original = join(root, 'custom-codex');
        writeFileSync(original, 'original patched executable');
        deps.inspect = () => ({ source: original, currentVersion: 'codex-cli 0.153.4', updateSupported: true, installation: 'custom' });
        const controller = new CodexUpdateController(deps); controller.start(); await controller.waitForCompletion();
        expect(controller.getStatus()).toMatchObject({ state: 'completed', installation: 'managed', currentVersion: 'codex-cli 0.156.1' });
        expect(managedCodexExecutable(original, root)).toContain('/releases/0.156.1-');
        expect(readFileSync(original, 'utf8')).toBe('original patched executable');
        expect(deps.verify).toHaveBeenCalledOnce(); expect(deps.refresh).toHaveBeenCalledOnce();
    });
    it('restores a custom source when the first managed activation cannot refresh models', async () => {
        deps.inspect = () => ({ source: '/custom/codex', currentVersion: 'codex-cli 0.153.4', updateSupported: true, installation: 'custom' });
        deps.refresh = vi.fn().mockRejectedValue(new Error('offline'));
        const controller = new CodexUpdateController(deps); controller.start(); await controller.waitForCompletion();
        expect(managedCodexExecutable('/custom/codex', root)).toBeNull();
        expect(controller.getStatus()).toMatchObject({ state: 'failed', installation: 'custom', currentVersion: 'codex-cli 0.153.4' });
    });
    it('keeps unsupported platform or prerequisite failures from starting an installation', async () => {
        deps.inspect = () => ({ source: '/custom/codex', currentVersion: 'codex-cli 0.153.4', updateSupported: false, installation: 'custom', unsupportedReason: '这台机器没有可用的 npm' });
        const controller = new CodexUpdateController(deps); expect(controller.start()).toMatchObject({ state: 'failed', updateSupported: false });
        await controller.waitForCompletion(); expect(deps.latest).not.toHaveBeenCalled(); expect(deps.install).not.toHaveBeenCalled();
    });
    it('persists completion for another page or daemon', async () => {
        const controller = new CodexUpdateController(deps); controller.start(); await controller.waitForCompletion();
        deps.inspect = () => ({ source: 'codex', currentVersion: 'codex-cli 0.156.1', installation: 'managed', updateSupported: true });
        const restored = new CodexUpdateController(deps);
        expect(restored.getStatus()).toMatchObject({ state: 'completed', operationId: controller.getStatus().operationId, currentVersion: 'codex-cli 0.156.1' });
    });
    it('marks an interrupted job as unconfirmed rather than leaving an endless spinner', () => {
        writeFileSync(join(root, 'update.json'), JSON.stringify({ state: 'installing', operationId: 'old', startedAt: 1, message: 'installing' }));
        const controller = new CodexUpdateController(deps);
        expect(controller.getStatus()).toMatchObject({ state: 'failed', modelsRefreshed: false });
        expect(controller.getStatus().error).toContain('未确认完成');
    });
    it('rejects an invalid registry version before invoking the installer', async () => {
        deps.latest = vi.fn().mockResolvedValue('latest; unwanted command');
        const controller = new CodexUpdateController(deps); controller.start(); await controller.waitForCompletion();
        expect(deps.install).not.toHaveBeenCalled(); expect(controller.getStatus().state).toBe('failed');
    });
    it('rejects a managed entry escaping the releases directory', () => {
        binary(join(root, 'outside')); mkdirSync(join(root, 'releases'));
        symlinkSync(join(root, 'outside'), join(root, 'releases/escape'), 'dir');
        writeFileSync(join(root, 'current.json'), JSON.stringify({ version: 1, source: 'codex', release: 'escape', cliVersion: '0.156.1' }));
        expect(() => managedCodexExecutable('codex', root)).toThrow('路径无效');
    });
    it('uses the configured Hapla home consistently for bare tilde and subdirectories', () => {
        expect(codexToolsDirectory({ HAPLA_HOME_DIR: '~' })).toBe(join(homedir(), 'tools/codex'));
        expect(codexToolsDirectory({ HAPLA_HOME_DIR: '~/.hapla-test' })).toBe(join(homedir(), '.hapla-test/tools/codex'));
    });
});
