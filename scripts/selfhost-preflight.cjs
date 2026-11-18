#!/usr/bin/env node

// Compatibility entry point; the maintained implementation is shared with deploy.sh.
require('./selfhost.cjs').main(['preflight', ...process.argv.slice(2)])
  .catch((error) => { console.error(`Hapla: ${error.message}`); process.exitCode = 1; });
