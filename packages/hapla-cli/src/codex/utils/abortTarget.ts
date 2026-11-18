type AbortTarget = { epoch: string | null; threadId: string | null; turnId: string | null; turn?: string; startId?: string | null };

/** Validate the UI's captured target before resolving approvals or joining an in-flight interrupt. */
export function assertCodexAbortTarget(params: unknown, current: AbortTarget): void {
    if (!params || typeof params !== 'object') return;
    const request = params as Record<string, unknown>;
    const scoped = ['epoch', 'threadId', 'turnId', 'requestId'].some((key) => key in request);
    if (!scoped) return; // Legacy clients and internal runtime-stop calls have no captured target.
    const matchesStartingTurn = request.turnId === null && current.turn === 'starting'
        && typeof request.startId === 'string' && request.startId.length > 0 && request.startId === current.startId;
    const matchesTurn = matchesStartingTurn || (typeof request.turnId === 'string' && request.turnId === current.turnId);
    if (typeof request.epoch !== 'string' || request.epoch !== current.epoch
        || typeof request.threadId !== 'string' || request.threadId !== current.threadId
        || !matchesTurn
        || typeof request.requestId !== 'string' || request.requestId.length === 0) {
        throw new Error('This stop request belongs to a previous Codex runtime, branch or turn. Refresh the current state before retrying.');
    }
}
