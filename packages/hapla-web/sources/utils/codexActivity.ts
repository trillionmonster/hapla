export type VisibleCodexActivity = {
    phase: string;
    detail?: string;
    itemType?: string;
} | null | undefined;

function compact(detail: string | null | undefined): string | null {
    const normalized = detail?.replace(/\s+/g, ' ').trim();
    if (!normalized) return null;
    return normalized.length > 72 ? `${normalized.slice(0, 71)}…` : normalized;
}

export function formatCodexActivity(activity: VisibleCodexActivity, encryptedDetail?: string | null): string {
    const detail = compact(encryptedDetail ?? activity?.detail);
    const suffix = detail ? ` · ${detail}` : '';

    switch (activity?.phase) {
        case 'starting': return 'Codex · 正在初始化任务';
        case 'waitingUserInput': return 'Codex · 等待你回答';
        case 'waitingApproval': return 'Codex · 等待你的确认';
        case 'interruptRequested': return 'Codex · 正在中断';
        case 'reasoning': return 'Codex · 正在分析问题';
        case 'planning': return 'Codex · 正在制定计划';
        case 'searching': return `Codex · 正在搜索${suffix}`;
        case 'reading': return `Codex · 正在读取${suffix}`;
        case 'executing': return `Codex · 正在执行${suffix}`;
        case 'testing': return `Codex · 正在运行测试${suffix}`;
        case 'editing': return `Codex · 正在修改文件${suffix}`;
        case 'mcp': return `Codex · 正在调用工具${suffix}`;
        case 'generating-media': return `Codex · 正在生成媒体${suffix}`;
        case 'compacting': return 'Codex · 正在压缩上下文';
        case 'reviewing': return 'Codex · 正在审查更改';
        case 'outputting': return 'Codex · 正在输出回复';
        case 'working': return `Codex · 正在处理${suffix}`;
        default: return activity?.itemType
            ? `Codex · 正在处理 ${activity.itemType}`
            : 'Codex · 思考中';
    }
}

export function codexRuntimePresentation(state: CodexRuntimeState, pendingTools: string[] = []) {
    if (state.runtime === 'systemError') {
        return { text: state.interrupt === 'failed' ? 'Codex · 中断失败，可重试' : 'Codex · 运行状态异常', busy: isCodexTurnRunning(state), waiting: false, error: true };
    }
    const pending = Object.values(state.pendingRequests);
    if (pending.some((request) => request.kind === 'userInput' || request.kind === 'elicitation')
        || pendingTools.some((tool) => tool === 'AskUserQuestion' || /elicitation/i.test(tool))) {
        return { text: 'Codex · 等待你回答', busy: true, waiting: true, error: false };
    }
    if (pending.length > 0 || pendingTools.length > 0) {
        return { text: 'Codex · 等待你的确认', busy: true, waiting: true, error: false };
    }
    if (state.interrupt === 'failed') {
        return { text: 'Codex · 中断失败，可重试', busy: isCodexTurnRunning(state), waiting: false, error: true };
    }
    if (state.turn === 'interruptRequested') {
        return { text: state.activity?.phase === 'stoppingCommand' ? 'Codex · 正在中断，等待命令退出' : 'Codex · 正在中断', busy: true, waiting: false, error: false };
    }
    if (isCodexTurnRunning(state) || state.runtime === 'active') {
        return { text: formatCodexActivity(state.activity), busy: true, waiting: false, error: false };
    }
    if (state.runtime === 'loading') return { text: 'Codex · 正在恢复状态', busy: true, waiting: false, error: false };
    if (state.turn === 'failed') return { text: 'Codex · 执行失败', busy: false, waiting: false, error: true };
    if (state.turn === 'interrupted') return { text: 'Codex · 已中断', busy: false, waiting: false, error: false };
    return { text: 'Codex · 可继续', busy: false, waiting: false, error: false };
}
import { isCodexTurnRunning, type CodexRuntimeState } from '@hapla/wire';
