export type DownloadState = 'queued' | 'running' | 'handed-off' | 'failed' | 'cancelled';
export type DownloadJob = { id: string; name: string; state: DownloadState; progress: number; stage?: string; error?: string; startedAt?: number; browserUrl?: string };
type Work = (signal: AbortSignal, progress: (value: number) => void, stage: (value: string) => void, ready: (url: string) => void) => Promise<void>;
type Entry = { job: DownloadJob; key: string; work: Work; controller: AbortController; promise: Promise<void>; resolve: () => void; reject: (error: unknown) => void };
const entries = new Map<string, Entry>();
const listeners = new Set<() => void>();
const resources = new Set<() => void>();
let snapshot: DownloadJob[] = [];
let generation = 0;
let sequence = 0;
let running = 0;

function emit(): void { snapshot = [...entries.values()].map(entry => ({ ...entry.job })); listeners.forEach(listener => listener()); }
export function getDownloadJobs(): DownloadJob[] { return snapshot; }
export function subscribeDownloads(listener: () => void): () => void { listeners.add(listener); return () => { listeners.delete(listener); }; }
export function captureDownloadLifetime(): () => boolean { const current = generation; return () => current === generation; }
export function registerDownloadResource(release: () => void): () => void { resources.add(release); return () => { resources.delete(release); }; }

function cancelled(): DOMException { return new DOMException('下载已取消', 'AbortError'); }
function pump(): void {
    for (const entry of entries.values()) {
        if (running >= 2) return;
        if (entry.job.state !== 'queued') continue;
        running++;
        entry.job.state = 'running'; entry.job.startedAt = Date.now(); emit();
        let stopWaiting = () => {};
        const aborted = new Promise<never>((_, reject) => {
            const abort = () => reject(cancelled());
            if (entry.controller.signal.aborted) abort();
            else entry.controller.signal.addEventListener('abort', abort, { once: true });
            stopWaiting = () => entry.controller.signal.removeEventListener('abort', abort);
        });
        let work: Promise<void>;
        try {
            work = entry.work(entry.controller.signal, progress => {
                if (entry.controller.signal.aborted) return;
                entry.job.progress = Math.min(1, Math.max(0, progress)); emit();
            }, stage => { if (!entry.controller.signal.aborted) { entry.job.stage = stage; emit(); } }, url => {
                if (!entry.controller.signal.aborted) { entry.job.browserUrl = url; emit(); }
            });
        } catch (error) { work = Promise.reject(error); }
        // Socket RPCs cannot all be aborted, but their late results are checked
        // by the transfer before any write/handoff. Do not retain a queue slot
        // while a cancelled old RPC waits for its network timeout.
        void Promise.race([work, aborted]).then(() => {
            if (entry.controller.signal.aborted) throw cancelled();
            entry.job.state = 'handed-off'; entry.job.progress = 1; emit(); entry.resolve();
        }).catch(error => {
            entry.job.state = entry.controller.signal.aborted || error?.name === 'AbortError' ? 'cancelled' : 'failed';
            entry.job.error = entry.job.state === 'failed' ? (error instanceof Error ? error.message : '下载失败，请重试') : undefined;
            emit(); entry.reject(error);
        }).finally(() => { stopWaiting(); running--; emit(); pump(); });
    }
}

/** Jobs belong to the current authenticated application, not a mounted route.
 * No paths, signed URLs, account keys, or file contents are persisted here. */
export function runManagedDownload(options: { key: string; name: string; work: Work; signal?: AbortSignal }): Promise<void> {
    if (options.signal?.aborted) return Promise.reject(cancelled());
    const existing = [...entries.values()].find(entry => entry.key === options.key && ['queued', 'running'].includes(entry.job.state));
    if (existing) return existing.promise;
    if ([...entries.values()].filter(entry => ['queued', 'running'].includes(entry.job.state)).length >= 12) return Promise.reject(new Error('下载队列已满，请等待当前下载完成'));
    for (const [id, entry] of entries) {
        if (entries.size < 12) break;
        if (!['queued', 'running'].includes(entry.job.state)) entries.delete(id);
    }
    const id = `download-${++sequence}`;
    let resolve!: () => void; let reject!: (error: unknown) => void;
    const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
    // The persistent UI displays errors even when the originating card is gone.
    void promise.catch(() => undefined);
    const entry: Entry = { job: { id, name: options.name, state: 'queued', progress: 0 }, key: options.key, work: options.work, controller: new AbortController(), promise, resolve, reject };
    entries.set(id, entry);
    const abort = () => cancelDownload(id);
    options.signal?.addEventListener('abort', abort, { once: true });
    void promise.finally(() => options.signal?.removeEventListener('abort', abort)).catch(() => undefined);
    emit(); pump(); return promise;
}

export function cancelDownload(id: string): void {
    const entry = entries.get(id);
    if (!entry || !['queued', 'running'].includes(entry.job.state)) return;
    const queued = entry.job.state === 'queued';
    entry.controller.abort(); entry.job.state = 'cancelled';
    if (queued) entry.reject(cancelled());
    emit(); pump();
}
export function retryDownload(id: string): void {
    const entry = entries.get(id);
    if (!entry || !['failed', 'cancelled'].includes(entry.job.state)) return;
    entries.delete(id);
    void runManagedDownload({ key: entry.key, name: entry.job.name, work: entry.work }).catch(() => undefined);
}
export function dismissDownload(id: string): void {
    const entry = entries.get(id);
    if (entry && !['queued', 'running'].includes(entry.job.state)) { entries.delete(id); emit(); }
}
export function clearManagedDownloads(): void {
    generation++;
    for (const entry of entries.values()) { entry.controller.abort(); entry.reject(cancelled()); }
    entries.clear();
    for (const release of [...resources]) { try { release(); } catch { /* Dispose all old account resources. */ } }
    resources.clear(); emit();
}
