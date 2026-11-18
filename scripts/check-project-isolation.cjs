#!/usr/bin/env node

const { readFileSync } = require('node:fs');
const { basename, extname, join, relative } = require('node:path');
const { repositoryFiles } = require('./lib/repository-files.cjs');

const root = join(__dirname, '..');
const ignoredFiles = new Set([
  'LICENSE',
  'pnpm-lock.yaml',
  'scripts/check-lightweight-architecture.cjs',
  'scripts/check-project-isolation.cjs',
  'scripts/selfhost-preflight.cjs',
]);
const inspectedExtensions = new Set([
  '.cjs', '.js', '.json', '.jsonc', '.md', '.mjs', '.sh', '.ts', '.tsx', '.yaml', '.yml',
]);
const forbidden = [
  { pattern: /tailscale|tailnet|funnel/i, reason: 'Tailscale integration residue' },
  { pattern: /\/home\/[^/\s]+\/happy(?:\/|\b)/, reason: 'absolute reference to the separate Happy checkout' },
  { pattern: /packages\/happy-(?:cli|web|server|wire|agent)/i, reason: 'obsolete Happy package path' },
  { pattern: /\b(?:happy|handy)-(?:server|webapp|cookie-auth|redis|postgres|minio)\b/i, reason: 'obsolete deployment resource name' },
  { pattern: /com\.(?:ex3ndr|slopus)\.happy/i, reason: 'upstream mobile application identifier' },
  { pattern: /happy-coder-9fe36/i, reason: 'upstream Firebase project identifier' },
  { pattern: /agent_6701k211syvvegba4kt7m68nxjmw/, reason: 'upstream ElevenLabs agent identifier' },
  { pattern: /cluster-fluster\.com/i, reason: 'upstream hosted-service endpoint' },
  { pattern: /docker\.korshakov\.com/i, reason: 'upstream private image registry' },
  { pattern: /github\.com\/nicepkg\//i, reason: 'upstream repository endpoint' },
];
// Path-scoped exceptions only. These are immutable encrypted/wire identifiers or
// authentication readers; allowing an entire file would let routing aliases creep
// back in unnoticed.
const legacyCompatibility = new Map([
  ['packages/hapla-cli/src/api/apiMachine.ts', [/happyAgentAuthenticated/]],
  ['packages/hapla-cli/src/api/types.ts', [
    /happyCliVersion/, /happyHomeDir/, /happyLibDir/, /happyToolsDir/,
    /requiresHappyAgentAuth/, /happyAgentAuthenticated/,
  ]],
  ['packages/hapla-cli/src/claude/runClaude.ts', [/happyHomeDir/, /happyLibDir/, /happyToolsDir/]],
  ['packages/hapla-cli/src/daemon/run.ts', [/happyCliVersion/, /happyHomeDir/, /happyLibDir/]],
  // Persisted session metadata retains these wire keys across daemon upgrades.
  ['packages/hapla-cli/src/daemon/trackedSessionRegistry.ts', [/\bhappyLibDir\b/, /\bhappyHomeDir\b/]],
  // Discovery must skip the legacy runtime directory, not surface it as media.
  ['packages/hapla-cli/src/modules/common/turnMediaArtifacts.ts', [/'\.happy'/]],
  ['packages/hapla-cli/src/resume/localHaplaAgentAuth.ts', [
    /requiresHappyAgentAuth/, /happyAgentAuthenticated/, /'Happy EnCoder'/,
  ]],
  ['packages/hapla-cli/src/utils/createSessionMetadata.ts', [/happyHomeDir/, /happyLibDir/, /happyToolsDir/]],
  ['packages/hapla-server/sources/app/auth/auth.ts', [/service: 'handy'/, /service: 'github-happy'/]],
  ['packages/hapla-server/sources/modules/encrypt.ts', [/usage: 'happy-server-tokens'/]],
  ['packages/hapla-web/sources/app/(app)/session/[id]/info.tsx', [/happyHomeDir/]],
  ['packages/hapla-web/sources/sync/encryption/encryption.ts', [/'Happy EnCoder'/, /'Happy Coder'/]],
  ['packages/hapla-web/sources/sync/storageTypes.ts', [
    /happyCliVersion/, /happyHomeDir/, /requiresHappyAgentAuth/, /happyAgentAuthenticated/,
    /'happy-app'/, /'happy-cli'/,
  ]],
  ['packages/hapla-web/sources/utils/sessionContinuation.ts', [/happyHomeDir/]],
]);
// These exact documentation phrases describe user-provided network entry points
// and address classification, not a bundled Tailscale integration. Other mentions
// in the document remain subject to the integration-residue check.
const networkDocumentation = new Map([
  ['docs/lan-file-delivery.md', '链路本地、Tailscale `100.64.0.0/10`、IPv6 ULA'],
]);

// Historical reports preserve the deployment context at the time. Product
// isolation applies to current source and documentation, not archived evidence.
const files = repositoryFiles(root)
  .filter((file) => !file.startsWith('docs/archive/')
    && !/(?:^|\/)(?:__fixtures__|__testdata__)\//.test(file)
    && inspectedExtensions.has(extname(file)) && !ignoredFiles.has(file))
  .map((file) => join(root, file));

const violations = [];
for (const file of files) {
  const relativePath = relative(root, file);
  let contents = readFileSync(file, 'utf8');
  if (relativePath === 'packages/hapla-server/sources/modules/encrypt.ts') {
    contents = contents.replace("usage: 'happy-server-tokens'", 'usage: legacy-token-label');
  }
  const networkPhrase = networkDocumentation.get(relativePath);
  if (networkPhrase) {
    contents = contents.replace(networkPhrase, networkPhrase.replace('Tailscale', 'user-network'));
  }
  for (const rule of forbidden) {
    if (rule.pattern.test(contents)) {
      violations.push(`${relativePath}: ${rule.reason}`);
    }
  }
}

const composeSource = readFileSync(join(root, 'docker-compose.selfhost.yml'), 'utf8');
if (/(?:localhost:|:-)9980\b/.test(composeSource)) {
  violations.push('docker-compose.selfhost.yml: port 9980 is reserved for the separate legacy service');
}

for (const file of files) {
  const relativePath = relative(root, file);
  const isRuntimeSource = relativePath.startsWith('packages/hapla-cli/src/')
    || relativePath.startsWith('packages/hapla-server/sources/')
    || relativePath.startsWith('packages/hapla-web/sources/')
    || relativePath.startsWith('packages/hapla-wire/src/');
  const isTest = /(?:\.test|\.spec)\.[^.]+$/.test(relativePath);
  if (!isRuntimeSource || isTest) continue;
  const allowedPatterns = legacyCompatibility.get(relativePath) || [];
  const lines = readFileSync(file, 'utf8').split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    // Remove only allowed tokens; an unrelated legacy reference on the same
    // line must still fail instead of inheriting the compatibility exception.
    const line = allowedPatterns.reduce(
      (value, pattern) => value.replace(new RegExp(pattern.source, 'g'), ''),
      lines[index],
    );
    if (/happy|handy/i.test(line)) {
      violations.push(`${relativePath}:${index + 1}: legacy name outside the exact compatibility boundary`);
    }
  }
}

for (const file of files) {
  const name = basename(file).toLowerCase();
  if (name.includes('happy') || name.includes('handy')) {
    violations.push(`${relative(root, file)}: obsolete branded filename`);
  }
}

if (violations.length > 0) {
  console.error(`Project-isolation check failed:\n${violations.map((item) => `- ${item}`).join('\n')}`);
  process.exit(1);
}

console.log('Project isolation: no bundled Tailscale integration, cross-checkout paths, upstream resources, credentials, or external IDs.');
