import {
    getProjectIdentity,
    normalizeProjectPath,
    projectLabel,
    type ProjectIdentity,
} from '@/utils/projectIdentity';
import { collapseRuntimeSessions } from './conversationSessions';
import type { Session } from './storageTypes';
import { compareSessionQuestions, sessionQuestionAt } from './sessionQuestionOrder';

export interface WorkspaceSessionGroup<TSession = Session> {
    /** Stable UI/state key. Canonical projects use machine + normalized path. */
    key: string;
    machineId: string | null;
    normalizedPath: string | null;
    displayName: string;
    identity: ProjectIdentity;
    hasOnlineSessions: boolean;
    latestActivityAt: number;
    onlineSessions: TSession[];
    offlineSessions: TSession[];
}

interface WorkspaceDescriptor {
    key: string;
    machineId: string | null;
    normalizedPath: string | null;
    displayName: string;
    identity: ProjectIdentity;
}

function descendingNumber(left: number, right: number): number {
    return right - left;
}

function ascendingString(left: string, right: string): number {
    return left < right ? -1 : left > right ? 1 : 0;
}

function isAbsoluteWorkspacePath(path: string): boolean {
    return path.startsWith('/') || /^[a-z]:\//i.test(path);
}

function canonicalWorkspacePathKey(rawPath: string, normalizedPath: string): string {
    const os = rawPath.includes('\\') || /^[a-z]:\//i.test(normalizedPath) || normalizedPath.startsWith('//')
        ? 'windows'
        : 'posix';
    return os === 'windows' ? normalizedPath.toLowerCase() : normalizedPath;
}

function workspaceDescriptor(session: Session): WorkspaceDescriptor {
    const machineId = session.metadata?.machineId?.trim() || null;
    const normalizedPath = normalizeProjectPath(session.metadata?.path);
    const displayFallback = session.metadata?.host?.trim() || 'Unknown workspace';
    const displayName = projectLabel(normalizedPath, displayFallback);
    const identity = getProjectIdentity(normalizedPath, displayName);

    // A filesystem directory is only globally meaningful together with its
    // machine. Legacy/incomplete records stay separate instead of merging
    // unrelated conversations into a misleading project.
    const canonicalPath = normalizedPath && isAbsoluteWorkspacePath(normalizedPath)
        ? canonicalWorkspacePathKey(session.metadata?.path ?? normalizedPath, normalizedPath)
        : null;
    const key = machineId && canonicalPath
        ? `workspace:${JSON.stringify([machineId, canonicalPath])}`
        : `session:${encodeURIComponent(session.id)}`;

    return { key, machineId, normalizedPath, displayName, identity };
}

/**
 * Build the sidebar's folder-first model from real session records.
 *
 * Runtime records for the same conversation are collapsed before grouping.
 * Online and offline sessions remain separate so callers can always render
 * online rows while keeping offline rows collapsed by default.
 */
export function buildWorkspaceSessionGroups(
    sessions: readonly Session[],
): WorkspaceSessionGroup<Session>[] {
    const groups = new Map<string, WorkspaceSessionGroup<Session>>();
    const emptyFolderCreatedAt = new Map<string, number>();
    const deterministicInput = [...sessions].sort((left, right) => (
        left.createdAt - right.createdAt
        || ascendingString(left.id, right.id)
    ));

    for (const session of collapseRuntimeSessions(deterministicInput)) {
        const descriptor = workspaceDescriptor(session);
        let group = groups.get(descriptor.key);
        if (!group) {
            group = {
                ...descriptor,
                hasOnlineSessions: false,
                latestActivityAt: sessionQuestionAt(session),
                onlineSessions: [],
                offlineSessions: [],
            };
            groups.set(descriptor.key, group);
        } else if (
            descriptor.normalizedPath
            && group.normalizedPath
            && ascendingString(descriptor.normalizedPath, group.normalizedPath) < 0
        ) {
            // Windows keys intentionally ignore case. Pick a deterministic
            // display spelling so shuffled input cannot change the header.
            group.normalizedPath = descriptor.normalizedPath;
            group.displayName = descriptor.displayName;
            group.identity = descriptor.identity;
        }

        group.latestActivityAt = Math.max(group.latestActivityAt, sessionQuestionAt(session));
        emptyFolderCreatedAt.set(group.key, Math.max(emptyFolderCreatedAt.get(group.key) ?? 0, session.questionFallbackCreatedAt ?? session.createdAt));
        if (session.active) {
            group.hasOnlineSessions = true;
            group.onlineSessions.push(session);
        } else {
            group.offlineSessions.push(session);
        }
    }

    for (const group of groups.values()) {
        group.onlineSessions.sort(compareSessionQuestions);
        group.offlineSessions.sort(compareSessionQuestions);
    }

    return [...groups.values()].sort((left, right) => (
        descendingNumber(left.latestActivityAt, right.latestActivityAt)
        || (!left.latestActivityAt && !right.latestActivityAt ? descendingNumber(emptyFolderCreatedAt.get(left.key) ?? 0, emptyFolderCreatedAt.get(right.key) ?? 0) : 0)
        || ascendingString(left.key, right.key)
    ));
}

export function mapWorkspaceSessionGroup<TSource, TTarget>(
    group: WorkspaceSessionGroup<TSource>,
    mapSession: (session: TSource) => TTarget,
): WorkspaceSessionGroup<TTarget> {
    return {
        ...group,
        onlineSessions: group.onlineSessions.map(mapSession),
        offlineSessions: group.offlineSessions.map(mapSession),
    };
}
