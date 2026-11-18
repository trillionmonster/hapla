import { describe, expect, it } from 'vitest';
import { claudePromptUploadRole, messageUploadRole } from './messageUploadRole';
import type { RawJSONLines } from '@/claude/types';

describe('message upload role', () => {
    it('classifies assistant text, tools and system records without user promotion', () => {
        expect(messageUploadRole({ role: 'agent', content: { type: 'codex' } })).toBe('agent');
        expect(messageUploadRole({ role: 'session', content: { role: 'agent', ev: { t: 'tool-call-end' } } })).toBe('agent');
        expect(messageUploadRole({ role: 'system' })).toBe('system');
        expect(messageUploadRole({ role: 'session', content: { role: 'user', subagent: 'child' } })).toBe('system');
    });

    it('leaves unknown and user-shaped envelopes unclassified', () => {
        for (const value of [null, {}, { role: 'user' }, { role: 'session', content: { role: 'user' } }]) {
            expect(messageUploadRole(value)).toBeUndefined();
        }
    });

    const startedAt = Date.now() - 1000;
    const message = (overrides: Record<string, unknown> = {}): RawJSONLines => ({
        type: 'user', uuid: 'question', timestamp: new Date(startedAt + 500).toISOString(),
        message: { content: 'Please fix the bug' }, ...overrides,
    } as RawJSONLines);

    it('marks a newly captured local human question', () => {
        expect(claudePromptUploadRole(message(), startedAt, true)).toBe('user');
    });

    it('marks SDK prompt echoes as system even with a fresh synthesized timestamp', () => {
        expect(claudePromptUploadRole(message(), startedAt, false)).toBe('system');
    });

    it('never promotes history or undated imports as fresh questions', () => {
        for (const timestamp of [undefined, 'invalid', new Date(startedAt - 1).toISOString(), new Date(Date.now() + 120_000).toISOString()]) {
            expect(claudePromptUploadRole(message({ timestamp }), startedAt, true)).toBeUndefined();
        }
    });

    it('excludes compaction, metadata, synthetic events, sidechains and tool results', () => {
        for (const flags of [{ isCompactSummary: true }, { isMeta: true }, { isSynthetic: true }, { isSidechain: true }]) {
            expect(claudePromptUploadRole(message(flags), startedAt, true)).toBe('system');
        }
        expect(claudePromptUploadRole(message({ message: { content: 'This session is being continued from a previous conversation that ran out of context.' } }), startedAt, true)).toBe('system');
        expect(claudePromptUploadRole(message({ message: { content: [{ type: 'tool_result', content: 'done' }] } }), startedAt, true)).toBeUndefined();
    });
});
