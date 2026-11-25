import { saveRuntimeLaunchSpec } from '@/resume/runtimeLaunchSpec';
import fs from 'fs/promises';
import os from 'os';
import * as tmp from 'tmp';

import { ApiClient } from '@/api/api';
import { TrackedSession } from './types';
import { MachineMetadata, DaemonState, Metadata } from '@/api/types';
import { SpawnSessionOptions, SpawnSessionResult } from '@/modules/common/registerCommonHandlers';
import { logger } from '@/ui/logger';
import { authAndSetupMachineIfNeeded } from '@/ui/auth';
import { configuration } from '@/configuration';
import { startCaffeinate, stopCaffeinate } from '@/utils/caffeinate';
import packageJson from '../../package.json';
import { getEnvironmentInfo } from '@/ui/doctor';
import { spawnHaplaCLI } from '@/utils/spawnHaplaCLI';
import { writeDaemonState, DaemonLocallyPersistedState, readDaemonState, acquireDaemonLock, releaseDaemonLock } from '@/persistence';

import { cleanupDaemonState, isDaemonRunningCurrentlyInstalledHaplaVersion, stopDaemon } from './controlClient';
import { startDaemonControlServer } from './controlServer';
import { readFileSync } from 'fs';
import { join } from 'path';
import { projectPath } from '@/projectPath';
import { getTmuxUtilities, isTmuxAvailable, parseTmuxSessionIdentifier, formatTmuxSessionIdentifier } from '@/utils/tmux';
import { expandEnvironmentVariables } from '@/utils/expandEnvVars';
import { detectCLIAvailability } from '@/utils/detectCLI';
import { buildTransparentContinuationLaunch } from '@/resume/handleResumeCommand';
import { detectResumeSupport } from '@/resume/localHaplaAgentAuth';
import { detectCodexVersion, discoverCodexCapabilities } from '@/codex/modelDiscovery';
import { detectClaudeVersion, discoverClaudeCapabilities } from '@/claude/capabilityDiscovery';
import { readInstalledCliBuildFingerprint } from './cliBuildFingerprint';
import { createDaemonRestartHandoff } from './restartHandoff';
import { createTrackedSessionRegistry } from './trackedSessionRegistry';
import { createHash } from 'node:crypto';
import { prepareSessionDirectory } from './prepareSessionDirectory';

// Prepare initial metadata
// Suffix host with `-dev` for the HAPLA_VARIANT=dev variant so the dev daemon
// is visually distinct from the stable one in the machine list (they otherwise
// share the same hostname and look identical).
const hostSuffix = process.env.HAPLA_VARIANT === 'dev' ? '-dev' : '';
export const initialMachineMetadata: MachineMetadata = {
  host: os.hostname() + hostSuffix,
  platform: os.platform(),
  happyCliVersion: packageJson.version,
  homeDir: os.homedir(),
  happyHomeDir: configuration.haplaHomeDir,
  happyLibDir: projectPath(),
  cliAvailability: detectCLIAvailability(),
  resumeSupport: detectResumeSupport(),
};

export async function startDaemon(): Promise<void> {
  const startedWithCliBuild = readInstalledCliBuildFingerprint();
  const restartHandoff = createDaemonRestartHandoff();
  // We don't have cleanup function at the time of server construction
  // Control flow is:
  // 1. Create promise that will resolve when shutdown is requested
  // 2. Setup signal handlers to resolve this promise with the source of the shutdown
  // 3. Once our setup is complete - if all goes well - we await this promise
  // 4. When it resolves we can cleanup and exit
  //
  // In case the setup malfunctions - our signal handlers will not properly
  // shut down. We will force exit the process with code 1.
  let requestShutdown: (source: 'hapla-app' | 'hapla-cli' | 'os-signal' | 'exception', errorMessage?: string) => void;
  let resolvesWhenShutdownRequested = new Promise<({ source: 'hapla-app' | 'hapla-cli' | 'os-signal' | 'exception', errorMessage?: string })>((resolve) => {
    requestShutdown = (source, errorMessage) => {
      logger.debug(`[DAEMON RUN] Requesting shutdown (source: ${source}, errorMessage: ${errorMessage})`);

      // Fallback - in case startup malfunctions - we will force exit the process with code 1
      setTimeout(async () => {
        logger.debug('[DAEMON RUN] Startup malfunctioned, forcing exit with code 1');

        // Give time for logs to be flushed
        await new Promise(resolve => setTimeout(resolve, 100))

        process.exit(1);
      }, 1_000);

      // Start graceful shutdown
      resolve({ source, errorMessage });
    };
  });

  // Setup signal handlers
  process.on('SIGINT', () => {
    logger.debug('[DAEMON RUN] Received SIGINT');
    requestShutdown('os-signal');
  });

  process.on('SIGTERM', () => {
    logger.debug('[DAEMON RUN] Received SIGTERM');
    requestShutdown('os-signal');
  });

  process.on('uncaughtException', (error) => {
    logger.debug('[DAEMON RUN] FATAL: Uncaught exception', error);
    logger.debug(`[DAEMON RUN] Stack trace: ${error.stack}`);
    requestShutdown('exception', error.message);
  });

  process.on('unhandledRejection', (reason, promise) => {
    logger.debug('[DAEMON RUN] FATAL: Unhandled promise rejection', reason);
    logger.debug(`[DAEMON RUN] Rejected promise:`, promise);
    const error = reason instanceof Error ? reason : new Error(`Unhandled promise rejection: ${reason}`);
    logger.debug(`[DAEMON RUN] Stack trace: ${error.stack}`);
    requestShutdown('exception', error.message);
  });

  process.on('exit', (code) => {
    logger.debug(`[DAEMON RUN] Process exiting with code: ${code}`);
  });

  process.on('beforeExit', (code) => {
    logger.debug(`[DAEMON RUN] Process about to exit with code: ${code}`);
  });

  logger.debug('[DAEMON RUN] Starting daemon process...');
  logger.debugLargeJson('[DAEMON RUN] Environment', getEnvironmentInfo());

  // Check if already running
  // Check if running daemon version matches current CLI version
  const runningDaemonVersionMatches = await isDaemonRunningCurrentlyInstalledHaplaVersion();
  if (!runningDaemonVersionMatches) {
    // TODO: This hand-rolled self-restart path is awkward to reason about and awkward to test.
    // We should probably migrate this daemon to native system service management
    // (launchd/systemd), so startup/start-at-login and upgrades
    // are owned by the OS instead of by the daemon trying to replace itself in-process.
    logger.debug('[DAEMON RUN] Daemon version mismatch detected, restarting daemon with current CLI version');
    await stopDaemon();
  } else {
    logger.debug('[DAEMON RUN] Daemon version matches, keeping existing daemon');
    console.log('Daemon already running with matching version');
    process.exit(0);
  }

  // Acquire exclusive lock (proves daemon is running)
  const daemonLockHandle = await acquireDaemonLock(5, 200);
  if (!daemonLockHandle) {
    logger.debug('[DAEMON RUN] Daemon lock file already held, another daemon is running');
    process.exit(0);
  }

  // At this point we should be safe to startup the daemon:
  // 1. Not have a stale daemon state
  // 2. Should not have another daemon process running

  try {
    // Start caffeinate
    const caffeinateStarted = startCaffeinate();
    if (caffeinateStarted) {
      logger.debug('[DAEMON RUN] Sleep prevention enabled');
    }

    // Ensure auth and machine registration BEFORE anything else
    const { credentials, machineId } = await authAndSetupMachineIfNeeded();
    logger.debug('[DAEMON RUN] Auth and machine setup complete');

    // Setup state - key by PID
    const pidToTrackedSession = new Map<number, TrackedSession>();
    const sessionRegistry = createTrackedSessionRegistry({
      directory: configuration.haplaHomeDir,
      machineId,
      scope: createHash('sha256').update(configuration.serverUrl).update('\0').update(credentials.token).digest('hex'),
      onError: (error) => logger.debug('[DAEMON RUN] Failed to persist/restore tracked sessions', error),
    });
    for (const session of sessionRegistry.restore()) pidToTrackedSession.set(session.pid, session);
    logger.debug(`[DAEMON RUN] Adopted ${pidToTrackedSession.size} existing sessions after restart`);

    // Session spawning awaiter system
    const pidToAwaiter = new Map<number, (result: SpawnSessionResult) => void>();

    // A resume request can be emitted by more than one browser tab. Coalesce those
    // requests so one backend conversation never fans out into duplicate CLIs.
    const resumeInFlight = new Map<string, Promise<SpawnSessionResult>>();

    const resumeIdentity = (
      sessionId: string,
      metadata: Pick<Metadata, 'flavor' | 'codexThreadId' | 'claudeSessionId' | 'conversationRootSessionId'>,
    ) => `${metadata.flavor}:${metadata.conversationRootSessionId || sessionId}`;

    // Helper functions
    const getCurrentChildren = () => Array.from(pidToTrackedSession.values());

    // Handle a webhook from a Hapla session reporting itself.
    const onHaplaSessionWebhook = (sessionId: string, sessionMetadata: Metadata) => {
      logger.debugLargeJson(`[DAEMON RUN] Session reported`, sessionMetadata);

      const pid = sessionMetadata.hostPid;
      if (!pid) {
        logger.debug(`[DAEMON RUN] Session webhook missing hostPid for sessionId: ${sessionId}`);
        return;
      }

      logger.debug(`[DAEMON RUN] Session webhook: ${sessionId}, PID: ${pid}, started by: ${sessionMetadata.startedBy || 'unknown'}`);
      logger.debug(`[DAEMON RUN] Current tracked sessions before webhook: ${Array.from(pidToTrackedSession.keys()).join(', ')}`);

      // Check if we already have this PID (daemon-spawned)
      const existingSession = pidToTrackedSession.get(pid);
      if (existingSession?.haplaSessionId && existingSession.haplaSessionId !== sessionId) {
        throw new Error('Process is already registered to another session');
      }
      if (!sessionRegistry.record({
        pid,
        haplaSessionId: sessionId,
        haplaSessionMetadataFromLocalWebhook: sessionMetadata,
        startedBy: existingSession?.startedBy ?? 'external',
      })) {
        throw new Error('Session process does not belong to this daemon installation');
      }

      if (existingSession && existingSession.startedBy === 'daemon') {
        // Update daemon-spawned session with reported data
        existingSession.haplaSessionId = sessionId;
        existingSession.haplaSessionMetadataFromLocalWebhook = sessionMetadata;
        logger.debug(`[DAEMON RUN] Updated daemon-spawned session ${sessionId} with metadata`);

        // Resolve any awaiter for this PID
        const awaiter = pidToAwaiter.get(pid);
        if (awaiter) {
          pidToAwaiter.delete(pid);
          awaiter({ type: 'success', sessionId });
          logger.debug(`[DAEMON RUN] Resolved session awaiter for PID ${pid}`);
        }
      } else if (!existingSession) {
        // New session started externally
        const trackedSession: TrackedSession = {
          startedBy: 'hapla directly - likely by user from terminal',
          haplaSessionId: sessionId,
          haplaSessionMetadataFromLocalWebhook: sessionMetadata,
          pid
        };
        pidToTrackedSession.set(pid, trackedSession);
        logger.debug(`[DAEMON RUN] Registered externally-started session ${sessionId}`);
      } else if (existingSession.haplaSessionId === sessionId) {
        existingSession.haplaSessionMetadataFromLocalWebhook = sessionMetadata;
      }
    };

    // Spawn a new session (sessionId reserved for future --resume functionality)
    const spawnSession = async (options: SpawnSessionOptions): Promise<SpawnSessionResult> => {
      logger.debug('[DAEMON RUN] Spawning session', { agent: options.agent, directory: options.directory, environmentKeys: Object.keys(options.environmentVariables ?? {}) });

      const { sessionId, machineId, approvedNewDirectoryCreation = true } = options;
      const prepared = await prepareSessionDirectory(options.directory, approvedNewDirectoryCreation);
      if (prepared.type !== 'ready') return prepared;
      const directory = prepared.directory;
      const directoryCreated = prepared.created;

      try {

        // Build environment variables for session spawning
        // Authentication tokens are resolved here

        // Resolve authentication token if provided
        const authEnv: Record<string, string> = {};
        if (options.token) {
          if (options.agent === 'codex') {

            // Create a temporary directory for Codex
            const codexHomeDir = tmp.dirSync();

            // Write the token to the temporary directory
            await fs.writeFile(join(codexHomeDir.name, 'auth.json'), options.token);

            // Set the environment variable for Codex
            authEnv.CODEX_HOME = codexHomeDir.name;
          } else { // Assuming claude
            authEnv.CLAUDE_CODE_OAUTH_TOKEN = options.token;
          }
        }

        let extraEnv = {
          ...authEnv,
          ...(options.environmentVariables ?? {}),
        };
        logger.debug(`[DAEMON RUN] Environment variable keys (before expansion) (${Object.keys(extraEnv).length}): ${Object.keys(extraEnv).join(', ')}`);

        // Expand ${VAR} references from daemon's process.env
        // This ensures variable substitution works in both tmux and non-tmux modes
        // Example: ANTHROPIC_AUTH_TOKEN="${Z_AI_AUTH_TOKEN}" → ANTHROPIC_AUTH_TOKEN="sk-real-key"
        extraEnv = expandEnvironmentVariables(extraEnv, process.env);
        logger.debug(`[DAEMON RUN] After variable expansion: ${Object.keys(extraEnv).join(', ')}`);

        // Fail fast if any passed-through environment variable still contains an
        // unresolved ${VAR} reference after expansion.
        const unresolvedEnvEntries = Object.entries(extraEnv).flatMap(([key, value]) => {
          if (typeof value !== 'string' || !value.includes('${')) {
            return [];
          }

          const unresolvedMatch = value.match(/\$\{([^}]+)\}/);
          if (!unresolvedMatch) {
            return [];
          }

          const expression = unresolvedMatch[1];
          const defaultSeparatorIndex = expression.indexOf(':-');
          const missingVar = defaultSeparatorIndex === -1
            ? expression
            : expression.slice(0, defaultSeparatorIndex);

          return [`${key} references \${${missingVar}} which is not defined`];
        });

        if (unresolvedEnvEntries.length > 0) {
          const errorMessage = `Session environment is invalid - environment variables not found in daemon: ${unresolvedEnvEntries.join('; ')}. ` +
            `Ensure these variables are set in the daemon's environment before starting sessions.`;
          logger.warn(`[DAEMON RUN] ${errorMessage}`);
          return {
            type: 'error',
            errorMessage
          };
        }

        const launchSpecId = saveRuntimeLaunchSpec({ agent: options.agent === 'codex' ? 'codex' : 'claude', args: [], environment: extraEnv });
        extraEnv = { ...extraEnv, HAPLA_LAUNCH_SPEC_ID: launchSpecId };

        // Check if tmux is available and should be used
        const tmuxAvailable = await isTmuxAvailable();
        let useTmux = tmuxAvailable;

        // Get tmux session name from environment variables (now set by profile system)
        // Empty string means "use current/most recent session" (tmux default behavior)
        let tmuxSessionName: string | undefined = extraEnv.TMUX_SESSION_NAME;

        // If tmux is not available or session name is explicitly undefined, fall back to regular spawning
        // Note: Empty string is valid (means use current/most recent tmux session)
        if (!tmuxAvailable || tmuxSessionName === undefined) {
          useTmux = false;
          if (tmuxSessionName !== undefined) {
            logger.debug(`[DAEMON RUN] tmux session name specified but tmux not available, falling back to regular spawning`);
          }
        }

        if (useTmux && tmuxSessionName !== undefined) {
          // Try to spawn in tmux session
          const sessionDesc = tmuxSessionName || 'current/most recent session';
          logger.debug(`[DAEMON RUN] Attempting to spawn session in tmux: ${sessionDesc}`);

          const tmux = getTmuxUtilities(tmuxSessionName);

          // Construct command for the CLI
          const cliPath = join(projectPath(), 'dist', 'index.mjs');
          const agent = options.agent === 'codex' ? 'codex' : 'claude';
          const fullCommand = `node --no-warnings --no-deprecation ${cliPath} ${agent} --hapla-starting-mode remote --started-by daemon`;

          // Spawn in tmux with environment variables
          // IMPORTANT: Pass complete environment (process.env + extraEnv) because:
          // 1. tmux sessions need daemon's expanded auth variables (e.g., ANTHROPIC_AUTH_TOKEN)
          // 2. Regular spawn uses env: { ...process.env, ...extraEnv }
          // 3. tmux needs explicit environment via -e flags to ensure all variables are available
          const windowName = `hapla-${Date.now()}-${agent}`;
          const tmuxEnv: Record<string, string> = {};

          // Add all daemon environment variables (filtering out undefined)
          for (const [key, value] of Object.entries(process.env)) {
            if (value !== undefined) {
              tmuxEnv[key] = value;
            }
          }

          // Add extra environment variables (these should already be filtered)
          Object.assign(tmuxEnv, extraEnv);

          const tmuxResult = await tmux.spawnInTmux([fullCommand], {
            sessionName: tmuxSessionName,
            windowName: windowName,
            cwd: directory
          }, tmuxEnv);  // Pass complete environment for tmux session

          if (tmuxResult.success) {
            logger.debug(`[DAEMON RUN] Successfully spawned in tmux session: ${tmuxResult.sessionId}, PID: ${tmuxResult.pid}`);

            // Validate we got a PID from tmux
            if (!tmuxResult.pid) {
              throw new Error('Tmux window created but no PID returned');
            }

            // Create a tracked session for tmux windows - now we have the real PID!
            const trackedSession: TrackedSession = {
              startedBy: 'daemon',
              pid: tmuxResult.pid, // Real PID from tmux -P flag
              tmuxSessionId: tmuxResult.sessionId,
              directoryCreated,
              message: directoryCreated
                ? `The path '${directory}' did not exist. We created a new folder and spawned a new session in tmux session '${tmuxSessionName}'. Use 'tmux attach -t ${tmuxSessionName}' to view the session.`
                : `Spawned new session in tmux session '${tmuxSessionName}'. Use 'tmux attach -t ${tmuxSessionName}' to view the session.`
            };

            // Add to tracking map so webhook can find it later
            pidToTrackedSession.set(tmuxResult.pid, trackedSession);

            // Wait for webhook to populate session with haplaSessionId (exact same as regular flow)
            logger.debug(`[DAEMON RUN] Waiting for session webhook for PID ${tmuxResult.pid} (tmux)`);

            return new Promise((resolve) => {
              // Set timeout for webhook (same as regular flow)
              const timeout = setTimeout(() => {
                pidToAwaiter.delete(tmuxResult.pid!);
                logger.debug(`[DAEMON RUN] Session webhook timeout for PID ${tmuxResult.pid} (tmux)`);
                resolve({
                  type: 'error',
                  errorMessage: `Session webhook timeout for PID ${tmuxResult.pid} (tmux)`
                });
              }, 15_000); // Same timeout as regular sessions

              // Register awaiter for tmux session (exact same as regular flow)
              pidToAwaiter.set(tmuxResult.pid!, (result) => {
                clearTimeout(timeout);
                logger.debug(`[DAEMON RUN] Session startup result for PID ${tmuxResult.pid}: ${result.type}`);
                resolve(result);
              });
            });
          } else {
            logger.debug(`[DAEMON RUN] Failed to spawn in tmux: ${tmuxResult.error}, falling back to regular spawning`);
            useTmux = false;
          }
        }

        // Regular process spawning (fallback or if tmux not available)
        if (!useTmux) {
          logger.debug(`[DAEMON RUN] Using regular process spawning`);

          // Construct arguments for the two supported CLIs.
          let agentCommand: string;
          switch (options.agent) {
            case 'claude':
            case undefined:
              agentCommand = 'claude';
              break;
            case 'codex':
              agentCommand = 'codex';
              break;
            default:
              return {
                type: 'error',
                errorMessage: `Unsupported agent type: '${options.agent}'. Please update your CLI to the latest version.`
              };
          }
          const args = [
            agentCommand,
            '--hapla-starting-mode', 'remote',
            '--started-by', 'daemon'
          ];

          // TODO: In future, sessionId could be used with --resume to continue existing sessions
          // For now, we ignore it - each spawn creates a new session
          return spawnTrackedHaplaProcess({
            args,
            cwd: directory,
            env: {
              ...process.env,
              ...extraEnv
            },
            directoryCreated,
            message: directoryCreated ? `The path '${directory}' did not exist. We created a new folder and spawned a new session there.` : undefined,
          });
        }

        // This should never be reached, but TypeScript requires a return statement
        return {
          type: 'error',
          errorMessage: 'Unexpected error in session spawning'
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logger.debug('[DAEMON RUN] Failed to spawn session:', error);
        return {
          type: 'error',
          errorMessage: `Failed to spawn session: ${errorMessage}`
        };
      }
    };

    const spawnTrackedHaplaProcess = ({
      args,
      cwd,
      env,
      directoryCreated = false,
      message,
    }: {
      args: string[];
      cwd: string;
      env: NodeJS.ProcessEnv;
      directoryCreated?: boolean;
      message?: string;
    }): Promise<SpawnSessionResult> => {
      const haplaProcess = spawnHaplaCLI(args, {
        cwd,
        detached: true,
        stdio: 'ignore',
        env,
      });

      if (!haplaProcess.pid) {
        logger.debug('[DAEMON RUN] Failed to spawn process - no PID returned');
        return Promise.resolve({
          type: 'error',
          errorMessage: 'Failed to spawn Hapla process - no PID returned'
        });
      }

      logger.debug(`[DAEMON RUN] Spawned process with PID ${haplaProcess.pid}`);

      const trackedSession: TrackedSession = {
        startedBy: 'daemon',
        pid: haplaProcess.pid,
        childProcess: haplaProcess,
        directoryCreated,
        message,
      };

      pidToTrackedSession.set(haplaProcess.pid, trackedSession);

      haplaProcess.on('exit', (code, signal) => {
        logger.debug(`[DAEMON RUN] Child PID ${haplaProcess.pid} exited with code ${code}, signal ${signal}`);
        if (haplaProcess.pid) {
          onChildExited(haplaProcess.pid, `Session process exited before it was ready (code=${code}, signal=${signal ?? 'none'})`);
        }
      });

      haplaProcess.on('error', (error) => {
        logger.debug(`[DAEMON RUN] Child process error:`, error);
        if (haplaProcess.pid) {
          onChildExited(haplaProcess.pid);
        }
      });

      logger.debug(`[DAEMON RUN] Waiting for session webhook for PID ${haplaProcess.pid}`);

      return new Promise((resolve) => {
        const timeout = setTimeout(() => {
          pidToAwaiter.delete(haplaProcess.pid!);
          logger.debug(`[DAEMON RUN] Session webhook timeout for PID ${haplaProcess.pid}`);
          // This process never acknowledged readiness and has received no
          // question. Do not leave it running behind a failed resume response:
          // the user's retry would otherwise create another writer.
          try { haplaProcess.kill('SIGTERM'); } catch (error) {
            logger.debug('[DAEMON RUN] Failed to stop an unready session process', error);
          }
          resolve({
            type: 'error',
            errorMessage: `Session webhook timeout for PID ${haplaProcess.pid}`
          });
        }, 15_000);

        pidToAwaiter.set(haplaProcess.pid!, (result) => {
          clearTimeout(timeout);
          logger.debug(`[DAEMON RUN] Session startup result for PID ${haplaProcess.pid}: ${result.type}`);
          resolve(result);
        });
      });
    };

    const resumeSession = async ({
      sessionId: haplaSessionId,
      conversationId,
      metadata,
    }: {
      sessionId: string;
      conversationId: string;
      metadata: Pick<Metadata, 'path' | 'flavor' | 'codexThreadId' | 'claudeSessionId' | 'conversationRootSessionId' | 'codexBranches' | 'activeCodexBranchId' | 'launchSpecId' | 'executionConfiguration'>;
    }): Promise<SpawnSessionResult> => {
      const identity = resumeIdentity(haplaSessionId, metadata);
      const activeSession = Array.from(pidToTrackedSession.values()).find((tracked) => {
        if (!tracked.haplaSessionId) return false;
        if (!sessionRegistry.isAlive(tracked)) {
          pidToTrackedSession.delete(tracked.pid);
          sessionRegistry.remove(tracked.pid);
          return false;
        }
        const trackedMetadata = tracked.haplaSessionMetadataFromLocalWebhook;
        return Boolean(
          tracked.haplaSessionId
          && (
            // The initial session webhook is emitted before Codex has a thread ID,
            // so its cached metadata can temporarily be less complete than the
            // browser's copy. An exact Hapla session match is nevertheless an
            // authoritative live-runtime match and must never spawn a second
            // app-server for the same thread.
            tracked.haplaSessionId === haplaSessionId
            || (
              trackedMetadata
              && resumeIdentity(tracked.haplaSessionId, trackedMetadata) === identity
            )
          )
        );
      });
      if (activeSession?.haplaSessionId) {
        logger.debug(`[DAEMON RUN] Reusing active resumed session ${activeSession.haplaSessionId}`);
        return { type: 'success', sessionId: activeSession.haplaSessionId };
      }

      const existingRequest = resumeInFlight.get(identity);
      if (existingRequest) {
        logger.debug(`[DAEMON RUN] Joining in-flight resume request for ${identity}`);
        return existingRequest;
      }

      const request = (async (): Promise<SpawnSessionResult> => {
        try {
          const previousSession = {
            id: haplaSessionId,
            active: false,
            metadata: metadata as Metadata,
          };
          const launch = buildTransparentContinuationLaunch(previousSession, {
            startedBy: 'daemon',
            claudeStartingMode: 'remote',
          });

          await fs.access(launch.cwd);

          return spawnTrackedHaplaProcess({
            args: launch.args,
            cwd: launch.cwd,
            env: {
              ...process.env,
              ...launch.env,
              HAPLA_CONVERSATION_ID: conversationId,
            },
          });
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          logger.debug('[DAEMON RUN] Failed to resume session:', error);
          return {
            type: 'error',
            errorMessage: `Failed to resume session: ${errorMessage}`,
          };
        }
      })();
      resumeInFlight.set(identity, request);
      try {
        return await request;
      } finally {
        if (resumeInFlight.get(identity) === request) {
          resumeInFlight.delete(identity);
        }
      }
    };

    // Stop a session by sessionId or PID fallback
    const stopSession = (sessionId: string): boolean => {
      logger.debug(`[DAEMON RUN] Attempting to stop session ${sessionId}`);

      // Try to find by sessionId first
      for (const [pid, session] of pidToTrackedSession.entries()) {
        if (session.haplaSessionId === sessionId ||
          (sessionId.startsWith('PID-') && pid === parseInt(sessionId.replace('PID-', '')))) {

          if (session.haplaSessionId && !sessionRegistry.isAlive(session)) {
            pidToTrackedSession.delete(pid);
            sessionRegistry.remove(pid);
            return false;
          }

          if (session.startedBy === 'daemon' && session.childProcess) {
            try {
              session.childProcess.kill('SIGTERM');
              logger.debug(`[DAEMON RUN] Sent SIGTERM to daemon-spawned session ${sessionId}`);
            } catch (error) {
              logger.debug(`[DAEMON RUN] Failed to kill session ${sessionId}:`, error);
            }
          } else {
            // For externally started sessions, try to kill by PID
            try {
              process.kill(pid, 'SIGTERM');
              logger.debug(`[DAEMON RUN] Sent SIGTERM to external session PID ${pid}`);
            } catch (error) {
              logger.debug(`[DAEMON RUN] Failed to kill external session PID ${pid}:`, error);
            }
          }

          pidToTrackedSession.delete(pid);
          sessionRegistry.remove(pid);
          logger.debug(`[DAEMON RUN] Removed session ${sessionId} from tracking`);
          return true;
        }
      }

      logger.debug(`[DAEMON RUN] Session ${sessionId} not found`);
      return false;
    };

    // Handle child process exit
    const onChildExited = (pid: number, errorMessage = 'Session process failed before it was ready') => {
      logger.debug(`[DAEMON RUN] Removing exited process PID ${pid} from tracking`);
      pidToTrackedSession.delete(pid);
      sessionRegistry.remove(pid);
      const awaiter = pidToAwaiter.get(pid);
      if (awaiter) {
        pidToAwaiter.delete(pid);
        awaiter({ type: 'error', errorMessage });
      }
    };

    // Start control server
    const { port: controlPort, stop: stopControlServer } = await startDaemonControlServer({
      getChildren: getCurrentChildren,
      stopSession,
      spawnSession,
      requestShutdown: () => requestShutdown('hapla-cli'),
      onHaplaSessionWebhook
    });

    // Write initial daemon state (no lock needed for state file)
    const fileState: DaemonLocallyPersistedState = {
      pid: process.pid,
      httpPort: controlPort,
      startTime: new Date().toLocaleString(),
      startedWithCliVersion: packageJson.version,
      ...(startedWithCliBuild ? { startedWithCliBuild } : {}),
      daemonLogPath: logger.logFilePath
    };
    writeDaemonState(fileState);
    logger.debug('[DAEMON RUN] Daemon state written');

    // Prepare initial daemon state
    const initialDaemonState: DaemonState = {
      status: 'offline',
      pid: process.pid,
      httpPort: controlPort,
      startedAt: Date.now()
    };

    // Create API client
    const api = await ApiClient.create(credentials);

    // Get or create machine
    const [claudeCapabilities, codexCapabilities] = await Promise.all([
      initialMachineMetadata.cliAvailability?.claude
        ? discoverClaudeCapabilities()
        : Promise.resolve({ models: [], skills: [] }),
      initialMachineMetadata.cliAvailability?.codex
        ? discoverCodexCapabilities()
        : Promise.resolve({ models: [], skills: [] }),
    ]);
    const machine = await api.getOrCreateMachine({
      machineId,
      metadata: {
        ...initialMachineMetadata,
        codexVersion: detectCodexVersion(),
        codexModels: codexCapabilities.models,
        cliCapabilities: {
          ...(initialMachineMetadata.cliAvailability?.claude ? {
            claude: {
              version: detectClaudeVersion(),
              ...claudeCapabilities,
            },
          } : {}),
          ...(initialMachineMetadata.cliAvailability?.codex ? {
            codex: {
              version: detectCodexVersion(),
              ...codexCapabilities,
            },
          } : {}),
          discoveredAt: Date.now(),
        },
      },
      daemonState: initialDaemonState
    });
    logger.debug(`[DAEMON RUN] Machine registered: ${machine.id}`);

    // Create realtime machine session
    const apiMachine = api.machineSyncClient(machine);

    // Set RPC handlers
    apiMachine.setRPCHandlers({
      spawnSession,
      resumeSession,
      stopSession,
      resolveFileWorkspace: sessionId => Array.from(pidToTrackedSession.values()).find(session => session.haplaSessionId === sessionId || session.haplaSessionMetadataFromLocalWebhook?.conversationRootSessionId === sessionId)?.haplaSessionMetadataFromLocalWebhook?.path,
      requestShutdown: () => requestShutdown('hapla-app')
    });

    // Connect to server
    apiMachine.connect();

    // Every 60 seconds:
    // 1. Prune stale sessions
    // 2. Check if daemon needs update
    // 3. If outdated, restart with latest version
    // 4. Write heartbeat
    const heartbeatIntervalMs = parseInt(process.env.HAPLA_DAEMON_HEARTBEAT_INTERVAL || '60000');
    let heartbeatRunning = false
    const restartOnStaleVersionAndHeartbeat = setInterval(async () => {
      if (heartbeatRunning) {
        return;
      }
      heartbeatRunning = true;

      if (process.env.DEBUG) {
        logger.debug(`[DAEMON RUN] Health check started at ${new Date().toLocaleString()}`);
      }

      // Prune stale sessions
      for (const [pid, tracked] of pidToTrackedSession.entries()) {
        try {
          // Check if process is still alive (signal 0 doesn't kill, just checks)
          process.kill(pid, 0);
          if (tracked.haplaSessionId && !sessionRegistry.isAlive(tracked)) throw new Error('Session process identity changed');
        } catch (error) {
          // Process is dead, remove from tracking
          logger.debug(`[DAEMON RUN] Removing stale session with PID ${pid} (process no longer exists)`);
          pidToTrackedSession.delete(pid);
          sessionRegistry.remove(pid);
        }
      }

      // Check if daemon needs update
      // If version on disk is different from the one in package.json - we need to restart
      // BIG if - does this get updated from underneath us on npm upgrade?
      let projectVersion: string | null = null;
      try {
        const candidateVersion = JSON.parse(readFileSync(join(projectPath(), 'package.json'), 'utf-8')).version;
        projectVersion = typeof candidateVersion === 'string' ? candidateVersion : null;
      } catch (error) {
        // Package managers and local builds may temporarily replace package files.
        // Keep the loaded daemon available and check again on the next heartbeat.
        logger.debug('[DAEMON RUN] Installed package metadata is temporarily unavailable; deferring restart check', error);
      }
      const installedCliBuild = readInstalledCliBuildFingerprint();
      const buildChanged = installedCliBuild !== null
        && startedWithCliBuild !== null
        && installedCliBuild !== startedWithCliBuild;
      const versionChanged = projectVersion !== null
        && projectVersion !== configuration.currentCliVersion;
      if (versionChanged || buildChanged) {
        logger.debug('[DAEMON RUN] Daemon is outdated, requesting a replacement handoff');
        restartHandoff.requestReplacement();

        // A successfully loaded replacement calls this daemon's /stop endpoint
        // before acquiring the lock. Until then this process must keep serving,
        // especially while dist/ is temporarily absent during an upgrade.
        heartbeatRunning = false;
        return;
      }

      // Before wrecklessly overriting the daemon state file, we should check if we are the ones who own it
      // Race condition is possible, but thats okay for the time being :D
      const daemonState = await readDaemonState();
      if (daemonState && daemonState.pid !== process.pid) {
        logger.debug('[DAEMON RUN] Somehow a different daemon was started without killing us. We should kill ourselves.')
        requestShutdown('exception', 'A different daemon was started without killing us. We should kill ourselves.')
      }

      // Heartbeat
      try {
        const updatedState: DaemonLocallyPersistedState = {
          pid: process.pid,
          httpPort: controlPort,
          startTime: fileState.startTime,
          startedWithCliVersion: packageJson.version,
          ...(startedWithCliBuild ? { startedWithCliBuild } : {}),
          lastHeartbeat: new Date().toLocaleString(),
          daemonLogPath: fileState.daemonLogPath
        };
        writeDaemonState(updatedState);
        if (process.env.DEBUG) {
          logger.debug(`[DAEMON RUN] Health check completed at ${updatedState.lastHeartbeat}`);
        }
      } catch (error) {
        logger.debug('[DAEMON RUN] Failed to write heartbeat', error);
      }

      heartbeatRunning = false;
    }, heartbeatIntervalMs); // Every 60 seconds in production

    // Setup signal handlers
    const cleanupAndShutdown = async (source: 'hapla-app' | 'hapla-cli' | 'os-signal' | 'exception', errorMessage?: string) => {
      logger.debug(`[DAEMON RUN] Starting proper cleanup (source: ${source}, errorMessage: ${errorMessage})...`);

      // Clear health check interval
      if (restartOnStaleVersionAndHeartbeat) {
        clearInterval(restartOnStaleVersionAndHeartbeat);
        logger.debug('[DAEMON RUN] Health check interval cleared');
      }

      // Update daemon state before shutting down
      await apiMachine.updateDaemonState((state: DaemonState | null) => ({
        ...state,
        status: 'shutting-down',
        shutdownRequestedAt: Date.now(),
        shutdownSource: source
      }));

      // Give time for metadata update to send
      await new Promise(resolve => setTimeout(resolve, 100));

      apiMachine.shutdown();
      await stopControlServer();
      await cleanupDaemonState();
      await stopCaffeinate();
      await releaseDaemonLock(daemonLockHandle);

      logger.debug('[DAEMON RUN] Cleanup completed, exiting process');
      process.exit(0);
    };

    logger.debug('[DAEMON RUN] Daemon started successfully, waiting for shutdown request');

    // Wait for shutdown request
    const shutdownRequest = await resolvesWhenShutdownRequested;
    await cleanupAndShutdown(shutdownRequest.source, shutdownRequest.errorMessage);
  } catch (error) {
    logger.debug('[DAEMON RUN][FATAL] Failed somewhere unexpectedly - exiting with code 1', error);
    process.exit(1);
  }
}
