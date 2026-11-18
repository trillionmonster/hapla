import { describe, expect, it, vi } from 'vitest';
import { RuntimeSleepBarrier } from './runtimeSleepBarrier';

describe('RuntimeSleepBarrier', () => {
    it('prevents a new turn during interruption and until the sleep response is ready', async () => {
        const barrier = new RuntimeSleepBarrier();
        let finish!: () => void;
        const prepare = barrier.prepare(() => new Promise((resolve) => { finish = resolve; }));
        const startTurn = vi.fn();
        const waiting = barrier.waitForTurn().then(startTurn);
        await Promise.resolve();
        expect(startTurn).not.toHaveBeenCalled();
        finish(); await prepare;
        expect(startTurn).not.toHaveBeenCalled();
        expect(barrier.commit()).toBe(true);
        await waiting;
        expect(startTurn).toHaveBeenCalledWith(false);
    });
    it('releases pending input when interruption or persistence fails', async () => {
        const barrier = new RuntimeSleepBarrier();
        const prepare = barrier.prepare(async () => { throw new Error('not confirmed'); });
        const waiting = barrier.waitForTurn();
        await expect(prepare).rejects.toThrow('not confirmed');
        await expect(waiting).resolves.toBe(true);
        expect(barrier.commit()).toBe(false);
    });
    it('keeps a prompt arriving during sleep preparation instead of dropping it on exit', async () => {
        const barrier = new RuntimeSleepBarrier();
        let finish!: () => void;
        const prepare = barrier.prepare(() => new Promise((resolve) => { finish = resolve; }));
        const waiting = barrier.waitForTurn();
        barrier.noteInput();
        await Promise.resolve();
        finish();
        await expect(prepare).rejects.toThrow('new message arrived');
        await expect(waiting).resolves.toBe(true);
    });
    it('transparently wakes for a new prompt before a prepared runtime disconnects', async () => {
        const barrier = new RuntimeSleepBarrier();
        await barrier.prepare(async () => {});
        barrier.noteInput();
        expect(barrier.commit()).toBe(false);
        await expect(barrier.waitForTurn()).resolves.toBe(true);
    });
    it('coalesces concurrent sleep requests', async () => {
        const barrier = new RuntimeSleepBarrier();
        const action = vi.fn(async () => {});
        await Promise.all([barrier.prepare(action), barrier.prepare(action)]);
        expect(action).toHaveBeenCalledOnce();
    });
});
