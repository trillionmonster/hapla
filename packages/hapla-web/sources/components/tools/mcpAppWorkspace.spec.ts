import { describe, expect, it } from 'vitest';
import type { Message, ToolCall } from '@/sync/typesMessage';
import { findLatestMcpApp } from './mcpAppWorkspace';

function tool(createdAt: number, resourceUri?: string): ToolCall {
    return {
        name: 'mcp__composer__render',
        state: 'completed',
        createdAt,
        startedAt: createdAt,
        completedAt: createdAt + 1,
        description: null,
        input: resourceUri ? {
            __haplaMcpApp: { server: 'composer', tool: 'render', resourceUri },
        } : {},
    };
}

function call(id: string, value: ToolCall, children: Message[] = []): Message {
    return { kind: 'tool-call', id, localId: null, createdAt: value.createdAt, tool: value, children };
}

describe('findLatestMcpApp', () => {
    it('finds the newest interactive app across nested tool messages', () => {
        const oldApp = tool(10, 'ui://composer/old.html');
        const latestApp = tool(30, 'ui://composer/latest.html');
        const messages: Message[] = [
            call('plain', tool(40)),
            call('parent', oldApp, [call('nested', latestApp)]),
        ];

        const result = findLatestMcpApp(messages);
        expect(result?.tool).toBe(latestApp);
        expect(result?.key).toContain('ui://composer/latest.html');
    });

    it('returns null when no tool carries an interactive app descriptor', () => {
        expect(findLatestMcpApp([call('plain', tool(1))])).toBeNull();
    });
});
