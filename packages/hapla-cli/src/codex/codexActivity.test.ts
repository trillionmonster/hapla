import { describe, expect, it } from 'vitest';
import { activityForCodexItem } from './codexActivity';

describe('activityForCodexItem', () => {
    it.each([
        [{ type: 'reasoning' }, 'reasoning'],
        [{ type: 'plan' }, 'planning'],
        [{ type: 'commandExecution', command: 'rg -n TODO packages' }, 'searching'],
        [{ type: 'commandExecution', command: '/bin/bash -lc "set -o pipefail; rg -n TODO packages; sleep 2"' }, 'searching'],
        [{ type: 'commandExecution', command: 'sed -n 1,40p file.ts' }, 'reading'],
        [{ type: 'commandExecution', command: 'pnpm test' }, 'testing'],
        [{ type: 'commandExecution', command: 'node script.js' }, 'executing'],
        [{ type: 'fileChange', changes: [{ path: 'a.ts' }] }, 'editing'],
        [{ type: 'imageGeneration', prompt: 'blue whale' }, 'generating-media'],
        [{ type: 'contextCompaction' }, 'compacting'],
        [{ type: 'mcpToolCall', server: 'web', tool: 'search_query' }, 'searching'],
        [{ type: 'mcpToolCall', server: 'image_gen', tool: 'imagegen' }, 'generating-media'],
    ])('maps %j to %s', (item, phase) => {
        expect(activityForCodexItem(item).phase).toBe(phase);
    });

    it('preserves unknown item types as forward-compatible working activity', () => {
        expect(activityForCodexItem({ type: 'futureAmazingItem' })).toEqual({
            phase: 'working',
            detail: 'future amazing item',
            itemType: 'futureAmazingItem',
        });
    });
});
