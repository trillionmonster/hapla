import { execSync } from 'child_process';
import { accessSync, constants } from 'node:fs';
import os from 'os';

export interface CLIAvailability {
  claude: boolean;
  codex: boolean;
  detectedAt: number;
}

/**
 * Detects which CLI tools are available on this machine.
 * Cross-platform: uses `command -v` on POSIX, `Get-Command` on Windows.
 */
export function detectCLIAvailability(): CLIAvailability {
  const isWindows = os.platform() === 'win32';

  if (isWindows) {
    return detectWindows();
  }
  return detectPosix();
}

function commandExists(command: string): boolean {
  try {
    execSync(`command -v ${command} >/dev/null 2>&1`, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

export function executableOverrideExists(path: string | undefined): boolean {
  const candidate = path?.trim();
  if (!candidate) return false;
  try {
    accessSync(candidate, constants.F_OK | constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function detectPosix(): CLIAvailability {
  const claude = commandExists('claude');
  const codex = process.env.HAPLA_CODEX_PATH?.trim()
    ? executableOverrideExists(process.env.HAPLA_CODEX_PATH)
    : commandExists('codex');
  return { claude, codex, detectedAt: Date.now() };
}

function detectWindows(): CLIAvailability {
  const checkCommand = (name: string): boolean => {
    try {
      execSync(`powershell -NoProfile -Command "Get-Command ${name} -ErrorAction SilentlyContinue"`, { stdio: 'ignore', windowsHide: true });
      return true;
    } catch {
      return false;
    }
  };

  const claude = checkCommand('claude');
  const codex = process.env.HAPLA_CODEX_PATH?.trim()
    ? executableOverrideExists(process.env.HAPLA_CODEX_PATH)
    : checkCommand('codex');
  return { claude, codex, detectedAt: Date.now() };
}
