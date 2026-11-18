import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { projectPath } from '@/projectPath';

export function fingerprintCliBuild(contents: string | Buffer): string {
  return createHash('sha256').update(contents).digest('hex');
}

/** Read the installed entrypoint on demand so same-version replacements are visible. */
export function readInstalledCliBuildFingerprint(): string | null {
  try {
    return fingerprintCliBuild(readFileSync(join(projectPath(), 'dist', 'index.mjs')));
  } catch {
    // A package manager may briefly replace the directory atomically. The
    // heartbeat retries later instead of restarting into an incomplete build.
    return null;
  }
}

export function daemonBuildMatches(
  state: { startedWithCliVersion: string; startedWithCliBuild?: string },
  installed: { version: string; build: string | null },
): boolean {
  return state.startedWithCliVersion === installed.version
    && typeof state.startedWithCliBuild === 'string'
    && installed.build !== null
    && state.startedWithCliBuild === installed.build;
}
