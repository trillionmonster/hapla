import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { TrackedSession } from './types';

type SavedSession = {
  pid: number;
  haplaSessionId: string;
  haplaSessionMetadataFromLocalWebhook: NonNullable<TrackedSession['haplaSessionMetadataFromLocalWebhook']>;
  fingerprint: string;
};

/** A PID alone is not an identity: the OS may reuse it after a session exits. */
export function sessionProcessFingerprint(session: TrackedSession): string | null {
  const metadata = session.haplaSessionMetadataFromLocalWebhook;
  if (!Number.isSafeInteger(session.pid) || session.pid <= 0 || metadata?.hostPid !== session.pid || !metadata.happyLibDir) return null;
  try {
    let identity: string;
    let command: string;
    if (process.platform === 'linux') {
      const stat = readFileSync(`/proc/${session.pid}/stat`, 'utf8');
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      if (fields[0] === 'Z') return null;
      identity = `${readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim()}:${fields[19]}`;
      command = readFileSync(`/proc/${session.pid}/cmdline`, 'utf8').replaceAll('\0', ' ');
    } else if (process.platform === 'win32') {
      const output = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        `$p = Get-CimInstance Win32_Process -Filter "ProcessId = ${session.pid}"; if ($p) { @{ start = $p.CreationDate.Ticks; command = $p.CommandLine } | ConvertTo-Json -Compress }`,
      ], { encoding: 'utf8', timeout: 3_000, stdio: ['ignore', 'pipe', 'ignore'] });
      const value = JSON.parse(output);
      identity = String(value.start);
      command = value.command;
    } else {
      identity = execFileSync('ps', ['-p', String(session.pid), '-o', 'lstart='], { encoding: 'utf8', timeout: 2_000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      command = execFileSync('ps', ['-ww', '-p', String(session.pid), '-o', 'command='], { encoding: 'utf8', timeout: 2_000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    }
    const normalized = command.replaceAll('\\', '/');
    const library = metadata.happyLibDir.replaceAll('\\', '/').replace(/\/+$/, '');
    if (!identity || !normalized.includes(`${library}/dist/index.mjs`) || /\bdaemon\s+start/.test(normalized)) return null;
    return createHash('sha256').update(identity).update('\0').update(command).digest('hex');
  } catch {
    return null;
  }
}

/** Keep live workers across daemon upgrades without adopting another account,
 * installation, or a different process that happens to reuse the same PID. */
export function createTrackedSessionRegistry(options: {
  directory: string;
  scope: string;
  machineId: string;
  fingerprint?: (session: TrackedSession) => string | null;
  onError?: (error: unknown) => void;
}) {
  const path = join(options.directory, 'daemon.sessions.json');
  const fingerprint = options.fingerprint ?? sessionProcessFingerprint;
  const saved = new Map<number, SavedSession>();
  const owned = (session: TrackedSession) => (
    session.haplaSessionMetadataFromLocalWebhook?.machineId === options.machineId
    && session.haplaSessionMetadataFromLocalWebhook?.happyHomeDir === options.directory
    && session.haplaSessionMetadataFromLocalWebhook?.hostPid === session.pid
  );
  const persist = () => {
    const temporary = `${path}.${process.pid}.tmp`;
    try {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      writeFileSync(temporary, JSON.stringify({ version: 1, scope: options.scope, entries: [...saved.values()] }), { mode: 0o600 });
      renameSync(temporary, path);
    } catch (error) {
      options.onError?.(error);
      try { unlinkSync(temporary); } catch { /* already absent */ }
    }
  };
  return {
    restore(): TrackedSession[] {
      if (!existsSync(path)) return [];
      try {
        const data = JSON.parse(readFileSync(path, 'utf8'));
        if (data.version !== 1 || data.scope !== options.scope || !Array.isArray(data.entries)) return [];
        for (const entry of data.entries) {
          if (!entry || typeof entry.haplaSessionId !== 'string' || typeof entry.fingerprint !== 'string') continue;
          const session = { ...entry, startedBy: 'adopted after daemon restart' };
          if (owned(session) && fingerprint(session) === entry.fingerprint) saved.set(entry.pid, entry);
        }
        persist();
        return [...saved.values()].map(({ fingerprint: _fingerprint, ...session }) => ({ ...session, startedBy: 'adopted after daemon restart' }));
      } catch (error) {
        options.onError?.(error);
        return [];
      }
    },
    record(session: TrackedSession): boolean {
      if (!session.haplaSessionId || !session.haplaSessionMetadataFromLocalWebhook || !owned(session)) return false;
      const identity = fingerprint(session);
      if (!identity) return false;
      saved.set(session.pid, {
        pid: session.pid,
        haplaSessionId: session.haplaSessionId,
        haplaSessionMetadataFromLocalWebhook: session.haplaSessionMetadataFromLocalWebhook,
        fingerprint: identity,
      });
      persist();
      return true;
    },
    isAlive(session: TrackedSession): boolean {
      if (!owned(session)) return false;
      const identity = fingerprint(session);
      const known = saved.get(session.pid);
      return Boolean(identity && (!known || known.fingerprint === identity));
    },
    remove(pid: number): void {
      if (saved.delete(pid)) persist();
    },
  };
}
