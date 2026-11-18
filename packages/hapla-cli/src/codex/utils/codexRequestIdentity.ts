export type CodexServerRequestContext = {
    epoch: string;
    requestId: string | number;
    threadId?: string;
    turnId?: string;
    itemId?: string;
};

export function codexRequestIdentity(context: CodexServerRequestContext): string {
    return JSON.stringify(['codex-request', context.epoch, typeof context.requestId, context.requestId]);
}
