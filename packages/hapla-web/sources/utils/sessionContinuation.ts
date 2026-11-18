import type { ResumeSessionOptions, SpawnSessionResult } from '@/sync/ops';
import type { Machine, Session } from '@/sync/storageTypes';
import { t } from '@/text';
import { HaplaError } from '@/utils/errors';
import { isMachineOnline } from '@/utils/machineUtils';

export type SessionContinuationAvailability = {
    requiresContinuation: boolean;
    canContinue: boolean;
    message: string;
};

export interface SessionContinuationDependencies {
    resumeSession: (options: ResumeSessionOptions) => Promise<SpawnSessionResult>;
    refreshSessions: () => Promise<unknown>;
    getSession: (sessionId: string) => Session | null | undefined;
    copySessionSettings: (from: Session, targetSessionId: string) => void;
    wait: (milliseconds: number) => Promise<void>;
    refreshAttempts?: number;
}

export type SessionContinuationOptions = {
    metadata?: Partial<ResumeSessionOptions['metadata']>;
};

function resumedRuntimeReady(source: Session, target: Session, options: SessionContinuationOptions): boolean {
    // A daemon-confirmed live process for this exact runtime is reusable. A
    // replacement, however, must not receive the draft merely because its
    // encrypted session row was created before app-server initialization.
    if (target.id === source.id) return true;
    if (!target.active) {
        throw new HaplaError('会话恢复过程中已断开，消息尚未发送。请重试。', true);
    }
    if (continuationFlavor(source) !== 'codex') return true;

    const runtime = target.agentState?.codexRuntime;
    if (runtime?.runtime === 'systemError') {
        throw new HaplaError('Codex 恢复失败，消息尚未发送。请重试。', true);
    }
    const metadata = { ...source.metadata, ...options.metadata };
    const selectedBranch = metadata.codexBranches?.find(branch => branch.id === metadata.activeCodexBranchId);
    const requestedThread = options.metadata?.codexThreadId ?? selectedBranch?.threadId ?? metadata.codexThreadId;

    // A genuinely new conversation creates its first thread only when its
    // first question arrives. `notLoaded` is a valid initialized state there.
    if (!requestedThread) return !runtime || runtime.runtime !== 'loading';
    if (!runtime) {
        // Existing protocol-aware clients must wait for their new runtime's
        // state. Legacy CLIs never published it; their daemon readiness ACK
        // remains the compatibility signal.
        return !source.agentState?.codexRuntime;
    }
    if (runtime.runtime === 'loading' || runtime.runtime === 'notLoaded') return false;
    if (runtime.threadId !== requestedThread) {
        throw new HaplaError('恢复的 Codex 会话与所选分支不一致，消息尚未发送。', true);
    }
    return runtime.runtime === 'idle' || runtime.runtime === 'active';
}

export function continuationFlavor(session: Session): 'codex' | 'claude' | null {
    const flavor = session.metadata?.flavor?.toLowerCase();
    if (
        flavor === 'codex'
        || flavor === 'gpt'
        || flavor === 'openai'
        || session.metadata?.codexThreadId
    ) return 'codex';
    if (flavor === 'claude' || session.metadata?.claudeSessionId) return 'claude';

    // Sessions created before provider metadata was introduced
    // were Claude sessions. They must remain usable after upgrading: when no
    // provider-side id exists yet the daemon starts a replacement runtime in
    // the same workspace and links it to the visible conversation.
    if (!flavor) return 'claude';
    return null;
}

function machineSupportsContinuation(machine: Machine, flavor: 'codex' | 'claude'): boolean {
    if (!isMachineOnline(machine) || !machine.metadata?.resumeSupport?.rpcAvailable) return false;
    return machine.metadata.cliAvailability?.[flavor] !== false;
}

function pathIsInsideHome(path: string | undefined, homeDir: string | undefined): boolean {
    if (!path || !homeDir) return true;
    const normalizedPath = path.replaceAll('\\', '/').replace(/\/+$/, '');
    const normalizedHome = homeDir.replaceAll('\\', '/').replace(/\/+$/, '');
    return normalizedPath === normalizedHome || normalizedPath.startsWith(`${normalizedHome}/`);
}

/**
 * A machine id identifies one daemon installation, not the workstation. An
 * online daemon on the same host/home can transparently take over an older
 * conversation after the original installation disappeared.
 */
export function resolveContinuationMachines(session: Session, machines: Machine[]): Machine[] {
    const flavor = continuationFlavor(session);
    if (!flavor) return [];

    const original = machines.find((candidate) => candidate.id === session.metadata?.machineId);
    const host = session.metadata?.host;
    const sessionHome = session.metadata?.homeDir;
    const sessionAgentHome = session.metadata?.happyHomeDir;
    const compatible = machines
        .filter((candidate) => machineSupportsContinuation(candidate, flavor))
        .filter((candidate) => !host || candidate.metadata?.host === host)
        .filter((candidate) => !sessionHome || candidate.metadata?.homeDir === sessionHome)
        .filter((candidate) => pathIsInsideHome(session.metadata?.path, candidate.metadata?.homeDir))
        .sort((left, right) => {
            const leftAgentHomeMatch = Number(Boolean(sessionAgentHome && left.metadata?.happyHomeDir === sessionAgentHome));
            const rightAgentHomeMatch = Number(Boolean(sessionAgentHome && right.metadata?.happyHomeDir === sessionAgentHome));
            if (leftAgentHomeMatch !== rightAgentHomeMatch) return rightAgentHomeMatch - leftAgentHomeMatch;
            if (left.activeAt !== right.activeAt) return right.activeAt - left.activeAt;
            return right.createdAt - left.createdAt;
        });
    if (!original || !machineSupportsContinuation(original, flavor)) return compatible;
    return [original, ...compatible.filter((candidate) => candidate.id !== original.id)];
}

export function resolveContinuationMachine(session: Session, machines: Machine[]): Machine | null {
    return resolveContinuationMachines(session, machines)[0] ?? null;
}

/**
 * Decides whether a send can target the current runtime or must transparently
 * continue the underlying Claude/Codex conversation first.
 */
export function getSessionContinuationAvailability(
    session: Session,
    machine: Machine | null | undefined,
    _isConnected: boolean,
): SessionContinuationAvailability {
    // Every send first asks the machine daemon to ensure the underlying runtime.
    // Neither persisted `active` nor relay presence is authoritative enough:
    // both can outlive a process. The daemon reuses a tracked live runtime and
    // coalesces concurrent requests, or starts a replacement for the same
    // Claude/Codex conversation when needed. This is deliberately invisible UI.

    const machineId = session.metadata?.machineId;
    if (!machineId) {
        return {
            requiresContinuation: true,
            canContinue: false,
            message: t('sessionInfo.resumeSessionMissingMachine'),
        };
    }

    if (!continuationFlavor(session)) {
        return {
            requiresContinuation: true,
            canContinue: false,
            message: t('sessionInfo.resumeSessionMissingBackendId'),
        };
    }

    if (!machine) {
        return {
            requiresContinuation: true,
            canContinue: false,
            message: t('sessionInfo.resumeSessionSameMachineOnly'),
        };
    }

    if (!isMachineOnline(machine)) {
        return {
            requiresContinuation: true,
            canContinue: false,
            message: t('sessionInfo.resumeSessionMachineOffline'),
        };
    }

    if (!machine.metadata?.resumeSupport?.rpcAvailable) {
        return {
            requiresContinuation: true,
            canContinue: false,
            message: t('sessionInfo.resumeSessionNeedsHaplaAgent'),
        };
    }

    return {
        requiresContinuation: true,
        canContinue: true,
        message: '',
    };
}

/**
 * Returns the live runtime that should receive an outgoing message. The daemon
 * reuses an existing runtime or starts a replacement, waits until its encryption
 * state is available locally, and carries the user's model/permission choices
 * across. No close/resume state is exposed in the UI.
 */
export async function prepareSessionForSend(
    session: Session,
    machine: Machine | null | undefined,
    isConnected: boolean,
    dependencies: SessionContinuationDependencies,
    options: SessionContinuationOptions = {},
): Promise<string> {
    const flavor = continuationFlavor(session);
    const availability = getSessionContinuationAvailability(session, machine, isConnected);
    if (!availability.requiresContinuation) {
        return session.id;
    }
    if (!availability.canContinue) {
        throw new HaplaError(availability.message, true);
    }

    const machineId = machine?.id;
    if (!machineId) {
        throw new HaplaError(t('sessionInfo.resumeSessionMissingMachine'), true);
    }

    const result = await dependencies.resumeSession({
        machineId,
        sessionId: session.id,
        conversationId: session.conversationId ?? session.id,
        metadata: {
            path: session.metadata?.path ?? '',
            flavor: flavor ?? session.metadata?.flavor,
            codexThreadId: session.metadata?.codexThreadId,
            claudeSessionId: session.metadata?.claudeSessionId,
            conversationRootSessionId: session.metadata?.conversationRootSessionId,
            codexBranches: session.metadata?.codexBranches,
            activeCodexBranchId: session.metadata?.activeCodexBranchId,
            ...options.metadata,
        },
    });

    switch (result.type) {
        case 'requestToApproveDirectoryCreation':
            throw new HaplaError(t('sessionInfo.resumeSessionUnexpectedDirectoryPrompt'), false);
        case 'error':
            throw new HaplaError(result.errorMessage, true);
        case 'success': {
            const refreshAttempts = dependencies.refreshAttempts ?? 20;
            for (let attempt = 0; attempt < refreshAttempts; attempt++) {
                await dependencies.refreshSessions();
                const target = dependencies.getSession(result.sessionId);
                if (target && resumedRuntimeReady(session, target, options)) {
                    dependencies.copySessionSettings(session, result.sessionId);
                    return result.sessionId;
                }
                if (attempt + 1 < refreshAttempts) {
                    await dependencies.wait(250);
                }
            }
            throw new HaplaError(t('errors.connectionTimeout'), true);
        }
    }
}
