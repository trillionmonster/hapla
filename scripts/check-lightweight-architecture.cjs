#!/usr/bin/env node

const { existsSync, readFileSync } = require('node:fs');
const { join } = require('node:path');

const root = join(__dirname, '..');
const forbiddenPaths = [
  'Dockerfile.server',
  'docker-compose.cookie-auth.yml',
  'gateway',
  'cookie-auth',
  'packages/hapla-cli/tools',
  'packages/hapla-server/deploy',
  'packages/hapla-web/deploy',
  'packages/hapla-web/sources/realtime',
  'packages/hapla-web/sources/sync/apiPush.ts',
  'packages/hapla-web/sources/sync/purchases.ts',
  'packages/hapla-web/sources/sync/revenueCat',
  'packages/hapla-web/src-tauri',
];
const forbiddenDependencies = new Set([
  '@11labs/client',
  '@livekit/react-native',
  '@livekit/react-native-webrtc',
  '@livekit/react-native-expo-plugin',
  '@shopify/react-native-skia',
  '@tauri-apps/api',
  '@tauri-apps/cli',
  'expo-server-sdk',
  'ioredis',
  'livekit-client',
  'minio',
  'react-native-purchases',
  'react-native-purchases-ui',
  'redis',
  '@socket.io/redis-adapter',
  'posthog-js',
  'posthog-react-native',
]);
const manifests = [
  'package.json',
  'packages/hapla-cli/package.json',
  'packages/hapla-server/package.json',
  'packages/hapla-web/package.json',
  'packages/hapla-wire/package.json',
];

const violations = [];
for (const path of forbiddenPaths) {
  if (existsSync(join(root, path))) violations.push(`${path}: heavyweight component must stay deleted`);
}

for (const manifest of manifests) {
  const contents = JSON.parse(readFileSync(join(root, manifest), 'utf8'));
  const dependencies = {
    ...contents.dependencies,
    ...contents.devDependencies,
    ...contents.optionalDependencies,
  };
  for (const name of Object.keys(dependencies)) {
    if (forbiddenDependencies.has(name)) {
      violations.push(`${manifest}: forbidden dependency ${name}`);
    }
  }
}

const serverManifest = JSON.parse(readFileSync(join(root, 'packages/hapla-server/package.json'), 'utf8'));
for (const buildOnlyPackage of ['prisma', 'prisma-json-types-generator', 'typescript']) {
  if (serverManifest.dependencies?.[buildOnlyPackage]) {
    violations.push(`packages/hapla-server/package.json: build-only package ${buildOnlyPackage} must not ship at runtime`);
  }
}

const compose = readFileSync(join(root, 'docker-compose.selfhost.yml'), 'utf8');
const declaredServices = [...compose.matchAll(/^  ([a-zA-Z0-9_-]+):\s*$/gm)].map((match) => match[1]);
const services = declaredServices.filter((name) => !['hapla-data', 'default'].includes(name));
if (services.join(',') !== 'server,web') {
  violations.push(`docker-compose.selfhost.yml: expected exactly server,web; found ${services.join(',')}`);
}
if (/\b(?:kubernetes|kustomize|redis|minio|postgres|tailscale|gateway|cookie-auth)\b/i.test(compose)) {
  violations.push('docker-compose.selfhost.yml: heavyweight or obsolete service residue');
}

if (violations.length) {
  console.error(`Lightweight-architecture check failed:\n${violations.map((item) => `- ${item}`).join('\n')}`);
  process.exit(1);
}

console.log('Lightweight architecture: two containers, no K8s/Tailscale/gateway/Redis or bundled platform tools.');
