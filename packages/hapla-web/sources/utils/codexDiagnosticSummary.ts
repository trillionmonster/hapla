import type { Machine, Session } from '@/sync/storageTypes';

export type CodexDiagnosticRow = { label: string; value: string };

function when(timestamp: number | null | undefined): string {
    return typeof timestamp === 'number' && Number.isFinite(timestamp)
        ? new Date(timestamp).toLocaleString()
        : '未知';
}

/** A compact, decrypted snapshot for the explicit developer diagnostics modal. */
export function buildCodexDiagnosticSummary(
    session: Session,
    machine: Machine | null | undefined,
    socketStatus: string,
): CodexDiagnosticRow[] {
    const runtime = session.agentState?.codexRuntime;
    const requests = runtime
        ? Object.entries(runtime.pendingRequests).map(([id, request]) => (
            `${id}:${request.kind}${request.itemId ? `@${request.itemId}` : ''}`
        )).join(', ')
        : '';
    const lastInterrupt = runtime?.lastInterrupt;
    const appServerVersion = machine?.metadata?.cliCapabilities?.codex?.version
        ?? machine?.metadata?.codexVersion
        ?? '未知';
    const machineState = !machine
        ? '未找到'
        : `${machine.active ? '在线' : '离线'} · ${machine.daemonState?.status ?? 'daemon 状态未知'}`;

    return [
        { label: '前端连接', value: socketStatus },
        { label: '机器 / 心跳', value: `${machineState} · ${when(machine?.activeAt)}` },
        { label: 'CLI / App Server', value: `${session.metadata?.version ?? '未知'} / ${appServerVersion}` },
        { label: 'Runtime', value: runtime ? `${runtime.runtime} · ${runtime.turn} · ${runtime.activity?.phase ?? '无活动'}` : '无权威状态' },
        { label: 'threadId', value: runtime?.threadId ?? session.metadata?.codexThreadId ?? '无' },
        { label: 'turnId / itemId', value: `${runtime?.turnId ?? '无'} / ${runtime?.activity?.itemId ?? '无'}` },
        { label: 'epoch / seq', value: runtime ? `${runtime.epoch} / ${runtime.seq}` : '无' },
        { label: '最近协议事件', value: when(runtime?.updatedAt) },
        { label: '待处理请求', value: requests || '无' },
        {
            label: '最近中断结果',
            value: lastInterrupt
                ? `${lastInterrupt.status} · ${lastInterrupt.turnId} · ${when(lastInterrupt.at)}`
                : '无',
        },
    ];
}
