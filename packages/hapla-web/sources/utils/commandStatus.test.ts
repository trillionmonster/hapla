import { describe, expect, it } from 'vitest';
import type { ToolCall } from '@/sync/typesMessage';
import { commandStatus } from './commandStatus';

const tool = (fields: Partial<ToolCall>): ToolCall => ({ name: 'CodexBash', state: 'running', input: {}, createdAt: 1, startedAt: 1, completedAt: null, description: null, ...fields });
describe('command status evidence', () => {
    it('does not call a command interrupted solely because its turn ended', () => {
        expect(commandStatus(tool({ state: 'error', completedByTurn: true, result: { status: 'interrupted' } }))).toBe('任务已中断 · 命令终态待确认');
    });
    it('identifies a command canceled before approval without inventing an exit code', () => {
        expect(commandStatus(tool({ state: 'error', completedByTurn: true, result: { commandNotStarted: true, status: 'interrupted', exitCode: null } }))).toBe('未执行 · 审批前已取消');
    });
    it('shows the actual late successful exit after an interrupted turn', () => {
        expect(commandStatus(tool({ state: 'completed', result: { status: 'completed', exitCode: 0 } }))).toBe('已完成 · 退出码 0');
    });
    it('distinguishes failed and confirmed interrupted commands', () => {
        expect(commandStatus(tool({ state: 'error', result: { exitCode: 7 } }))).toBe('执行失败 · 退出码 7');
        expect(commandStatus(tool({ state: 'error', result: { status: 'interrupted' } }))).toBe('已中断');
        expect(commandStatus(tool({}))).toBe('正在执行');
    });
});
