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
    session: Session, machine: Machine | null | undefined, isConnected: boolean,
    dependencies: SessionContinuationDependencies, options: SessionContinuationOptions = {},
): Promise<string> {
    return (await import('./sessionContinuationSend')).prepareSessionForSend(session, machine, isConnected, dependencies, options);
}
