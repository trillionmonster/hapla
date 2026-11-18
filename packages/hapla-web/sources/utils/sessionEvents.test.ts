import { describe, expect, it } from 'vitest';
import { isConversationAgentEvent } from './sessionEvents';

describe('isConversationAgentEvent', () => {
    it('hides legacy transport-only Codex resume notices', () => {
        expect(isConversationAgentEvent({ type: 'message', message: 'Resumed Codex thread 01abc-123' })).toBe(false);
    });

    it('keeps user-facing events and similarly worded normal messages', () => {
        expect(isConversationAgentEvent({ type: 'message', message: 'Codex thread resumed successfully.' })).toBe(true);
        expect(isConversationAgentEvent({ type: 'switch', mode: 'local' })).toBe(true);
    });
});
