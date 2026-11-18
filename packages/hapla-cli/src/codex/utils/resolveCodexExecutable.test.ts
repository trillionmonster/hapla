import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveCodexExecutable } from './resolveCodexExecutable';

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
function fixture() {
    const root = mkdtempSync(join(tmpdir(), 'hapla-codex-runtime-'));
    directories.push(root);
    const installationRoot = join(root, 'packages/hapla-cli');
    mkdirSync(installationRoot, { recursive: true });
    mkdirSync(join(root, '.hapla'));
    mkdirSync(join(root, '.runtime'));
    writeFileSync(join(root, '.hapla/codex-app-server.json'), JSON.stringify({ kind: 'hapla-codex-lossless', version: 1, manifest: '.runtime/manifest.json' }));
    const artifact = (path: string) => {
        const content = `#!/bin/sh\n# ${path}\n`;
        writeFileSync(join(root, path), content);
        chmodSync(join(root, path), 0o700);
        return { path, sha256: createHash('sha256').update(content).digest('hex') };
    };
    const manifest = {
        version: '0.153.4', upstreamCommit: '3d2ee51ca2d5db578f328aa75e20aa22c0197c9a', patchRevision: 1,
        executable: artifact('.runtime/codex'), appServer: artifact('.runtime/app-server'), codeModeHost: artifact('.runtime/host'),
    };
    const save = () => writeFileSync(join(root, '.runtime/manifest.json'), JSON.stringify(manifest));
    save();
    return { root, installationRoot, manifest, save };
}

describe('resolveCodexExecutable', () => {
    it('selects the prepared project executable after verifying all artifact hashes', () => {
        const { root, installationRoot } = fixture();
        expect(resolveCodexExecutable({ installationRoot, env: {} })).toBe(join(root, '.runtime/codex'));
        expect(resolveCodexExecutable({ installationRoot, env: {} })).toBe(join(root, '.runtime/codex'));
    });
    it('rejects a changed artifact even after a prior successful verification', () => {
        const { root, installationRoot } = fixture();
        resolveCodexExecutable({ installationRoot, env: {} });
        writeFileSync(join(root, '.runtime/app-server'), 'changed binary');
        expect(() => resolveCodexExecutable({ installationRoot, env: {} })).toThrow('digest mismatch');
    });
    it('requires explicit preparation when the project configured a runtime', () => {
        const { root, installationRoot } = fixture();
        rmSync(join(root, '.runtime/manifest.json'));
        expect(() => resolveCodexExecutable({ installationRoot, env: {} })).toThrow('build.sh');
    });
    it('rejects a wrong version and paths outside the configured project', () => {
        const { installationRoot, manifest, save } = fixture();
        manifest.version = '0.153.3'; save();
        expect(() => resolveCodexExecutable({ installationRoot, env: {} })).toThrow('version or patch revision');
        manifest.version = '0.153.4'; manifest.executable.path = '../'; save();
        expect(() => resolveCodexExecutable({ installationRoot, env: {} })).toThrow('outside the project');
    });
    it('preserves an explicit executable override and uses PATH for installations without project config', () => {
        const { root, installationRoot } = fixture();
        expect(resolveCodexExecutable({ installationRoot, env: { HAPLA_CODEX_PATH: '/opt/custom/codex' } })).toBe('/opt/custom/codex');
        rmSync(join(root, '.hapla/codex-app-server.json'));
        expect(resolveCodexExecutable({ installationRoot, env: {} })).toBe('codex');
    });
});
