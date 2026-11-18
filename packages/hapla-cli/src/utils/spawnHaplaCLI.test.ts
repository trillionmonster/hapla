import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  existsSync: vi.fn(),
  loggerDebug: vi.fn(),
  spawn: vi.fn(),
}));

vi.mock('node:fs', () => ({
  existsSync: mocks.existsSync,
}));

vi.mock('child_process', () => ({
  spawn: mocks.spawn,
}));

vi.mock('@/projectPath', () => ({
  projectPath: () => '/installed/hapla',
}));

vi.mock('@/ui/logger', () => ({
  logger: { debug: mocks.loggerDebug },
}));

import { spawnHaplaCLI } from './spawnHaplaCLI';

describe('spawnHaplaCLI', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.existsSync.mockReturnValue(true);
    mocks.spawn.mockReturnValue({});
  });

  it('reuses the current runtime when the daemon PATH cannot resolve node', () => {
    const minimalPath = '/usr/bin:/bin';

    spawnHaplaCLI(['daemon', 'start-sync'], {
      detached: true,
      env: { PATH: minimalPath },
    });

    expect(mocks.spawn).toHaveBeenCalledWith(
      process.execPath,
      [
        '--no-warnings',
        '--no-deprecation',
        '/installed/hapla/dist/index.mjs',
        'daemon',
        'start-sync',
      ],
      {
        windowsHide: true,
        detached: true,
        env: { PATH: minimalPath },
      },
    );
  });

  it('fails synchronously while the installed entrypoint is temporarily absent', () => {
    mocks.existsSync.mockReturnValue(false);

    expect(() => spawnHaplaCLI(['daemon', 'start-sync'])).toThrow(
      'Entrypoint /installed/hapla/dist/index.mjs does not exist',
    );
    expect(mocks.spawn).not.toHaveBeenCalled();
  });
});
