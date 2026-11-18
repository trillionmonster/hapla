import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import type { TrackedSession } from './types';
import { createTrackedSessionRegistry, sessionProcessFingerprint } from './trackedSessionRegistry';

const directories: string[] = [];
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'hapla-registry-'));
  directories.push(directory);
  const session: TrackedSession = {
    pid: 123,
    startedBy: 'daemon',
    haplaSessionId: 'original-session',
    haplaSessionMetadataFromLocalWebhook: {
      path: directory, host: 'test-host', hostPid: 123, machineId: 'machine',
      homeDir: directory, happyHomeDir: directory, happyLibDir: directory, happyToolsDir: join(directory, 'tools'), flavor: 'codex',
    },
  };
  return { directory, session, options: { directory, scope: 'account@server', machineId: 'machine' } };
}
afterEach(() => { for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }); });

describe('persisted daemon session ownership', () => {
  it('adopts the original worker after daemon replacement and retains continuation metadata', () => {
    const { options, session, directory } = fixture();
    const fingerprint = () => 'process-created-before-restart';
    createTrackedSessionRegistry({ ...options, fingerprint }).record(session);
    const replacement = createTrackedSessionRegistry({ ...options, fingerprint });
    const adopted = replacement.restore();
    expect(adopted).toMatchObject([{ haplaSessionId: 'original-session', pid: 123, haplaSessionMetadataFromLocalWebhook: { happyHomeDir: directory } }]);
    expect(replacement.isAlive(adopted[0])).toBe(true);
    if (process.platform !== 'win32') expect(statSync(join(directory, 'daemon.sessions.json')).mode & 0o777).toBe(0o600);
  });

  it('never adopts another account, machine or installation', () => {
    const { options, session } = fixture();
    const fingerprint = () => 'identity';
    createTrackedSessionRegistry({ ...options, fingerprint }).record(session);
    expect(createTrackedSessionRegistry({ ...options, scope: 'other-account@server', fingerprint }).restore()).toEqual([]);
    expect(createTrackedSessionRegistry({ ...options, machineId: 'other-machine', fingerprint }).restore()).toEqual([]);
    session.haplaSessionMetadataFromLocalWebhook!.happyHomeDir = '/somewhere-else';
    const registry = createTrackedSessionRegistry({ ...options, fingerprint });
    registry.record(session);
    expect(registry.restore()).toEqual([]);
  });

  it('drops dead workers and rejects PID reuse both at restart and before send', () => {
    const { options, session } = fixture();
    let identity: string | null = 'first-process';
    const fingerprint = () => identity;
    const registry = createTrackedSessionRegistry({ ...options, fingerprint });
    registry.record(session);
    identity = 'reused-pid';
    expect(registry.isAlive(session)).toBe(false);
    expect(createTrackedSessionRegistry({ ...options, fingerprint }).restore()).toEqual([]);
    identity = null;
    expect(registry.isAlive(session)).toBe(false);
  });

  it('does not reuse live webhook records from another machine or installation', () => {
    const { options, session } = fixture();
    const registry = createTrackedSessionRegistry({ ...options, fingerprint: () => 'live-process' });
    for (const overrides of [
      { machineId: 'another-machine' },
      { happyHomeDir: '/another-account-installation' },
      { hostPid: 456 },
    ]) {
      const foreign: TrackedSession = {
        ...session,
        haplaSessionMetadataFromLocalWebhook: {
          ...session.haplaSessionMetadataFromLocalWebhook!, ...overrides,
        },
      };
      registry.record(foreign);
      expect(registry.isAlive(foreign)).toBe(false);
    }
  });

  it('removes exited sessions durably and tolerates a damaged registry', () => {
    const { options, session, directory } = fixture();
    const fingerprint = () => 'identity';
    const registry = createTrackedSessionRegistry({ ...options, fingerprint });
    registry.record(session); registry.remove(session.pid);
    expect(createTrackedSessionRegistry({ ...options, fingerprint }).restore()).toEqual([]);
    const path = join(directory, 'daemon.sessions.json');
    expect(JSON.parse(readFileSync(path, 'utf8')).entries).toEqual([]);
    writeFileSync(path, '{partial');
    expect(createTrackedSessionRegistry({ ...options, fingerprint }).restore()).toEqual([]);
  });

  it('verifies an actual running worker and refuses it after exit without launching a model', async () => {
    const { options, session, directory } = fixture();
    mkdirSync(join(directory, 'dist'));
    const entry = join(directory, 'dist/index.mjs');
    writeFileSync(entry, 'process.stdout.write("ready\\n");setInterval(() => {}, 1000);');
    const child = spawn(process.execPath, [entry], { stdio: ['ignore', 'pipe', 'ignore'] });
    try {
      await once(child.stdout!, 'data');
      session.pid = child.pid!; session.haplaSessionMetadataFromLocalWebhook!.hostPid = child.pid;
      expect(sessionProcessFingerprint(session)).toMatch(/^[a-f0-9]{64}$/);
      createTrackedSessionRegistry(options).record(session);
      expect(createTrackedSessionRegistry(options).restore()).toHaveLength(1);
      const exited = once(child, 'exit'); child.kill('SIGTERM'); await exited;
      expect(sessionProcessFingerprint(session)).toBeNull();
      expect(createTrackedSessionRegistry(options).restore()).toEqual([]);
    } finally { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }
  });
});
