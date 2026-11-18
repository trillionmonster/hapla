#!/usr/bin/env node

const { mkdtempSync, readFileSync, readdirSync, writeFileSync, rmSync } = require('node:fs');
const { createHash } = require('node:crypto');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { spawnSync } = require('node:child_process');

const root = join(__dirname, '..');
const generated = mkdtempSync(join(tmpdir(), 'hapla-codex-schema-'));

try {
  const version = spawnSync('codex', ['--version'], { encoding: 'utf8' });
  if (version.status !== 0) throw new Error(version.stderr || 'Codex CLI is not installed.');

  const generation = spawnSync(
    'codex',
    ['app-server', 'generate-ts', '--experimental', '--out', generated],
    { encoding: 'utf8' },
  );
  if (generation.status !== 0) throw new Error(generation.stderr || 'Could not generate the app-server schema.');

  const methodNames = (file) => {
    const source = readFileSync(join(generated, file), 'utf8');
    return [...source.matchAll(/"method":\s*"([^"]+)"/g)].map((match) => match[1]);
  };
  const clientRequests = methodNames('ClientRequest.ts');
  const clientNotifications = methodNames('ClientNotification.ts');
  const serverRequests = methodNames('ServerRequest.ts');
  const serverNotifications = methodNames('ServerNotification.ts');
  // Freeze the actual generated contract, including a digest of every type.
  // The selected sources make critical lifecycle fields reviewable in a compact snapshot.
  const sources = {};
  const typeHashes = {};
  const walk = (directory, prefix = '') => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const relative = prefix + entry.name;
      if (entry.isDirectory()) walk(join(directory, entry.name), relative + '/');
      else if (entry.name.endsWith('.ts')) {
        typeHashes[relative] = createHash('sha256').update(readFileSync(join(directory, entry.name))).digest('hex');
      }
    }
  };
  walk(generated);
  for (const file of ['InitializeParams.ts', 'InitializeResponse.ts', 'RequestId.ts',
    'v2/ThreadStatus.ts', 'v2/ThreadActiveFlag.ts', 'v2/ThreadStatusChangedNotification.ts',
    'v2/TurnStartedNotification.ts', 'v2/TurnCompletedNotification.ts', 'v2/Turn.ts', 'v2/TurnStatus.ts',
    'v2/TurnInterruptParams.ts', 'v2/TurnInterruptResponse.ts', 'v2/ServerRequestResolvedNotification.ts',
    'v2/CommandExecutionOutputDeltaNotification.ts', 'v2/ToolRequestUserInputParams.ts', 'v2/UserInput.ts']) {
    sources[file] = readFileSync(join(generated, file), 'utf8');
  }
  const snapshot = {
    snapshotVersion: 1,
    cliVersion: version.stdout.trim().replace(/^codex-cli\s+/, ''),
    generator: 'codex app-server generate-ts --experimental',
    clientRequests, clientNotifications, serverRequests, serverNotifications, sources, typeHashes,
  };
  const snapshotPath = join(root, 'packages/hapla-cli/src/codex/codexProtocolSnapshot.json');
  if (process.argv.includes('--update-snapshot')) {
    writeFileSync(snapshotPath, JSON.stringify(snapshot, null, 2) + '\n');
  } else if (JSON.stringify(JSON.parse(readFileSync(snapshotPath, 'utf8'))) !== JSON.stringify(snapshot)) {
    throw new Error('Installed Codex schema differs from the frozen snapshot. Review the generated changes, then run node scripts/check-codex-protocol.cjs --update-snapshot.');
  }
  const bridge = readFileSync(
    join(root, 'packages/hapla-cli/src/codex/codexAppServerClient.ts'),
    'utf8',
  );
  const checkedTypes = readFileSync(
    join(root, 'packages/hapla-cli/src/codex/codexAppServerTypes.ts'),
    'utf8',
  );
  const generatedUserInput = readFileSync(join(generated, 'v2', 'UserInput.ts'), 'utf8');
  const codexRuntime = readFileSync(
    join(root, 'packages/hapla-cli/src/codex/runCodex.ts'),
    'utf8',
  );
  const inputVariants = [...generatedUserInput.matchAll(/[" ]type[" ]*:\s*"([^"]+)"/g)]
    .map((match) => match[1]);
  const missingInputVariants = [...new Set(inputVariants)]
    .filter((variant) => !checkedTypes.includes(`type: "${variant}"`));

  const missingServerRequests = serverRequests.filter((method) => !bridge.includes(`'${method}'`));
  if (missingServerRequests.length > 0) {
    throw new Error(`Unhandled server requests: ${missingServerRequests.join(', ')}`);
  }
  if (missingInputVariants.length > 0) {
    throw new Error(`UserInput schema drift: missing ${missingInputVariants.join(', ')}`);
  }
  if (!bridge.includes("'thread/fork'")) {
    throw new Error('First-class thread/fork support is missing.');
  }
  const requiredClientMethods = [
    'initialize',
    'model/list',
    'thread/start',
    'thread/resume',
    'thread/fork',
    'thread/read',
    'turn/start',
    'turn/steer',
    'mcpServer/resource/read',
    'mcpServer/tool/call',
    'skills/list',
  ];
  const missingCriticalMethods = requiredClientMethods.filter((method) => (
    !clientRequests.includes(method) || (!bridge.includes(`'${method}'`) && !bridge.includes(`"${method}"`))
  ));
  if (missingCriticalMethods.length > 0) {
    throw new Error(`Critical generated methods are not wired: ${missingCriticalMethods.join(', ')}`);
  }
  if (!bridge.includes("this.notify('initialized')")) {
    throw new Error('The required initialized notification is missing from the handshake.');
  }
  if (bridge.includes("'thread/rollback'") || codexRuntime.includes('rollbackThreadTurns')) {
    throw new Error('Deprecated thread/rollback is still used by the executable Codex bridge.');
  }
  if (!bridge.includes('requestRaw<T = unknown>')) {
    throw new Error('Generic client-request transport is missing.');
  }
  if (!bridge.includes('notifyRaw(method: string')) {
    throw new Error('Generic client-notification transport is missing.');
  }
  if (!bridge.includes("type: 'codex_notification'")) {
    throw new Error('Unknown server notifications are not preserved.');
  }

  console.log([
    `Codex protocol ${version.stdout.trim()}:`,
    `${clientRequests.length} client requests`,
    `${clientNotifications.length} client notifications`,
    `${serverRequests.length} server requests`,
    `${serverNotifications.length} server notifications`,
    `${new Set(inputVariants).size} UserInput variants checked`,
    'generated-schema transport coverage, handshake, lifecycle, branch and forward-compatibility verified.',
  ].join(' '));
} finally {
  rmSync(generated, { recursive: true, force: true });
}
