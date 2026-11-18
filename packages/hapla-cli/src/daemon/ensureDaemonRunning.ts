import { logger } from '@/ui/logger'
import { isDaemonRunningCurrentlyInstalledHaplaVersion } from './controlClient'
import { spawnHaplaCLI } from '@/utils/spawnHaplaCLI'

export async function ensureDaemonRunning(): Promise<void> {
  logger.debug('Ensuring Hapla background service is running & matches our version...')

  if (await isDaemonRunningCurrentlyInstalledHaplaVersion()) {
    return
  }

  logger.debug('Starting Hapla background service...')

  const daemonProcess = spawnHaplaCLI(['daemon', 'start-sync'], {
    detached: true,
    stdio: 'ignore',
    env: process.env,
  })
  daemonProcess.unref()

  // Give daemon a moment to write PID & port file before first notification.
  await new Promise(resolve => setTimeout(resolve, 200))
}
