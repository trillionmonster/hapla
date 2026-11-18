import { afterEach, expect, it, vi } from 'vitest';
import { SessionStreamBatcher } from './sessionStreamBatcher';
afterEach(() => vi.useRealTimers());
it('coalesces rapid snapshots by item without dropping other tools or the summary, and ignores out-of-order frames', () => {
    vi.useFakeTimers(); const apply = vi.fn(); const batcher = new SessionStreamBatcher(apply);
    for (let seq = 0; seq < 100; seq++) batcher.enqueue('s', { id: 'tool', kind: 'tool-output', turnId: 't', seq, text: `${seq}`, updatedAt: seq });
    batcher.enqueue('s', { id: 'tool', kind: 'tool-output', turnId: 't', seq: 3, text: 'old', updatedAt: 101 });
    batcher.enqueue('s', { id: 'summary', kind: 'reasoning-summary', turnId: 't', seq: 1, text: 'summary', updatedAt: 1 });
    batcher.enqueue('s', { id: 'another-tool', kind: 'tool-output', turnId: 't', seq: 1, text: 'independent output', updatedAt: 1 });
    expect(apply).not.toHaveBeenCalled(); vi.advanceTimersByTime(50);
    expect(apply).toHaveBeenCalledTimes(3);
    expect(apply.mock.calls.map(([, stream]) => stream.text)).toEqual(['99', 'summary', 'independent output']);
    expect(batcher.getStats()).toEqual({ sessions: 0, items: 0 });
});
it('flushes the last preview before persistence and cancels all queued work on unload', () => {
    vi.useFakeTimers(); const apply = vi.fn(); const batcher = new SessionStreamBatcher(apply);
    batcher.enqueue('s', { id: 'tool', turnId: 't', text: 'last preview', updatedAt: 1 });
    batcher.flush('s'); expect(apply).toHaveBeenCalledTimes(1);
    batcher.enqueue('s', { id: 'tool', turnId: 't', text: 'must be released', updatedAt: 2 });
    batcher.clear('s'); vi.runAllTimers();
    expect(apply).toHaveBeenCalledTimes(1); expect(batcher.getStats().items).toBe(0);
});
