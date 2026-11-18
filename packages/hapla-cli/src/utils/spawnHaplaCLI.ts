/**
 * Cross-platform Hapla CLI spawning utility
 * 
 * ## Background
 * 
 * We built a command-line JavaScript program with the entrypoint at `dist/index.mjs`.
 * This needs to be run with `node`, but we want to hide deprecation warnings and other 
 * noise from end users by passing specific flags: `--no-warnings --no-deprecation`.
 * 
 * Child processes execute `dist/index.mjs` through the active JavaScript
 * runtime. This avoids shell and shebang differences across platforms:
 * 
 * `spawn(process.execPath, ['--no-warnings', '--no-deprecation', 'dist/index.mjs', ...args])`
 * 
 * This works on all platforms and achieves the same result without any of the 
 * middleman steps that were providing workarounds for Windows vs Linux differences.
 */

import { spawn, SpawnOptions, type ChildProcess } from 'child_process';
import { join } from 'node:path';
import { projectPath } from '@/projectPath';
import { logger } from '@/ui/logger';
import { existsSync } from 'node:fs';

/**
 * Spawn the Hapla CLI with the given arguments in a cross-platform way.
 * 
 * This function spawns the actual CLI entrypoint directly, ensuring
 * compatibility across all platforms including Windows.
 * 
 * @param args - Arguments to pass to the Hapla CLI
 * @param options - Spawn options (same as child_process.spawn)
 * @returns ChildProcess instance
 */
export function spawnHaplaCLI(args: string[], options: SpawnOptions = {}): ChildProcess {
  const projectRoot = projectPath();
  const entrypoint = join(projectRoot, 'dist', 'index.mjs');

  let directory: string | URL | undefined;
  if ('cwd' in options) {
    directory = options.cwd
  } else {
    directory = process.cwd()
  }
  // Note: We're executing the active runtime with the calculated entrypoint path below.
  const fullCommand = `hapla ${args.join(' ')}`;
  logger.debug(`[SPAWN HAPLA CLI] Spawning: ${fullCommand} in ${directory}`);
  
  // Use the same Node.js flags that the wrapper script uses
  const nodeArgs = [
    '--no-warnings',
    '--no-deprecation',
    entrypoint,
    ...args
  ];

  // Sanity check of the entrypoint path exists
  if (!existsSync(entrypoint)) {
    const errorMessage = `Entrypoint ${entrypoint} does not exist`;
    logger.debug(`[SPAWN HAPLA CLI] ${errorMessage}`);
    throw new Error(errorMessage);
  }
  
  // Reuse the exact runtime executable that launched this process. Daemons may
  // run with a minimal launchd/systemd PATH that cannot resolve `node` or `bun`.
  return spawn(process.execPath, nodeArgs, {
    windowsHide: true,
    ...options,
  });
}
