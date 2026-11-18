import { describe, expect, it } from 'vitest';
import { codexRuntimePresentation, formatCodexActivity } from './codexActivity';
import { reduceCodexRuntimeEvent } from '@hapla/wire';

describe('formatCodexActivity', () => {
    it('keeps interruption pending after RPC acknowledgement', () => {
        const initial = reduceCodexRuntimeEvent(null, { type: 'codex_runtime_started', protocol: { epoch: 'one', epochStartedAt: 1, seq: 1 } });
        const running = reduceCodexRuntimeEvent(initial, { type: 'task_started', protocol: { epoch: 'one', seq: 2, turnId: 'turn' } });
        const pending = reduceCodexRuntimeEvent(running, { type: 'codex_interrupt', status: 'acknowledged', protocol: { epoch: 'one', seq: 3, turnId: 'turn' } })!;
        expect(codexRuntimePresentation(pending).text).toBe('Codex · 正在中断');
        expect(codexRuntimePresentation(pending, ['AskUserQuestion']).text).toBe('Codex · 等待你回答');
    });
    it.each([
        ['starting', 'Codex · 正在初始化任务'],
        ['reasoning', 'Codex · 正在分析问题'],
        ['planning', 'Codex · 正在制定计划'],
        ['searching', 'Codex · 正在搜索'],
        ['reading', 'Codex · 正在读取'],
        ['testing', 'Codex · 正在运行测试'],
        ['editing', 'Codex · 正在修改文件'],
        ['mcp', 'Codex · 正在调用工具'],
        ['generating-media', 'Codex · 正在生成媒体'],
        ['compacting', 'Codex · 正在压缩上下文'],
        ['reviewing', 'Codex · 正在审查更改'],
        ['outputting', 'Codex · 正在输出回复'],
    ])('formats %s', (phase, expected) => {
        expect(formatCodexActivity({ phase })).toBe(expected);
    });

    it('uses encrypted message detail without exposing an unbounded line', () => {
        expect(formatCodexActivity({ phase: 'executing' }, 'pnpm test')).toBe('Codex · 正在执行 · pnpm test');
        expect(formatCodexActivity({ phase: 'future', itemType: 'futureItem' })).toBe('Codex · 正在处理 futureItem');
    });
});
