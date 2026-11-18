import type { AgentEvent } from '@/sync/typesRaw';

/** Legacy CLI resume notices are transport diagnostics, not conversation content. */
export function isConversationAgentEvent(event: AgentEvent): boolean {
    if (event.type !== 'message') return true;
    return !/^Resumed Codex thread [A-Za-z0-9_-]+$/.test(event.message.trim());
}
