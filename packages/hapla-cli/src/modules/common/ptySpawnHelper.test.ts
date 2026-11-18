import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, statSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensurePtySpawnHelper } from './ptySpawnHelper';
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(p => rmSync(p, { recursive: true, force: true })));
describe('macOS packaged terminal helper', () => {
    it('repairs only the executable bit of the helper selected by node-pty', () => {
        const root = mkdtempSync(join(tmpdir(), 'hapla-pty-')); roots.push(root);
        const path = join(root, 'prebuilds/darwin-arm64'); mkdirSync(path, { recursive: true });
        const helper = join(path, 'spawn-helper'); writeFileSync(helper, 'binary', { mode: 0o640 });
        const native = join(path, 'pty.node'); writeFileSync(native, 'native', { mode: 0o640 });
        chmodSync(helper, 0o640); chmodSync(native, 0o640);
        ensurePtySpawnHelper(join(root, 'package.json'), 'linux', 'arm64'); expect(statSync(helper).mode & 0o777).toBe(0o640);
        ensurePtySpawnHelper(join(root, 'package.json'), 'darwin', 'arm64'); expect(statSync(helper).mode & 0o777).toBe(0o740);
        expect(statSync(native).mode & 0o777).toBe(0o640);
        ensurePtySpawnHelper(join(root, 'package.json'), 'darwin', 'arm64'); expect(statSync(helper).mode & 0o777).toBe(0o740);
    });
});
