const { execSync } = require('child_process');

// Apply patches to node_modules
require('../patches/fix-pglite-prisma-bytes.cjs');
require('../patches/fix-noble-hashes-exports.cjs');
require('../patches/fix-unistyles-web-ref.cjs');
require('../patches/fix-unistyles-web-pressable.cjs');

if (process.env.SKIP_HAPLA_WIRE_BUILD === '1') {
  console.log('[postinstall] SKIP_HAPLA_WIRE_BUILD=1, skipping @hapla/wire build');
  process.exit(0);
}

execSync('pnpm --filter @hapla/wire build', {
  stdio: 'inherit',
});
