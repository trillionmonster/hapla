import type { Metadata, Session } from './storageTypes';

export type ConversationSessionRef = {
    id: string;
    conversationId?: string | null;
    metadata: Pick<Metadata,
        | 'conversationRootSessionId'
        | 'continuedFromSessionId'
        | 'codexThreadId'
        | 'claudeSessionId'
        | 'flavor'
    > | null;
};

export function isSameConversation(left: ConversationSessionRef, right: ConversationSessionRef): boolean {
    if (left.id === right.id) return true;
    // Once both records have been migrated, this indexed identity is
    // authoritative. Never merge distinct conversations because provider ids
    // or old encrypted metadata happen to collide.
    if (left.conversationId && right.conversationId) {
        return left.conversationId === right.conversationId;
    }

    const leftRoot = left.metadata?.conversationRootSessionId;
    const rightRoot = right.metadata?.conversationRootSessionId;
    if (leftRoot && rightRoot && leftRoot === rightRoot) return true;
    if (leftRoot === right.id || rightRoot === left.id) return true;
    if (left.metadata?.continuedFromSessionId === right.id || right.metadata?.continuedFromSessionId === left.id) return true;

    const leftFlavor = left.metadata?.flavor;
    const rightFlavor = right.metadata?.flavor;
    if (leftFlavor === 'codex' && rightFlavor === 'codex') {
        return Boolean(left.metadata?.codexThreadId && left.metadata.codexThreadId === right.metadata?.codexThreadId);
    }
    if (leftFlavor === 'claude' && rightFlavor === 'claude') {
        return Boolean(left.metadata?.claudeSessionId && left.metadata.claudeSessionId === right.metadata?.claudeSessionId);
    }
    return false;
}

export function getConversationRuntimeIds(sessions: ConversationSessionRef[], targetSessionId: string): string[] {
    const target = sessions.find((session) => session.id === targetSessionId);
    if (!target) return [targetSessionId];

    const group = new Set<string>([target.id]);
    let changed = true;
    while (changed) {
        changed = false;
        for (const session of sessions) {
            if (group.has(session.id)) continue;
            const belongsToGroup = sessions.some((candidate) => (
                group.has(candidate.id) && isSameConversation(candidate, session)
            ));
            if (belongsToGroup) {
                group.add(session.id);
                changed = true;
            }
        }
    }

    return Array.from(group);
}

/**
 * A conversation can outlive several runtime records. The newest runtime owns
 * liveness, but an older runtime may contain the latest human-readable title.
 * Preserve that title instead of falling back to the repeated project folder.
 */
export function collapseRuntimeSessions(sessions: Session[]): Session[] {
    const groups: Session[][] = [];
    for (const session of [...sessions].sort((left, right) => left.createdAt - right.createdAt)) {
        const group = groups.find((candidate) => candidate.some((item) => isSameConversation(item, session)));
        if (group) group.push(session);
        else groups.push([session]);
    }

    return groups.map((group) => {
        const newestRuntime = group.reduce((best, candidate) => (
            candidate.updatedAt > best.updatedAt ? candidate : best
        ));
        const metadataByFreshness = [...group]
            .sort((left, right) => right.updatedAt - left.updatedAt)
            .map((session) => session.metadata)
            .filter((metadata): metadata is NonNullable<Session['metadata']> => Boolean(metadata));
        const latestSummary = metadataByFreshness
            .map((metadata) => metadata.summary)
            .filter((summary): summary is { text: string; updatedAt: number } => Boolean(summary))
            .sort((left, right) => right.updatedAt - left.updatedAt)[0];
        const latestNamedMetadata = metadataByFreshness.find((metadata) => metadata.name);
        const questionTimes = group.map(session => session.lastUserMessageAt)
            .filter((value): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0);
        // Resuming a runtime is not a new question. Preserve the conversation's
        // question clock across runtime selection and use its original creation
        // only when the whole conversation has no user messages.
        const questionClock = {
            lastUserMessageAt: questionTimes.length ? Math.max(...questionTimes) : null,
            questionFallbackCreatedAt: Math.min(...group.map(session => session.createdAt)),
            questionOrderId: newestRuntime.conversationId ?? [...group].sort((left, right) => left.createdAt - right.createdAt || (left.id < right.id ? -1 : 1))[0].id,
        };

        if (!newestRuntime.metadata && metadataByFreshness.length === 0) return { ...newestRuntime, ...questionClock };
        return {
            ...newestRuntime,
            ...questionClock,
            metadata: {
                ...(metadataByFreshness[0] ?? {}),
                ...(newestRuntime.metadata ?? {}),
                ...(latestNamedMetadata?.name ? { name: latestNamedMetadata.name } : {}),
                ...(latestSummary ? { summary: latestSummary } : {}),
            },
        };
    });
}
