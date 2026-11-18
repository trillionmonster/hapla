import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { closeSync, openSync, readSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const binary = resolve(root, '.runtime/codex-source-0.156.1-lossless/codex-rs/target/debug/codex-app-server');
const actualVersion = execFileSync(binary, ['--version'], { encoding: 'utf8' }).trim();
if (actualVersion !== 'codex-app-server 0.156.1') throw new Error(`Unexpected built version: ${actualVersion}`);
function artifact(path) {
    const hash = createHash('sha256');
    const fd = openSync(path, 'r');
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    try {
        let bytes;
        while ((bytes = readSync(fd, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, bytes));
    } finally { closeSync(fd); }
    return { path: relative(root, path), sha256: hash.digest('hex') };
}
const manifest = {
    version: '0.156.1', upstreamCommit: 'b412ff32c417f855c2b2d1581b77058eed87c84b', patchRevision: 1,
    preparedAt: new Date().toISOString(),
    executable: artifact(resolve(root, 'scripts/codex-lossless/codex-0.156.1')),
    appServer: artifact(binary),
    codeModeHost: artifact(resolve(dirname(binary), 'codex-code-mode-host')),
};
// Preparing an upgrade never switches an existing runtime or its manifest.
const destination = resolve(root, '.runtime/codex-lossless-0.156.1.manifest.json');
const temporary = `${destination}.${process.pid}.tmp`;
writeFileSync(temporary, JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600 });
renameSync(temporary, destination);
console.log(`Prepared and verified Codex ${manifest.version} runtime: ${destination}`);
