#!/usr/bin/env node

const { readFileSync, readdirSync, statSync } = require('node:fs');
const { join, relative } = require('node:path');

const root = join(__dirname, '..');
const sourceRoots = [
  'packages/hapla-cli/src',
  'packages/hapla-web/sources',
  'packages/hapla-server/sources',
  'packages/hapla-wire/src',
  'environments',
];
const ignored = new Set(['node_modules', 'dist', 'artifacts', '__testdata__']);
const forbidden = [
  { pattern: /\bGemini\b/gi, reason: 'unsupported Gemini provider residue' },
  { pattern: /\bOpenClaw\b/gi, reason: 'unsupported OpenClaw provider residue' },
  { pattern: /\b(?:ElevenLabs|RevenueCat|PostHog)\b/gi, reason: 'retired commercial service residue' },
  { pattern: /mcp__happy__/g, reason: 'obsolete MCP namespace' },
  { pattern: /functions\.happy__change_title/g, reason: 'obsolete title-tool namespace' },
  { pattern: /packages\/happy-(?:cli|web|server|wire)/g, reason: 'obsolete package path' },
  { pattern: /bin\/happy-mcp/g, reason: 'obsolete MCP executable' },
];
const extensions = new Set(['.ts', '.tsx', '.js', '.jsx', '.cjs', '.mjs', '.sh']);

function filesBelow(path) {
  const result = [];
  for (const entry of readdirSync(path)) {
    if (ignored.has(entry)) continue;
    const absolute = join(path, entry);
    if (statSync(absolute).isDirectory()) result.push(...filesBelow(absolute));
    else if ([...extensions].some((extension) => entry.endsWith(extension))) result.push(absolute);
  }
  return result;
}

const violations = [];
for (const sourceRoot of sourceRoots) {
  const absoluteRoot = join(root, sourceRoot);
  if (!require('node:fs').existsSync(absoluteRoot)) continue;
  for (const file of filesBelow(absoluteRoot)) {
    const relativePath = relative(root, file);
    if (/(?:\.test|\.spec)\.[^.]+$/.test(relativePath) || relativePath.includes('/__fixtures__/')) continue;
    const contents = readFileSync(file, 'utf8');
    for (const rule of forbidden) {
      rule.pattern.lastIndex = 0;
      if (rule.pattern.test(contents)) {
        violations.push(`${relativePath}: ${rule.reason}`);
      }
    }
  }
}

if (violations.length > 0) {
  console.error(`Source-boundary check failed:\n${violations.map((item) => `- ${item}`).join('\n')}`);
  process.exit(1);
}

console.log('Source boundaries: Codex + Claude only; no obsolete executable paths.');
