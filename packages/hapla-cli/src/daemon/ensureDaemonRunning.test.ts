import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  mockLoggerDebug: vi.fn(),
  mockIsDaemonRunningCurrentlyInstalledHaplaVersion: vi.fn(),
  mockSpawnHaplaCLI: vi.fn(),
}))

vi.mock('@/ui/logger', () => ({
  logger: {
    debug: mocks.mockLoggerDebug,
  },
}))

vi.mock('./controlClient', () => ({
  isDaemonRunningCurrentlyInstalledHaplaVersion: mocks.mockIsDaemonRunningCurrentlyInstalledHaplaVersion,
}))

vi.mock('@/utils/spawnHaplaCLI', () => ({
  spawnHaplaCLI: mocks.mockSpawnHaplaCLI,
}))

import { ensureDaemonRunning } from './ensureDaemonRunning'

describe('ensureDaemonRunning', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.mockSpawnHaplaCLI.mockReturnValue({
      unref: vi.fn(),
    })
  })

  it('returns without spawning when the daemon is already running', async () => {
    mocks.mockIsDaemonRunningCurrentlyInstalledHaplaVersion.mockResolvedValue(true)

    await ensureDaemonRunning()

    expect(mocks.mockSpawnHaplaCLI).not.toHaveBeenCalled()
    expect(mocks.mockLoggerDebug).toHaveBeenCalledWith(
      'Ensuring Hapla background service is running & matches our version...',
    )
  })

  it('starts the daemon when the installed version is not running', async () => {
    const mockUnref = vi.fn()
    mocks.mockIsDaemonRunningCurrentlyInstalledHaplaVersion.mockResolvedValue(false)
    mocks.mockSpawnHaplaCLI.mockReturnValue({
      unref: mockUnref,
    })

    await ensureDaemonRunning()

    expect(mocks.mockSpawnHaplaCLI).toHaveBeenCalledWith(['daemon', 'start-sync'], {
      detached: true,
      stdio: 'ignore',
      env: process.env,
    })
    expect(mockUnref).toHaveBeenCalled()
    expect(mocks.mockLoggerDebug).toHaveBeenCalledWith('Starting Hapla background service...')
  })
})
