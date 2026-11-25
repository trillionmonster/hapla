import { sessionConfigurationSchema } from '@hapla/wire/sessionConfiguration';
/**
 * Session Metadata Factory
 *
 * Creates session state and metadata objects for the Claude and Codex backends.
 * This follows DRY principles by providing a single implementation for all backends.
 *
 * @module createSessionMetadata
 */

import os from 'node:os';
import { resolve } from 'node:path';

import type { AgentState, Metadata } from '@/api/types';
import { configuration } from '@/configuration';
import { projectPath } from '@/projectPath';
import type { SandboxConfig } from '@/persistence';
import packageJson from '../../package.json';

/**
 * Backend flavor identifier for session metadata.
 */
export type BackendFlavor = 'claude' | 'codex';

/**
 * Options for creating session metadata.
 */
export interface CreateSessionMetadataOptions {
    /** Backend flavor. */
    flavor: BackendFlavor;
    /** Machine ID for server identification */
    machineId: string;
    /** How the session was started */
    startedBy?: 'daemon' | 'terminal';
    /** Active sandbox config for the session, or undefined when not used */
    sandbox?: SandboxConfig;
    /** Whether the backend runs with "dangerously skip permissions" behavior */
    dangerouslySkipPermissions?: boolean;
}

/**
 * Result containing both state and metadata for session creation.
 */
export interface SessionMetadataResult {
    /** Agent state for session */
    state: AgentState;
    /** Session metadata */
    metadata: Metadata;
}

/**
 * Creates session state and metadata for backend agents.
 *
 * This utility consolidates the common session metadata creation logic used by
 * Codex backend, ensuring consistency across supported implementations.
 *
 * @param opts - Options specifying flavor, machineId, and startedBy
 * @returns Object containing state and metadata for session creation
 *
 * @example
 * ```typescript
 * const { state, metadata } = createSessionMetadata({
 *     flavor: 'codex',
 *     machineId: settings.machineId,
 *     startedBy: opts.startedBy
 * });
 *
 * const response = await api.getOrCreateSession({ tag: sessionTag, metadata, state });
 * ```
 */
export function createSessionMetadata(opts: CreateSessionMetadataOptions): SessionMetadataResult {
    const state: AgentState = {
        controlledByUser: false,
    };

    let restoredCodexBranchState: Pick<Metadata, 'codexBranches' | 'activeCodexBranchId'> = {};
    if (opts.flavor === 'codex' && process.env.HAPLA_CODEX_BRANCH_STATE) {
        try {
            const parsed = JSON.parse(process.env.HAPLA_CODEX_BRANCH_STATE) as Partial<Metadata>;
            if (Array.isArray(parsed.codexBranches)) {
                restoredCodexBranchState = {
                    codexBranches: parsed.codexBranches,
                    activeCodexBranchId: typeof parsed.activeCodexBranchId === 'string'
                        ? parsed.activeCodexBranchId
                        : undefined,
                };
            }
        } catch {
            // An optional malformed handoff must not prevent the runtime from starting.
        }
    }

    let executionConfiguration: Metadata['executionConfiguration'];
    if (process.env.HAPLA_SESSION_CONFIGURATION) {
        const parsed = sessionConfigurationSchema.safeParse(JSON.parse(process.env.HAPLA_SESSION_CONFIGURATION));
        if (parsed.success) executionConfiguration = parsed.data;
    }
    const metadata: Metadata = {
        launchSpecId: process.env.HAPLA_LAUNCH_SPEC_ID || undefined,
        executionConfiguration,
        path: process.cwd(),
        host: os.hostname(),
        version: packageJson.version,
        os: os.platform(),
        machineId: opts.machineId,
        continuedFromSessionId: process.env.HAPLA_CONTINUED_FROM_SESSION_ID || undefined,
        conversationRootSessionId: process.env.HAPLA_CONVERSATION_ROOT_SESSION_ID || undefined,
        homeDir: os.homedir(),
        happyHomeDir: configuration.haplaHomeDir,
        happyLibDir: projectPath(),
        happyToolsDir: resolve(projectPath(), 'tools', 'unpacked'),
        startedFromDaemon: opts.startedBy === 'daemon',
        hostPid: process.pid,
        startedBy: opts.startedBy || 'terminal',
        lifecycleState: 'running',
        lifecycleStateSince: Date.now(),
        flavor: opts.flavor,
        ...(opts.flavor === 'codex' && process.env.HAPLA_RESUME_CODEX_THREAD_ID
            ? { codexThreadId: process.env.HAPLA_RESUME_CODEX_THREAD_ID }
            : {}),
        ...restoredCodexBranchState,
        sandbox: opts.sandbox?.enabled ? opts.sandbox : null,
        dangerouslySkipPermissions: opts.dangerouslySkipPermissions ?? null,
    };

    return { state, metadata };
}
