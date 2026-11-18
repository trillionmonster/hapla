import { describe, expect, it } from 'vitest';
import { buildCodexDiagnosticSummary } from './codexDiagnosticSummary';
import type { Machine, Session } from '@/sync/storageTypes';

describe('buildCodexDiagnosticSummary', () => {
    it('shows authoritative correlation, health and retained interrupt data together', () => {
        const session = {
            id: 'session', metadata: { host: 'host', path: '', codexThreadId: 'metadata-thread', version: '1.1.6' },
            agentState: { codexRuntime: {
                epoch: 'epoch', epochStartedAt: 1, seq: 17, updatedAt: 20,
                threadId: 'thread', turnId: 'turn', runtime: 'active', turn: 'running',
                activity: { phase: 'executing', itemType: 'commandExecution', itemId: 'item' },
                interrupt: 'none', pendingRequests: { 'request-1': { kind: 'userInput', turnId: 'turn', itemId: 'item' } },
                lastInterrupt: { turnId: 'old-turn', status: 'interrupted', at: 10 },
            } },
        } as unknown as Session;
        const machine = {
            active: true, activeAt: 30, daemonState: { status: 'running' },
            metadata: { happyCliVersion: '1.1.6', cliCapabilities: { codex: { version: '0.153.4' }, discoveredAt: 1 } },
        } as unknown as Machine;

        const rows = Object.fromEntries(buildCodexDiagnosticSummary(session, machine, 'connected').map(row => [row.label, row.value]));
        expect(rows['前端连接']).toBe('connected');
        expect(rows['CLI / App Server']).toBe('1.1.6 / 0.153.4');
        expect(rows['turnId / itemId']).toBe('turn / item');
        expect(rows['epoch / seq']).toBe('epoch / 17');
        expect(rows['待处理请求']).toBe('request-1:userInput@item');
        expect(rows['最近中断结果']).toContain('interrupted · old-turn');
    });
});
