import { describe, expect, it } from 'vitest';
import type { ToolCall } from '@/sync/typesMessage';
import { shouldShowToolInNormalMode } from './toolVisibility';

function tool(name: string, input: unknown = {}): ToolCall {
    return {
        name,
        input,
        state: 'completed',
        createdAt: 1,
        startedAt: 1,
        completedAt: 2,
        description: null,
    };
}

describe('shouldShowToolInNormalMode', () => {
    it('keeps image generation visible', () => {
        expect(shouldShowToolInNormalMode(tool('CodexImageGeneration'))).toBe(true);
    });

    it('keeps embedded Skill apps visible', () => {
        expect(shouldShowToolInNormalMode(tool('mcp__composer__render', {
            __haplaMcpApp: { resourceUri: 'ui://hapla/composer.html' },
        }))).toBe(true);
    });

    it('hides coding implementation details', () => {
        expect(shouldShowToolInNormalMode(tool('CodexBash'))).toBe(false);
        expect(shouldShowToolInNormalMode(tool('CodexPatch'))).toBe(false);
    });
});


it('always shows question cards and unresolved approvals regardless of workspace mode', () => {
    expect(shouldShowToolInNormalMode(tool('AskUserQuestion'))).toBe(true);
    for (const status of ['pending', 'submitting'] as const) {
        expect(shouldShowToolInNormalMode({ ...tool('CodexBash'), state: 'running', permission: { id: 'scoped-request', status } })).toBe(true);
        expect(shouldShowToolInNormalMode({ ...tool('McpElicitation'), state: 'running', permission: { id: 'form', status } })).toBe(true);
    }
    expect(shouldShowToolInNormalMode({ ...tool('CodexBash'), permission: { id: 'done', status: 'approved' } })).toBe(false);
});
