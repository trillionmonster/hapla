import type { Message } from '@/sync/typesMessage';
import type { Metadata } from '@/sync/storageTypes';

type Branch = NonNullable<Metadata['codexBranches']>[number];

export function getActiveBranchLineage(metadata: Metadata | null): Branch[] {
    const branches = metadata?.codexBranches ?? [];
    const byId = new Map(branches.map((branch) => [branch.id, branch]));
    let current = metadata?.activeCodexBranchId ? byId.get(metadata.activeCodexBranchId) : undefined;
    const result: Branch[] = [];
    const seen = new Set<string>();
    while (current && !seen.has(current.id)) {
        seen.add(current.id);
        result.unshift(current);
        current = current.parentId ? byId.get(current.parentId) : undefined;
    }
    return result;
}

/** Return only the immutable shared prefix and segments on the selected branch path. */
export function filterMessagesForActiveBranch(messages: Message[], metadata: Metadata | null): Message[] {
    const lineage = getActiveBranchLineage(metadata);
    if (lineage.length === 0) return messages;
    const allowed = new Set(lineage.map((branch) => branch.id));
    const timeById = new Map(messages.map((message) => [message.id, message.createdAt]));
    const cutoffByBranch = new Map<string, number>();
    for (let index = 1; index < lineage.length; index += 1) {
        const child = lineage[index];
        const cutoff = (child.forkMessageId ? timeById.get(child.forkMessageId) : undefined)
            ?? child.forkMessageCreatedAt
            // Branches created by older Hapla clients did not persist the fork
            // message. Their creation time is still a safe boundary: parent
            // messages written afterwards must not leak into the child branch.
            ?? child.createdAt;
        if (cutoff !== undefined) cutoffByBranch.set(lineage[index - 1].id, cutoff);
    }
    const sharedCutoff = lineage.length > 1 ? cutoffByBranch.get(lineage[0].id) : undefined;
    return messages.filter((message) => {
        const requestThread = message.kind === 'tool-call' ? message.tool.permission?.protocol?.threadId : undefined;
        const branchId = message.meta?.branchId ?? (requestThread
            ? metadata?.codexBranches?.find((branch) => branch.threadId === requestThread)?.id : undefined);
        if (!branchId) return sharedCutoff === undefined || message.createdAt < sharedCutoff;
        if (!allowed.has(branchId)) return false;
        const cutoff = cutoffByBranch.get(branchId);
        return cutoff === undefined || message.createdAt < cutoff;
    });
}

export function getUserMessageOrdinal(messages: Message[], targetId: string): number {
    return [...messages]
        .sort((left, right) => left.createdAt - right.createdAt)
        .filter((message) => message.kind === 'user-text')
        .findIndex((message) => message.id === targetId);
}
