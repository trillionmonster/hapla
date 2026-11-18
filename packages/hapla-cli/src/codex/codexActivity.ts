export type CodexActivity = {
    phase: string;
    detail?: string;
    itemType?: string;
};

function compact(value: unknown, limit = 160): string | undefined {
    if (typeof value !== 'string') return undefined;
    const normalized = value.replace(/\s+/g, ' ').trim();
    if (!normalized) return undefined;
    return normalized.length > limit ? `${normalized.slice(0, limit - 1)}…` : normalized;
}

function commandText(command: unknown): string | undefined {
    if (Array.isArray(command)) return compact(command.map(String).join(' '));
    return compact(command);
}

function humanize(value: string): string {
    return value.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').toLowerCase();
}

function commandPhase(command: string): string {
    if (/\b(?:test|vitest|jest|playwright|cypress|pytest|cargo\s+test|go\s+test|pnpm\s+check|npm\s+test)\b/i.test(command)) return 'testing';
    if (/\b(?:rg|grep|find|fd)\b|git\s+(?:grep|log)\b/i.test(command)) return 'searching';
    if (/\b(?:cat|sed|head|tail|less|ls|stat|wc)\b|git\s+(?:diff|show|status)\b/i.test(command)) return 'reading';
    return 'executing';
}

export function activityForCodexItem(item: Record<string, unknown>): CodexActivity {
    const itemType = typeof item.type === 'string' && item.type ? item.type : 'unknown';

    if (itemType === 'userMessage') return { phase: 'starting', itemType };
    if (itemType === 'reasoning') return { phase: 'reasoning', itemType };
    if (itemType === 'plan') return { phase: 'planning', itemType };
    if (itemType === 'agentMessage') return { phase: 'outputting', itemType };
    if (itemType === 'contextCompaction') return { phase: 'compacting', itemType };
    if (itemType === 'enteredReviewMode' || itemType === 'exitedReviewMode') {
        return { phase: 'reviewing', itemType };
    }
    if (itemType === 'imageGeneration') {
        return { phase: 'generating-media', detail: compact(item.prompt), itemType };
    }
    if (itemType === 'fileChange') {
        const count = Array.isArray(item.changes)
            ? item.changes.length
            : (item.changes && typeof item.changes === 'object' ? Object.keys(item.changes).length : 0);
        return { phase: 'editing', ...(count > 0 ? { detail: `${count} file${count === 1 ? '' : 's'}` } : {}), itemType };
    }
    if (itemType === 'commandExecution') {
        const detail = commandText(item.command);
        return { phase: detail ? commandPhase(detail) : 'executing', ...(detail ? { detail } : {}), itemType };
    }
    if (itemType === 'mcpToolCall') {
        const server = compact(item.server, 60);
        const tool = compact(item.tool, 80);
        const detail = [server, tool].filter(Boolean).join(' / ') || undefined;
        const identity = `${server ?? ''} ${tool ?? ''}`;
        const phase = /image|audio|video|media|render|generate/i.test(identity)
            ? 'generating-media'
            : (/search|browser|web|fetch/i.test(identity) ? 'searching' : 'mcp');
        return { phase, ...(detail ? { detail } : {}), itemType };
    }
    if (/search/i.test(itemType)) return { phase: 'searching', detail: compact(item.query), itemType };
    if (/read|list/i.test(itemType)) return { phase: 'reading', detail: compact(item.path), itemType };

    return { phase: 'working', detail: humanize(itemType), itemType };
}
