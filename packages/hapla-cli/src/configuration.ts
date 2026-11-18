/**
 * Global configuration for Hapla CLI.
 * 
 * Centralizes all configuration including environment variables and paths
 * Environment files should be loaded using Node's --env-file flag
 */

import { existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import packageJson from '../package.json'

export type HaplaEnvironment = NodeJS.ProcessEnv

export function resolveServerUrl(env: HaplaEnvironment = process.env): string {
  // The self-hosted Web entrypoint proxies both HTTP and Socket.IO traffic to
  // this project's server. Using it as the CLI default keeps the browser and
  // daemon on the same deployment and avoids accidentally attaching to an
  // unrelated service that happens to own host port 3005.
  return env.HAPLA_SERVER_URL || 'http://127.0.0.1:12345'
}

export function resolveWebappUrl(env: HaplaEnvironment = process.env): string {
  return env.HAPLA_WEBAPP_URL || 'http://127.0.0.1:12345'
}

/** The operator can scope machine file and terminal RPCs to a mounted workspace. */
export function resolveMachineWorkspaceRoot(env: HaplaEnvironment = process.env): string {
  const root = env.HAPLA_WORKSPACE_ROOT?.trim()
  if (!root) return homedir()
  if (!isAbsolute(root)) throw new Error('HAPLA_WORKSPACE_ROOT must be an absolute path')
  return resolve(root)
}

class Configuration {
  public readonly serverUrl: string
  public readonly webappUrl: string
  public readonly isDaemonProcess: boolean

  // Directories and paths (from persistence)
  public readonly haplaHomeDir: string
  public readonly logsDir: string
  public readonly settingsFile: string
  public readonly privateKeyFile: string
  public readonly daemonStateFile: string
  public readonly daemonLockFile: string
  public readonly currentCliVersion: string

  public readonly isExperimentalEnabled: boolean
  public readonly disableCaffeinate: boolean

  constructor() {
    // Server configuration - priority: parameter > environment > default
    this.serverUrl = resolveServerUrl()
    this.webappUrl = resolveWebappUrl()

    // Check if we're running as daemon based on process args
    const args = process.argv.slice(2)
    this.isDaemonProcess = args.length >= 2 && args[0] === 'daemon' && (args[1] === 'start-sync')

    const configuredHome = process.env.HAPLA_HOME_DIR
    if (configuredHome) {
      // Expand ~ to home directory if present
      const expandedPath = configuredHome.replace(/^~/, homedir())
      this.haplaHomeDir = expandedPath
    } else {
      this.haplaHomeDir = join(homedir(), '.hapla')
    }

    this.logsDir = join(this.haplaHomeDir, 'logs')
    this.settingsFile = join(this.haplaHomeDir, 'settings.json')
    this.privateKeyFile = join(this.haplaHomeDir, 'access.key')
    this.daemonStateFile = join(this.haplaHomeDir, 'daemon.state.json')
    this.daemonLockFile = join(this.haplaHomeDir, 'daemon.state.json.lock')

    this.isExperimentalEnabled = ['true', '1', 'yes'].includes(process.env.HAPLA_EXPERIMENTAL?.toLowerCase() || '');
    this.disableCaffeinate = ['true', '1', 'yes'].includes(process.env.HAPLA_DISABLE_CAFFEINATE?.toLowerCase() || '');

    this.currentCliVersion = packageJson.version

    // Visual indicator on CLI startup (only if not daemon process to avoid log clutter)
    const variant = process.env.HAPLA_VARIANT || 'stable'
    if (!this.isDaemonProcess && variant === 'dev') {
      console.log('\x1b[33m🔧 DEV MODE\x1b[0m - Data: ' + this.haplaHomeDir)
    }

    if (!existsSync(this.haplaHomeDir)) {
      mkdirSync(this.haplaHomeDir, { recursive: true })
    }
    // Ensure directories exist
    if (!existsSync(this.logsDir)) {
      mkdirSync(this.logsDir, { recursive: true })
    }
  }
}

export const configuration: Configuration = new Configuration()
