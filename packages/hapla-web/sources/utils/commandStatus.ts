import type { ToolCall } from '@/sync/typesMessage';

/** A turn ending alone does not prove the command exited. */
export function commandStatus(tool: ToolCall): string {
    const result = tool.result && typeof tool.result === 'object' ? tool.result : {};
    if (tool.state === 'running') return '正在执行';
    if (result.commandNotStarted === true) return '未执行 · 审批前已取消';
    if (tool.completedByTurn || result.completedByTurn === true) {
        return `${result.status === 'interrupted' ? '任务已中断' : '任务失败'} · 命令终态待确认`;
    }
    const label = result.status === 'interrupted' ? '已中断' : tool.state === 'error' ? '执行失败' : '已完成';
    return typeof result.exitCode === 'number' ? `${label} · 退出码 ${result.exitCode}` : label;
}
