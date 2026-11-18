import { describe, expect, it } from 'vitest';
import { createId, isCuid } from '@paralleldrive/cuid2';
import {
    mapCodexMcpMessageToSessionEnvelopes,
    mapCodexProcessorMessageToSessionEnvelopes,
} from '../utils/sessionProtocolMapper';

describe('mapCodexMcpMessageToSessionEnvelopes', () => {
    it.each([
        { message: 'stream disconnected before completion: stream closed before response.completed', codexErrorInfo: 'other' },
        'stream disconnected before completion: stream closed before response.completed',
    ])('persists the provider failure reason as visible conversation content', error => {
        const failed = mapCodexMcpMessageToSessionEnvelopes({
            type: 'task_complete', turn_id: 'failed-turn', status: 'failed', error,
        }, { currentTurnId: 'failed-turn' });
        expect(failed.envelopes.map(envelope => ({ turn: envelope.turn, ev: envelope.ev }))).toEqual([
            { turn: 'failed-turn', ev: { t: 'service', text: 'Codex 执行失败：stream disconnected before completion: stream closed before response.completed' } },
            { turn: 'failed-turn', ev: { t: 'turn-end', status: 'failed' } },
        ]);
        expect(mapCodexMcpMessageToSessionEnvelopes({ type: 'task_complete', turn_id: 'failed-turn', status: 'failed', error }, failed).envelopes).toEqual([]);
    });

    it('still shows an explanation when a failed turn omits its error details', () => {
        const failed = mapCodexMcpMessageToSessionEnvelopes({ type: 'task_complete', status: 'failed' }, { currentTurnId: 'failed-turn' });
        expect(failed.envelopes[0].ev).toEqual({ t: 'service', text: 'Codex 执行失败：本轮未正常完成，Codex 未提供具体错误信息。' });
    });

    it('starts and ends turns for task lifecycle events', () => {
        const started = mapCodexMcpMessageToSessionEnvelopes({ type: 'task_started' }, { currentTurnId: null });

        expect(started.envelopes).toHaveLength(1);
        expect(started.envelopes[0].ev.t).toBe('turn-start');
        expect(started.envelopes[0].turn).toBe(started.currentTurnId);
        expect(started.envelopes[0].turn).not.toBe(started.envelopes[0].id);

        const ended = mapCodexMcpMessageToSessionEnvelopes({ type: 'task_complete' }, { currentTurnId: started.currentTurnId });
        expect(ended.envelopes).toHaveLength(1);
        expect(ended.envelopes[0].ev.t).toBe('turn-end');
        if (ended.envelopes[0].ev.t === 'turn-end') {
            expect(ended.envelopes[0].ev.status).toBe('completed');
        }
        expect(ended.envelopes[0].turn).toBe(started.currentTurnId);
        expect(ended.currentTurnId).toBeNull();
    });

    it('maps abort lifecycle with cancelled turn-end status', () => {
        const result = mapCodexMcpMessageToSessionEnvelopes(
            { type: 'turn_aborted' },
            { currentTurnId: 'turn-1' }
        );

        expect(result.envelopes).toHaveLength(1);
        expect(result.envelopes[0].ev).toEqual({
            t: 'turn-end',
            status: 'cancelled',
        });
        expect(result.currentTurnId).toBeNull();
    });

    it('maps agent text messages with turn context', () => {
        const result = mapCodexMcpMessageToSessionEnvelopes(
            { type: 'agent_message', message: 'hello' },
            { currentTurnId: 'turn-1' }
        );

        expect(result.envelopes).toHaveLength(1);
        expect(result.envelopes[0].turn).toBe('turn-1');
        expect(result.envelopes[0].ev).toEqual({ t: 'text', text: 'hello' });
    });

    it('uses the Codex item id as the durable reply id', () => {
        const result = mapCodexMcpMessageToSessionEnvelopes(
            { type: 'agent_message', item_id: 'agent-item-1', message: 'hello' },
            { currentTurnId: 'turn-1' },
        );
        expect(result.envelopes[0].id).toBe('agent-item-1');
    });

    it('preserves structured asynchronous questions rather than reducing them to plain text', () => {
        const questions = [{ title: 'Pick a direction', options: ['Continue', 'Stop'] }, { title: 'Anything else?', options: null }];
        const result = mapCodexMcpMessageToSessionEnvelopes(
            { type: 'agent_message', item_id: 'async-question-1', message: 'Pick a direction\n- Continue\n- Stop', delivery: 'async', questions },
            { currentTurnId: 'turn-1' },
        );
        expect(result.envelopes).toEqual([expect.objectContaining({
            id: 'async-question-1', turn: 'turn-1', ev: { t: 'text', text: 'Pick a direction\n- Continue\n- Stop', delivery: 'async', questions },
        })]);
    });

    it('maps parent call linkage to subagent field', () => {
        const result = mapCodexMcpMessageToSessionEnvelopes(
            { type: 'agent_message', message: 'subagent hello', parent_call_id: 'parent-call-1' },
            { currentTurnId: 'turn-1' }
        );

        expect(result.envelopes).toHaveLength(2);
        const subagent = result.envelopes[1].subagent;
        expect(typeof subagent).toBe('string');
        expect(isCuid(subagent!)).toBe(true);
        expect(result.envelopes[0]).toMatchObject({
            subagent,
            ev: { t: 'start' },
        });
        expect(subagent).not.toBe('parent-call-1');
    });

    it('emits stop for active subagents before turn-end', () => {
        const subagent = createId();
        const activeSubagents = new Set<string>([subagent]);
        const startedSubagents = new Set<string>([subagent]);
        const result = mapCodexMcpMessageToSessionEnvelopes(
            { type: 'task_complete' },
            { currentTurnId: 'turn-1', activeSubagents, startedSubagents }
        );

        expect(result.envelopes).toHaveLength(2);
        expect(result.envelopes[0]).toMatchObject({
            subagent,
            ev: { t: 'stop' },
        });
        expect(result.envelopes[1].ev).toEqual({
            t: 'turn-end',
            status: 'completed',
        });
    });

    it('maps exec command begin to tool-call-start', () => {
        const result = mapCodexMcpMessageToSessionEnvelopes(
            {
                type: 'exec_command_begin',
                call_id: 'call-1',
                command: 'ls -la',
                cwd: '/tmp',
            },
            { currentTurnId: 'turn-1' }
        );

        expect(result.envelopes).toHaveLength(1);
        const envelope = result.envelopes[0];
        expect(envelope.ev.t).toBe('tool-call-start');
        if (envelope.ev.t === 'tool-call-start') {
            expect(envelope.ev.call).toBe('call-1');
            expect(envelope.ev.name).toBe('CodexBash');
            expect(envelope.ev.title).toContain('Run `ls -la`');
            expect(envelope.ev.args).toEqual({ command: 'ls -la', cwd: '/tmp' });
        }
    });

    it('skips token_count messages', () => {
        const result = mapCodexMcpMessageToSessionEnvelopes(
            { type: 'token_count', total_tokens: 10 },
            { currentTurnId: 'turn-1' }
        );

        expect(result.envelopes).toHaveLength(0);
        expect(result.currentTurnId).toBe('turn-1');
    });

    it('preserves authoritative provider turn ids and rejects a previous turn completion', () => {
        const start = mapCodexMcpMessageToSessionEnvelopes({ type: 'task_started', turn_id: 'provider-turn-2' }, { currentTurnId: null });
        expect(start.currentTurnId).toBe('provider-turn-2');
        const staleEnd = mapCodexMcpMessageToSessionEnvelopes({ type: 'task_complete', turn_id: 'provider-turn-1' }, start);
        expect(staleEnd.currentTurnId).toBe('provider-turn-2');
        expect(staleEnd.envelopes).toEqual([]);
    });

    it('keeps late completed content associated with its provider turn after the turn boundary', () => {
        const message = mapCodexMcpMessageToSessionEnvelopes({
            type: 'agent_message', item_id: 'reply-a', message: 'final text', protocol: { turnId: 'provider-turn-a' },
        }, { currentTurnId: null });
        expect(message.envelopes[0]).toMatchObject({ id: 'reply-a', turn: 'provider-turn-a', ev: { text: 'final text' } });
    });

    it('retains bounded Shell output and terminal metadata', () => {
        const result = mapCodexMcpMessageToSessionEnvelopes({
            type: 'exec_command_end', call_id: 'shell-a', output: 'failed\n', command: ['npm', 'test'],
            cwd: '/workspace', exit_code: 2, duration_ms: 120, status: 'failed',
            truncated: true, totalBytes: 10_000_000, logPath: '.hapla/command-logs/a.log',
        }, { currentTurnId: 'turn-1' });
        expect(result.envelopes[0].ev).toMatchObject({
            t: 'tool-call-end', call: 'shell-a', stdout: 'failed\n', outputTruncated: true, isError: true,
            result: {
                output: 'failed\n', command: 'npm test', cwd: '/workspace', exitCode: 2,
                durationMs: 120, status: 'failed', truncated: true, totalBytes: 10_000_000,
                logPath: '.hapla/command-logs/a.log',
            },
        });
    });

    it('only exposes user-visible reasoning summaries', () => {
        const result = mapCodexMcpMessageToSessionEnvelopes({
            type: 'codex_item', method: 'item/completed',
            item: { type: 'reasoning', id: 'reasoning-a', summary: ['Visible summary'], content: ['Hidden reasoning'] },
        }, { currentTurnId: 'turn-1' });
        expect(result.envelopes[0]).toMatchObject({ id: 'reasoning-a', ev: { t: 'text', text: 'Visible summary', thinking: true, summary: true } });
        const hiddenOnly = mapCodexMcpMessageToSessionEnvelopes({
            type: 'codex_item', method: 'item/completed', item: { type: 'reasoning', id: 'reasoning-b', content: ['Hidden reasoning'] },
        }, { currentTurnId: 'turn-1' });
        expect(hiddenOnly.envelopes).toEqual([]);
    });

    it('persists only explicit final summaries with their streaming item identity', () => {
        const state = { currentTurnId: 'turn-1' };
        expect(mapCodexMcpMessageToSessionEnvelopes({ type: 'agent_reasoning', text: 'hidden', item_id: 'raw' }, state).envelopes).toEqual([]);
        expect(mapCodexMcpMessageToSessionEnvelopes({ type: 'agent_reasoning_delta', summary: true, delta: 'visible partial', item_id: 'summary' }, state).envelopes).toEqual([]);
        const result = mapCodexMcpMessageToSessionEnvelopes({ type: 'agent_reasoning', summary: true, text: 'Visible final summary', item_id: 'summary' }, state);
        expect(result.envelopes).toHaveLength(1);
        expect(result.envelopes[0]).toMatchObject({ id: 'summary', turn: 'turn-1', ev: { t: 'text', thinking: true, summary: true, text: 'Visible final summary' } });
    });

    it('surfaces image provider diagnostics as visible service text', () => {
        const result = mapCodexMcpMessageToSessionEnvelopes({
            type: 'image_generation_error',
            message: 'image generation failed: http 401 Unauthorized: Your IP is not authorized',
        }, { currentTurnId: 'turn-1' });

        expect(result.envelopes).toHaveLength(1);
        expect(result.envelopes[0]).toMatchObject({
            role: 'agent',
            turn: 'turn-1',
            ev: {
                t: 'service',
                text: expect.stringContaining('401 Unauthorized'),
            },
        });
    });

    it('maps an MCP Apps tool call and preserves its resource URI', () => {
        const start = mapCodexMcpMessageToSessionEnvelopes({
            type: 'mcp_tool_call_begin',
            call_id: 'mcp-1',
            server: 'character-composer',
            tool: 'render_character_composer',
            arguments: { face: 3 },
            resource_uri: 'ui://hapla/character-composer/v1.html',
            app_context: { appName: '人物组合器' },
        }, { currentTurnId: 'turn-1' });

        expect(start.envelopes).toHaveLength(1);
        expect(start.envelopes[0].ev).toMatchObject({
            t: 'tool-call-start',
            call: 'mcp-1',
            name: 'mcp__character-composer__render_character_composer',
            args: {
                face: 3,
                __haplaMcpApp: {
                    server: 'character-composer',
                    resourceUri: 'ui://hapla/character-composer/v1.html',
                },
            },
        });

        const end = mapCodexMcpMessageToSessionEnvelopes({
            type: 'mcp_tool_call_end',
            call_id: 'mcp-1',
            server: 'character-composer',
            tool: 'render_character_composer',
            resource_uri: 'ui://hapla/character-composer/v1.html',
            status: 'completed',
            result: { structuredContent: { selection: { face: 3 } } },
        }, { currentTurnId: 'turn-1' });

        expect(end.envelopes[0].ev).toMatchObject({
            t: 'tool-call-end',
            call: 'mcp-1',
            isError: false,
            result: {
                value: { structuredContent: { selection: { face: 3 } } },
                __haplaMcpApp: { resourceUri: 'ui://hapla/character-composer/v1.html' },
            },
        });
    });
});

describe('mapCodexProcessorMessageToSessionEnvelopes', () => {
    it('maps reasoning tool lifecycle to start/text/end session events', () => {
        const startEvents = mapCodexProcessorMessageToSessionEnvelopes({
            type: 'tool-call',
            callId: 'reasoning-1',
            name: 'CodexReasoning',
            input: { title: 'Plan changes' },
            id: 'legacy-id-1',
        }, { currentTurnId: 'turn-1' });

        expect(startEvents).toHaveLength(1);
        expect(startEvents[0].ev.t).toBe('tool-call-start');

        const endEvents = mapCodexProcessorMessageToSessionEnvelopes({
            type: 'tool-call-result',
            callId: 'reasoning-1',
            output: { content: 'Step 1, Step 2', status: 'completed' },
            id: 'legacy-id-2',
        }, { currentTurnId: 'turn-1' });

        expect(endEvents).toHaveLength(2);
        expect(endEvents[0].ev.t).toBe('text');
        if (endEvents[0].ev.t === 'text') {
            expect(endEvents[0].ev.thinking).toBe(true);
        }
        expect(endEvents[1].ev).toEqual({ t: 'tool-call-end', call: 'reasoning-1' });
    });

    it('maps reasoning text to thinking text event', () => {
        const events = mapCodexProcessorMessageToSessionEnvelopes({
            type: 'reasoning',
            message: 'Working through options',
            id: 'legacy-id-3',
        }, { currentTurnId: 'turn-1' });

        expect(events).toHaveLength(1);
        expect(events[0].ev).toEqual({
            t: 'text',
            text: 'Working through options',
            thinking: true,
        });
    });
});
