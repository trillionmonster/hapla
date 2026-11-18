import { logger } from '@/ui/logger';
import { spawnHaplaCLI } from '@/utils/spawnHaplaCLI';

const DEFAULT_HANDOFF_TIMEOUT_MS = 30_000;

interface ReplacementProcess {
  kill(signal?: NodeJS.Signals | number): boolean;
  once(event: 'error', listener: (error: Error) => void): unknown;
  once(
    event: 'exit',
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): unknown;
  unref(): void;
}
type ReplacementLauncher = () => ReplacementProcess;

export interface DaemonRestartHandoff {
  /**
   * Start one replacement attempt. The running daemon remains responsible for
   * serving requests until the replacement asks it to shut down over HTTP.
   */
  requestReplacement(): boolean;
  isReplacementPending(): boolean;
}

/**
 * Coordinate an upgrade without creating an availability gap.
 *
 * The replacement runs `daemon start-sync` directly. During startup it checks
 * the persisted build identity, asks the old daemon to stop, waits for that PID
 * to die, then acquires the daemon lock. If the installed entrypoint is missing
 * during a package-manager/build replacement, spawning throws or the child
 * exits; either way the old daemon stays alive and a later heartbeat can retry.
 */
export function createDaemonRestartHandoff(
  launchReplacement: ReplacementLauncher = () => spawnHaplaCLI(
    ['daemon', 'start-sync'],
    {
      detached: true,
      stdio: 'ignore',
      env: process.env,
    },
  ),
  timeoutMs = DEFAULT_HANDOFF_TIMEOUT_MS,
): DaemonRestartHandoff {
  let pendingProcess: ReplacementProcess | null = null;
  let pendingTimeout: ReturnType<typeof setTimeout> | null = null;

  const clearPending = (child: ReplacementProcess) => {
    if (pendingProcess !== child) {
      return;
    }

    pendingProcess = null;
    if (pendingTimeout) {
      clearTimeout(pendingTimeout);
      pendingTimeout = null;
    }
  };

  return {
    requestReplacement(): boolean {
      if (pendingProcess) {
        logger.debug('[DAEMON RUN] Replacement daemon handoff already pending');
        return false;
      }

      let child: ReplacementProcess;
      try {
        child = launchReplacement();
      } catch (error) {
        logger.debug(
          '[DAEMON RUN] Could not launch replacement daemon; keeping current daemon online until the next heartbeat',
          error,
        );
        return false;
      }

      pendingProcess = child;

      child.once('error', (error) => {
        logger.debug(
          '[DAEMON RUN] Replacement daemon failed to start; keeping current daemon online until the next heartbeat',
          error,
        );
        clearPending(child);
      });

      child.once('exit', (code, signal) => {
        logger.debug(
          `[DAEMON RUN] Replacement daemon exited before takeover (code=${code ?? 'null'}, signal=${signal ?? 'null'}); current daemon remains online`,
        );
        clearPending(child);
      });

      child.unref();

      pendingTimeout = setTimeout(() => {
        if (pendingProcess !== child) {
          return;
        }

        logger.debug(
          `[DAEMON RUN] Replacement daemon did not complete takeover within ${timeoutMs}ms; terminating it and keeping current daemon online`,
        );
        clearPending(child);
        try {
          child.kill('SIGTERM');
        } catch (error) {
          logger.debug('[DAEMON RUN] Failed to terminate timed-out replacement daemon', error);
        }
      }, timeoutMs);
      pendingTimeout.unref?.();

      logger.debug('[DAEMON RUN] Replacement daemon launched; current daemon will stay online until takeover is requested');
      return true;
    },

    isReplacementPending(): boolean {
      return pendingProcess !== null;
    },
  };
}
