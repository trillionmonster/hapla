const { execFileSync } = require('node:child_process');
const { lstatSync } = require('node:fs');
const { join } = require('node:path');

// Inspect source inputs, including new files, without traversing ignored runtime
// data, credentials, dependencies, or independent integration worktrees.
function repositoryFiles(root) {
  return [...new Set(execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  }).split('\0').filter(Boolean))].filter((file) => lstatSync(join(root, file), { throwIfNoEntry: false }));
}

module.exports = { repositoryFiles };
