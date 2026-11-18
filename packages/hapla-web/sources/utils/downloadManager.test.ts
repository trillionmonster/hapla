import { afterEach, describe, expect, it, vi } from 'vitest';
import { cancelDownload, captureDownloadLifetime, clearManagedDownloads, getDownloadJobs, registerDownloadResource, retryDownload, runManagedDownload, subscribeDownloads } from './downloadManager';

afterEach(async () => { clearManagedDownloads(); await Promise.resolve(); await Promise.resolve(); });
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(yes => { resolve = yes; }); return { promise, resolve }; };

describe('account-scoped downloads', () => {
    it('retains a native download link after handoff and removes it when the account changes', async () => {
        const url = 'https://test.r2.cloudflarestorage.com/file?response-content-disposition=attachment';
        await runManagedDownload({ key: 'file', name: 'file.mp4', work: async (_signal, _progress, _stage, ready) => ready(url) });
        expect(getDownloadJobs()[0]).toMatchObject({ state: 'handed-off', browserUrl: url });
        clearManagedDownloads(); expect(getDownloadJobs()).toEqual([]);
    });
    it('keeps progress and a running operation when its originating view unsubscribes', async () => {
        const done = deferred(); let progress!: (value: number) => void;
        const observe = vi.fn(); const unsubscribe = subscribeDownloads(observe);
        const operation = runManagedDownload({ key: 'route-a/file', name: 'file.bin', work: async (_signal, update) => { progress = update; await done.promise; } });
        unsubscribe(); progress(0.6);
        expect(getDownloadJobs()).toMatchObject([{ name: 'file.bin', state: 'running', progress: 0.6 }]);
        done.resolve(); await operation; await Promise.resolve(); await Promise.resolve();
        expect(getDownloadJobs()).toMatchObject([{ name: 'file.bin', state: 'handed-off', progress: 1 }]);
    });
    it('deduplicates repeated clicks and limits simultaneous transfers to two', async () => {
        const tasks = [deferred(), deferred(), deferred()]; const began: number[] = [];
        const work = (index: number) => async () => { began.push(index); await tasks[index].promise; };
        const first = runManagedDownload({ key: 'one', name: '1.bin', work: work(0) });
        expect(runManagedDownload({ key: 'one', name: '1.bin', work: vi.fn() })).toBe(first);
        const second = runManagedDownload({ key: 'two', name: '2.bin', work: work(1) });
        const third = runManagedDownload({ key: 'three', name: '3.bin', work: work(2) });
        expect(began).toEqual([0, 1]); expect(getDownloadJobs()[2].state).toBe('queued');
        tasks[0].resolve(); await first; await Promise.resolve(); await Promise.resolve();
        expect(began).toEqual([0, 1, 2]);
        tasks[1].resolve(); tasks[2].resolve(); await Promise.all([second, third]);
    });
    it('cancels a queued transfer without starting it', async () => {
        const done = deferred(); const work = vi.fn(async () => done.promise);
        const first = runManagedDownload({ key: 'block1', name: 'a', work });
        const second = runManagedDownload({ key: 'block2', name: 'b', work });
        const queued = runManagedDownload({ key: 'never', name: 'c', work });
        cancelDownload(getDownloadJobs()[2].id);
        await expect(queued).rejects.toMatchObject({ name: 'AbortError' });
        expect(work).toHaveBeenCalledTimes(2);
        done.resolve(); await Promise.all([first, second]);
    });
    it('retains errors for retry after the card is gone', async () => {
        const work = vi.fn().mockRejectedValueOnce(new Error('Remote offline')).mockResolvedValueOnce(undefined);
        await expect(runManagedDownload({ key: 'retry', name: 'retry.bin', work })).rejects.toThrow('Remote offline');
        expect(getDownloadJobs()[0]).toMatchObject({ state: 'failed', error: 'Remote offline' });
        retryDownload(getDownloadJobs()[0].id);
        await vi.waitFor(() => expect(getDownloadJobs()[0].state).toBe('handed-off'));
        expect(work).toHaveBeenCalledTimes(2);
    });
    it('account clearing aborts work and releases handoff resources, ignoring late completions', async () => {
        const done = deferred(); let signal!: AbortSignal;
        const retained = captureDownloadLifetime(); const release = vi.fn(); registerDownloadResource(release);
        const operation = runManagedDownload({ key: 'old-account', name: 'private.bin', work: async value => { signal = value; await done.promise; } });
        clearManagedDownloads();
        expect(signal.aborted).toBe(true); expect(release).toHaveBeenCalledTimes(1); expect(retained()).toBe(false);
        expect(getDownloadJobs()).toEqual([]);
        done.resolve(); await expect(operation).rejects.toMatchObject({ name: 'AbortError' });
        await Promise.resolve(); expect(getDownloadJobs()).toEqual([]);
    });
    it('cancelling two hung RPC jobs immediately lets a queued transfer start', async () => {
        const hung = new Promise<void>(() => {});
        const first = runManagedDownload({ key: 'hung-a', name: 'a', work: async () => hung });
        const second = runManagedDownload({ key: 'hung-b', name: 'b', work: async () => hung });
        const fresh = vi.fn().mockResolvedValue(undefined);
        const queued = runManagedDownload({ key: 'ready-after-hung', name: 'ready', work: fresh });
        const ids = getDownloadJobs().slice(0, 2).map(job => job.id);
        ids.forEach(cancelDownload);
        await expect(first).rejects.toMatchObject({ name: 'AbortError' });
        await expect(second).rejects.toMatchObject({ name: 'AbortError' });
        await queued; expect(fresh).toHaveBeenCalledTimes(1);
    });
    it('an account switch does not leave new downloads blocked by old hung RPCs', async () => {
        const hung = new Promise<void>(() => {});
        const old = [runManagedDownload({ key: 'old-hung-a', name: 'old-a', work: async () => hung }), runManagedDownload({ key: 'old-hung-b', name: 'old-b', work: async () => hung })];
        clearManagedDownloads();
        const fresh = vi.fn().mockResolvedValue(undefined);
        await runManagedDownload({ key: 'new-account-job', name: 'new-file', work: fresh });
        expect(fresh).toHaveBeenCalledTimes(1);
        await Promise.allSettled(old);
        expect(getDownloadJobs()).toHaveLength(1); expect(getDownloadJobs()[0].name).toBe('new-file');
    });
});
