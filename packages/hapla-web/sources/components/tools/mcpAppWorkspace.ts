import * as React from 'react';
import type { Message, ToolCall } from '@/sync/typesMessage';

type WorkspaceSnapshot = { key: string; tool: ToolCall } | null;

const active = new Map<string, WorkspaceSnapshot>();
const listeners = new Set<() => void>();

function emit() {
    for (const listener of listeners) listener();
}

function appKey(tool: ToolCall): string | null {
    const descriptor = tool.input?.__haplaMcpApp ?? tool.result?.__haplaMcpApp;
    if (!descriptor || typeof descriptor !== 'object' || typeof descriptor.resourceUri !== 'string') return null;
    return [descriptor.server, descriptor.tool, descriptor.resourceUri, tool.createdAt].join(':');
}

export function openMcpAppWorkspace(sessionId: string, tool: ToolCall): void {
    const key = appKey(tool);
    if (!key) return;
    const current = active.get(sessionId);
    if (current?.key === key && current.tool === tool) return;
    active.set(sessionId, { key, tool });
    emit();
}

export function closeMcpAppWorkspace(sessionId: string): void {
    if (active.delete(sessionId)) emit();
}

export function useMcpAppWorkspace(sessionId: string): WorkspaceSnapshot {
    const subscribe = React.useCallback((listener: () => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
    }, []);
    const getSnapshot = React.useCallback(() => active.get(sessionId) ?? null, [sessionId]);
    return React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export function findLatestMcpApp(messages: Message[]): { key: string; tool: ToolCall } | null {
    let latest: { key: string; tool: ToolCall } | null = null;
    const visit = (items: Message[]) => {
        for (const message of items) {
            if (message.kind !== 'tool-call') continue;
            const key = appKey(message.tool);
            if (key && (!latest || message.tool.createdAt >= latest.tool.createdAt)) {
                latest = { key, tool: message.tool };
            }
            visit(message.children);
        }
    };
    visit(messages);
    return latest;
}
