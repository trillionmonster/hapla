import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

it.skipIf(process.platform === 'win32')('runs a PATH-only ripgrep executable and preserves its output and exit code', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hapla-rg-path-'));
    try {
        const scripts = join(root, 'scripts');
        const bin = join(root, 'custom tools');
        await mkdir(scripts);
        await mkdir(bin);
        const launcher = join(scripts, 'ripgrep_launcher.cjs');
        await copyFile(fileURLToPath(new URL('../ripgrep_launcher.cjs', import.meta.url)), launcher);
        const executable = join(bin, 'rg');
        await writeFile(join(bin, 'which'), '#!/bin/sh\nprintf "%s\\n" "$HAPLA_TEST_RG_PATH"\n', { mode: 0o755 });
        await writeFile(executable, '#!/bin/sh\nprintf "%s\\n" "PATH_ONLY_RIPGREP"\nexit 7\n', { mode: 0o755 });

        const result = spawnSync(process.execPath, [launcher, JSON.stringify(['--version'])], {
            env: { ...process.env, PATH: bin, HAPLA_TEST_RG_PATH: executable },
            encoding: 'utf8',
        });

        expect(result.error).toBeUndefined();
        expect(result.status).toBe(7);
        expect(result.stdout.trim()).toBe('PATH_ONLY_RIPGREP');
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});
