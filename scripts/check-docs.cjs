#!/usr/bin/env node

const { readFileSync } = require('node:fs');
const { dirname, join, relative, resolve } = require('node:path');
const { repositoryFiles } = require('./lib/repository-files.cjs');

const root = resolve(__dirname, '..');
const inputs = repositoryFiles(root);
const visiblePaths = new Set(inputs);
for (const file of inputs) {
  let directory = dirname(file);
  while (directory !== '.') {
    visiblePaths.add(directory);
    directory = dirname(directory);
  }
}
const files = inputs.filter((file) => file.endsWith('.md') && !file.startsWith('docs/archive/'));
const problems = [];

for (const file of files) {
  const source = readFileSync(join(root, file), 'utf8')
    .replace(/^[ \t]*```[^\n]*\n[\s\S]*?^[ \t]*```[^\n]*$/gm, '')
    .replace(/^[ \t]*~~~[^\n]*\n[\s\S]*?^[ \t]*~~~[^\n]*$/gm, '')
    .replace(/`[^`\n]*`/g, '');
  for (const match of source.matchAll(/!?\[[^\]\n]*\]\(<?([^\s)>]+)>?(?:\s+"[^"]*")?\)/g)) {
    const url = match[1];
    if (/^(?:[a-z][a-z\d+.-]*:|#|\/)/i.test(url)) continue;
    let path;
    try { path = decodeURIComponent(url.split(/[?#]/, 1)[0]); }
    catch { problems.push(`${file}: invalid link encoding: ${url}`); continue; }
    if (!path) continue;
    const target = relative(root, resolve(root, dirname(file), path));
    if (!visiblePaths.has(target)) problems.push(`${file}: link target is not a repository input: ${url}`);
  }
}

if (problems.length) {
  console.error(`Documentation check failed:\n${problems.map((problem) => `- ${problem}`).join('\n')}`);
  process.exit(1);
}
console.log(`Documentation: relative file links verified in ${files.length} current Markdown files.`);
