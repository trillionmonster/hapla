#!/usr/bin/env node

// Exercise the actual image without network, credentials, persistent volumes, or
// model requests. Keep the same privilege restrictions as compose.worker.yml.
const { spawnSync } = require('node:child_process');
const image = process.argv[2];
if (!image || image.startsWith('-')) {
  console.error('Usage: node scripts/worker-image-smoke.cjs IMAGE');
  process.exit(1);
}
function run(command) {
  const result = spawnSync('docker', ['run', '--rm', '--network', 'none', '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges:true', image, ...command], { stdio: 'inherit', timeout: 30_000 });
  if (result.error || result.status !== 0) throw new Error(`Worker image smoke failed${result.error ? `: ${result.error.message}` : ''}`);
}
try {
  run(['hapla', 'auth', '--help']);
  run(['codex', '--version']);
  run(['node', '-e', `
    const fs = require('node:fs');
    const assert = require('node:assert/strict');
    assert.equal(process.getuid(), 1000);
    for (const directory of ['/workspace', '/home/node/.hapla', '/home/node/.codex', '/home/node/.claude']) {
      const file = directory + '/.hapla-smoke';
      fs.writeFileSync(file, 'private image smoke');
      fs.unlinkSync(file);
    }
    const requireFromCli = require('node:module').createRequire(fs.realpathSync('/usr/local/bin/hapla'));
    const terminal = requireFromCli('node-pty').spawn('/bin/sh', ['-c', 'printf HAPLA_PTY_OK'], { cols: 80, rows: 24, cwd: '/workspace' });
    let text = '';
    terminal.onData((chunk) => { text += chunk; });
    terminal.onExit(({ exitCode }) => { assert.equal(exitCode, 0); assert.match(text, /HAPLA_PTY_OK/); console.log('Non-root state paths and native PTY passed.'); });
  `]);
} catch (error) { console.error(error.message); process.exitCode = 1; }
