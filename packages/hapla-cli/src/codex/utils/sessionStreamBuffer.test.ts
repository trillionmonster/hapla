import { afterEach, describe, expect, it, vi } from 'vitest';
import { CodexSessionStreamBuffer, type CodexStreamSnapshot } from './sessionStreamBuffer';

afterEach(() => vi.useRealTimers());

describe('CodexSessionStreamBuffer', () => {
    it('publishes the final text before persistence and retains it through turn completion until acknowledgement', () => {
        vi.useFakeTimers();
        const snapshots: CodexStreamSnapshot[] = [];
        const streams = new CodexSessionStreamBuffer((snapshot) => snapshots.push(snapshot));
        streams.append({ id: 'item-1', turnId: 'turn-1', branchId: 'branch-a' }, 'hel');
        streams.append({ id: 'item-1', turnId: 'turn-1', branchId: 'branch-a' }, 'lo');
        const acknowledged = streams.finish('item-1', 'hello!');
        expect(snapshots.at(-1)).toMatchObject({ id: 'item-1', text: 'hello!', seq: 3 });
        streams.flushTurn('turn-1');
        expect(snapshots.at(-1)?.text).toBe('hello!');
        const count = snapshots.length;
        acknowledged();
        streams.flushTurn('turn-1');
        vi.runAllTimers();
        expect(snapshots).toHaveLength(count);
        streams.dispose();
    });

    it('flushes throttled text with its original turn and branch while other turns start', () => {
        vi.useFakeTimers();
        const publish = vi.fn();
        const streams = new CodexSessionStreamBuffer(publish);
        streams.append({ id: 'a', turnId: 'turn-a', branchId: 'branch-a' }, 'first');
        streams.append({ id: 'a', turnId: 'turn-a', branchId: 'branch-a' }, ' tail');
        streams.append({ id: 'b', turnId: 'turn-b', branchId: 'branch-b' }, 'next');
        vi.advanceTimersByTime(80);
        expect(publish).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'a', turnId: 'turn-a', branchId: 'branch-a', text: 'first tail' }));
        streams.dispose();
    });

    it('does not let a late delta roll back an item waiting for persistence', () => {
        const publish = vi.fn();
        const streams = new CodexSessionStreamBuffer(publish);
        streams.append({ id: 'a', turnId: 'turn-a' }, 'partial');
        streams.finish('a', 'complete');
        streams.append({ id: 'a', turnId: 'turn-a' }, 'late');
        streams.flushTurn('turn-a');
        expect(publish).toHaveBeenLastCalledWith(expect.objectContaining({ text: 'complete' }));
        streams.dispose();
    });

    it('does not let an acknowledgement from an earlier runtime delete a reused item id', () => {
        const publish = vi.fn();
        const streams = new CodexSessionStreamBuffer(publish);
        streams.append({ id: 'a', turnId: 'turn-a', epoch: 'old' }, 'old');
        const acknowledgeOld = streams.finish('a', 'old final');
        streams.append({ id: 'a', turnId: 'turn-b', epoch: 'new' }, 'new');
        acknowledgeOld();
        streams.flushTurn('turn-b');
        expect(publish).toHaveBeenLastCalledWith(expect.objectContaining({ epoch: 'new', text: 'new' }));
        streams.dispose();
    });

    it('preserves the explicit reasoning-summary kind through final persistence acknowledgement', () => {
        const publish = vi.fn();
        const streams = new CodexSessionStreamBuffer(publish);
        streams.update({ id: 'summary-a', turnId: 'turn-a', kind: 'reasoning-summary', text: 'Visible summary' });
        const acknowledge = streams.finish('summary-a', 'Final visible summary');
        expect(publish).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'summary-a', kind: 'reasoning-summary', text: 'Final visible summary' }));
        acknowledge();
        const count = publish.mock.calls.length;
        streams.flushTurn('turn-a');
        expect(publish).toHaveBeenCalledTimes(count);
    });
});
