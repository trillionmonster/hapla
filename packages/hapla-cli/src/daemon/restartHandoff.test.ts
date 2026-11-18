import { EventEmitter } from 'node:events';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  loggerDebug: vi.fn(),
  spawnHaplaCLI: vi.fn(),
}));

vi.mock('@/ui/logger', () => ({
  logger: { debug: mocks.loggerDebug },
}));

vi.mock('@/utils/spawnHaplaCLI', () => ({
  spawnHaplaCLI: mocks.spawnHaplaCLI,
}));

import { createDaemonRestartHandoff } from './restartHandoff';

class FakeReplacementProcess extends EventEmitter {
  readonly kill = vi.fn(() => true);
  readonly unref = vi.fn();
}

describe('daemon restart handoff', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('launches the replacement daemon directly and keeps one handoff in flight', () => {
    const child = new FakeReplacementProcess();
    mocks.spawnHaplaCLI.mockReturnValue(child);
    const handoff = createDaemonRestartHandoff();

    expect(handoff.requestReplacement()).toBe(true);
    expect(handoff.isReplacementPending()).toBe(true);
    expect(mocks.spawnHaplaCLI).toHaveBeenCalledWith(['daemon', 'start-sync'], {
      detached: true,
      stdio: 'ignore',
      env: process.env,
    });
    expect(child.unref).toHaveBeenCalledOnce();

    expect(handoff.requestReplacement()).toBe(false);
    expect(mocks.spawnHaplaCLI).toHaveBeenCalledOnce();
  });

  it('keeps the current daemon available and permits a retry when dist is temporarily absent', () => {
    const entrypointMissing = new Error('Entrypoint dist/index.mjs does not exist');
    const replacement = new FakeReplacementProcess();
    const launch = vi.fn()
      .mockImplementationOnce(() => { throw entrypointMissing; })
      .mockReturnValueOnce(replacement);
    const handoff = createDaemonRestartHandoff(launch);

    expect(handoff.requestReplacement()).toBe(false);
    expect(handoff.isReplacementPending()).toBe(false);
    expect(replacement.kill).not.toHaveBeenCalled();

    expect(handoff.requestReplacement()).toBe(true);
    expect(handoff.isReplacementPending()).toBe(true);
    expect(launch).toHaveBeenCalledTimes(2);
    expect(mocks.loggerDebug).toHaveBeenCalledWith(
      expect.stringContaining('keeping current daemon online'),
      entrypointMissing,
    );
  });

  it('permits the next heartbeat to retry after a replacement exits before takeover', () => {
    const first = new FakeReplacementProcess();
    const second = new FakeReplacementProcess();
    const launch = vi.fn()
      .mockReturnValueOnce(first)
      .mockReturnValueOnce(second);
    const handoff = createDaemonRestartHandoff(launch);

    expect(handoff.requestReplacement()).toBe(true);
    first.emit('exit', 1, null);

    expect(handoff.isReplacementPending()).toBe(false);
    expect(handoff.requestReplacement()).toBe(true);
    expect(launch).toHaveBeenCalledTimes(2);
  });

  it('terminates a hung replacement without terminating the current daemon', () => {
    vi.useFakeTimers();
    const exitCurrentDaemon = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const replacement = new FakeReplacementProcess();
    const handoff = createDaemonRestartHandoff(() => replacement, 5_000);

    expect(handoff.requestReplacement()).toBe(true);
    vi.advanceTimersByTime(5_000);

    expect(replacement.kill).toHaveBeenCalledWith('SIGTERM');
    expect(exitCurrentDaemon).not.toHaveBeenCalled();
    expect(handoff.isReplacementPending()).toBe(false);

    exitCurrentDaemon.mockRestore();
    vi.useRealTimers();
  });
});
