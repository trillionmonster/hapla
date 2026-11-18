import { describe, expect, it, vi } from 'vitest';
import { RuntimeTurnBarrier } from './runtimeTurnBarrier';

describe('RuntimeTurnBarrier', () => {
    it('retains a queued prompt for 30 minutes until authoritative compaction completion', async () => {
        vi.useFakeTimers();
        try {
            let complete!: () => void;
            const idle = new Promise<void>((resolve) => { complete = resolve; });
            const send = vi.fn();
            const barrier = new RuntimeTurnBarrier(() => idle, vi.fn());
            const waiting = barrier.wait().then((ready) => { if (ready) send('retained prompt'); });
            await vi.advanceTimersByTimeAsync(30 * 60 * 1000);
            expect(send).not.toHaveBeenCalled();
            complete(); await waiting;
            expect(send).toHaveBeenCalledExactlyOnceWith('retained prompt');
        } finally { vi.useRealTimers(); }
    });

    it('does not consume or repeatedly retry a prompt after a disconnected provider', async () => {
        const wait = vi.fn().mockRejectedValueOnce(new Error('disconnected')).mockResolvedValue(undefined);
        const unavailable = vi.fn();
        const send = vi.fn();
        const barrier = new RuntimeTurnBarrier(wait, unavailable);
        const waiting = barrier.wait().then((ready) => { if (ready) send('retained prompt'); });
        await Promise.resolve(); await Promise.resolve();
        expect(wait).toHaveBeenCalledOnce();
        expect(unavailable).toHaveBeenCalledOnce();
        expect(send).not.toHaveBeenCalled();
        barrier.recovered(); await waiting;
        expect(send).toHaveBeenCalledExactlyOnceWith('retained prompt');
    });

    it('releases a failed wait without submitting when the runtime closes', async () => {
        const barrier = new RuntimeTurnBarrier(async () => { throw new Error('offline'); }, vi.fn());
        const waiting = barrier.wait();
        await Promise.resolve();
        barrier.close();
        await expect(waiting).resolves.toBe(false);
    });
});
