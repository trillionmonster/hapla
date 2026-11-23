import { describe, expect, it } from 'vitest';
import { MessageContentSchema } from './types';

describe('Codex follow-up metadata across wire and CLI schema versions', () => {
    it('accepts ordinary input and all delivery modes with a captured stop target', () => {
        const content = { role: 'user', content: { type: 'text', text: 'Continue' } };
        expect(MessageContentSchema.safeParse(content).success).toBe(true);
        for (const mode of ['steer', 'queue', 'replace']) {
            expect(MessageContentSchema.safeParse({ ...content, meta: { codexInputId: 'input-1', codexFollowupMode: mode,
                codexInterruptTarget: { epoch: 'runtime-1', threadId: 'thread-1', turnId: 'turn-1', startId: null },
            } }).success).toBe(true);
        }
        expect(MessageContentSchema.safeParse({ ...content, meta: { codexInterruptTarget: { turnId: 'turn-1' } } }).success).toBe(false);
    });
});
