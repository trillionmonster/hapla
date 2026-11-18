import { describe, expect, it, vi } from 'vitest';
import {
    dismissWebBootstrapOverlay,
    retryBootstrapTask,
    settleBootstrapTaskWithin,
    setWebBootstrapOverlayLabel,
    WEB_BOOTSTRAP_LABEL_ID,
    WEB_BOOTSTRAP_OVERLAY_ID,
} from './webBootstrap';

describe('Web bootstrap handoff', () => {
    it('removes the root-external overlay exactly once after the application commits', () => {
        let overlay: HTMLElement | null;
        const remove = vi.fn(() => { overlay = null; });
        overlay = { remove } as unknown as HTMLElement;
        const getElementById = vi.fn((_id: string): HTMLElement | null => overlay);
        const candidate = { getElementById } as Pick<Document, 'getElementById'>;

        expect(dismissWebBootstrapOverlay(candidate)).toBe(true);
        expect(dismissWebBootstrapOverlay(candidate)).toBe(false);
        expect(getElementById).toHaveBeenCalledWith(WEB_BOOTSTRAP_OVERLAY_ID);
        expect(remove).toHaveBeenCalledOnce();
    });

    it('is safe when an older page has no bootstrap overlay', () => {
        const getElementById = vi.fn((_id: string): HTMLElement | null => null);

        expect(dismissWebBootstrapOverlay({ getElementById })).toBe(false);
    });

    it('is safe during non-browser rendering', () => {
        expect(dismissWebBootstrapOverlay()).toBe(false);
    });

    it('updates the root-external overlay while React is still starting', () => {
        const label = { textContent: '' } as HTMLElement;
        const getElementById = vi.fn((id: string): HTMLElement | null => (
            id === WEB_BOOTSTRAP_LABEL_ID ? label : null
        ));

        expect(setWebBootstrapOverlayLabel('Reconnecting…', { getElementById })).toBe(true);
        expect(label.textContent).toBe('Reconnecting…');
        expect(setWebBootstrapOverlayLabel('Ignored', { getElementById: () => null })).toBe(false);
    });
});

describe('Web bootstrap retries', () => {
    it('recovers a transient failure without requiring a page reload', async () => {
        const task = vi.fn()
            .mockRejectedValueOnce(new Error('A network error occurred.'))
            .mockResolvedValue('loaded');
        const wait = vi.fn().mockResolvedValue(undefined);
        const onRetry = vi.fn();

        await expect(retryBootstrapTask(task, {
            maxAttempts: 3,
            retryDelaysMs: [250, 1_000],
            wait,
            onRetry,
        })).resolves.toBe('loaded');
        expect(task).toHaveBeenCalledTimes(2);
        expect(task).toHaveBeenNthCalledWith(1, 1);
        expect(task).toHaveBeenNthCalledWith(2, 2);
        expect(wait).toHaveBeenCalledWith(250);
        expect(onRetry).toHaveBeenCalledWith(expect.objectContaining({
            failedAttempt: 1,
            nextAttempt: 2,
            maxAttempts: 3,
        }));
    });

    it('stops after the configured attempt limit', async () => {
        const failure = new Error('still unavailable');
        const task = vi.fn().mockRejectedValue(failure);
        const wait = vi.fn().mockResolvedValue(undefined);

        await expect(retryBootstrapTask(task, {
            maxAttempts: 3,
            retryDelaysMs: [10],
            wait,
        })).rejects.toBe(failure);
        expect(task).toHaveBeenCalledTimes(3);
        expect(wait).toHaveBeenCalledTimes(2);
        expect(wait).toHaveBeenNthCalledWith(1, 10);
        expect(wait).toHaveBeenNthCalledWith(2, 10);
    });

    it('rejects an invalid attempt limit before starting work', async () => {
        const task = vi.fn().mockResolvedValue('unused');

        await expect(retryBootstrapTask(task, { maxAttempts: 0 })).rejects.toThrow(RangeError);
        expect(task).not.toHaveBeenCalled();
    });

    it('stops waiting at the optional-task deadline and observes a late failure', async () => {
        vi.useFakeTimers();
        let rejectTask!: (error: unknown) => void;
        const task = new Promise<void>((_resolve, reject) => { rejectTask = reject; });

        try {
            const resultPromise = settleBootstrapTaskWithin(task, 8_000);
            await vi.advanceTimersByTimeAsync(8_000);
            await expect(resultPromise).resolves.toEqual({ status: 'timed-out' });

            // The timeout result is final, but the original task keeps a
            // rejection handler so completion after the deadline is safe.
            rejectTask(new Error('late font failure'));
            await Promise.resolve();
            await expect(resultPromise).resolves.toEqual({ status: 'timed-out' });
        } finally {
            vi.useRealTimers();
        }
    });
});
