import { sessionFileDownloadInfo } from '@/sync/ops';
import { sessionResources } from '@/sync/sessionResources';
import { createWorkspaceStream } from './workspaceStream';
import { deleteCachedWorkspaceVideos, MAX_CACHED_VIDEO_BYTES, readCachedWorkspaceVideo, storeWorkspaceVideo } from './workspaceVideoStore';
import { acquireCloudWorkspaceFile, CLOUD_FILE_THRESHOLD_BYTES, type CloudProgress } from './cloudFileDelivery';

export { MAX_CACHED_VIDEOS, MAX_CACHED_VIDEO_BYTES } from './workspaceVideoStore';
export type WorkspaceVideoLease = { url: string; size: number; name: string; release: () => void; signal: AbortSignal;
    attach?: (video: HTMLVideoElement, onError?: (message: string) => void) => () => void };
type VideoSource = Omit<WorkspaceVideoLease, 'signal'>;
type Entry = { key: string; cacheKey: string; sessionId: string; controller: AbortController; promise: Promise<VideoSource>; refs: number; releaseSource?: () => void };
const live = new Map<string, Entry>();
const pendingMetadata = new Set<AbortController>();
const retainedSessions = new Map<string, () => void>();
const knownStoredKeys = new Map<string, string>();
const EVICTION_EVENT = 'hapla:opened-video-eviction:v1';
let listening = false;
let generation = 0;
let channel: BroadcastChannel | undefined;
const cancelled = () => new DOMException('Cancelled', 'AbortError');

function dispose(entry: Entry): void {
    if (live.get(entry.key) === entry) live.delete(entry.key);
    entry.controller.abort();
    const release = entry.releaseSource;
    entry.releaseSource = undefined;
    release?.();
}

function forgetKeys(keys: string[]): void {
    for (const key of keys) {
        for (const entry of [...live.values()]) if (entry.cacheKey === key) dispose(entry);
        knownStoredKeys.delete(key);
    }
    for (const [sessionId, unregister] of retainedSessions) {
        if ([...knownStoredKeys.values()].includes(sessionId)) continue;
        unregister(); retainedSessions.delete(sessionId);
    }
}

function receive(value: unknown): void {
    if (!value || typeof value !== 'object') return;
    const event = value as { clear?: unknown; keys?: unknown };
    if (event.clear === true) { releaseMemory(); return; }
    if (Array.isArray(event.keys) && event.keys.length <= 32 && event.keys.every(key => typeof key === 'string')) forgetKeys(event.keys);
}

function notify(keys: string[], clear = false): void {
    if (!keys.length && !clear) return;
    const event = { keys, clear, nonce: `${Date.now()}-${Math.random()}` };
    channel?.postMessage(event);
    // The storage event works through the same HTTP origins that cannot use a
    // service worker. It also reaches tabs without BroadcastChannel support.
    try { localStorage.setItem(EVICTION_EVENT, JSON.stringify(event)); localStorage.removeItem(EVICTION_EVENT); } catch {}
}

function listen(): void {
    if (listening || typeof window === 'undefined') return;
    listening = true;
    if (typeof BroadcastChannel !== 'undefined') {
        channel = new BroadcastChannel(EVICTION_EVENT);
        channel.onmessage = event => receive(event.data);
    }
    window.addEventListener('storage', event => {
        if (event.key !== EVICTION_EVENT || !event.newValue) return;
        try { receive(JSON.parse(event.newValue)); } catch {}
    });
    window.addEventListener('pagehide', releaseMemory);
}

function retainSession(key: string, sessionId: string): void {
    knownStoredKeys.set(key, sessionId);
    if (retainedSessions.has(sessionId)) return;
    retainedSessions.set(sessionId, sessionResources.register(sessionId, () => {
        const keys = [...knownStoredKeys].filter(([, owner]) => owner === sessionId).map(([storedKey]) => storedKey);
        forgetKeys(keys);
        void deleteCachedWorkspaceVideos(sessionId).then(deleted => { forgetKeys(deleted); notify(deleted); }).catch(() => undefined);
    }));
}

function releaseMemory(): void {
    generation++;
    for (const controller of pendingMetadata) controller.abort();
    pendingMetadata.clear();
    for (const entry of [...live.values()]) dispose(entry);
    for (const unregister of retainedSessions.values()) unregister();
    retainedSessions.clear(); knownStoredKeys.clear();
}

/** Stop pending transfers and revoke every live URL before changing accounts. */
export function releaseWorkspaceVideoMemory(): void {
    releaseMemory();
    notify([], true);
}

/** Must commit before account-switch/login continues. No original bytes survive. */
export async function clearWorkspaceVideoPersistence(): Promise<void> {
    releaseWorkspaceVideoMemory();
    try { await deleteCachedWorkspaceVideos(); }
    catch { throw new Error('无法清除上一个账号的视频缓存，请重试'); }
}

/** Call only after an explicit user open. Closing revokes the active Blob URL;
 * only the last five small originals (at most 5 MiB total) remain in IndexedDB.
 * HTTPS streams are never copied into this cache. Storage-blocked browsers and
 * oversized originals work normally and are discarded completely on close. */
export async function acquireWorkspaceVideo(options: CloudProgress & {
    sessionId: string; path: string; signal?: AbortSignal; onProgress?: (progress: number) => void;
    fileInfo?: Extract<Awaited<ReturnType<typeof sessionFileDownloadInfo>>, { success: true }>;
    forceRestore?: boolean;
}): Promise<WorkspaceVideoLease> {
    listen();
    if (options.signal?.aborted) throw cancelled();
    const currentGeneration = generation;
    const retained = sessionResources.capture(options.sessionId);
    // The RPC transport cannot abort a server-side metadata read. Settle this
    // open immediately on close/account unload and ignore any late response.
    const metadataController = new AbortController();
    pendingMetadata.add(metadataController);
    const cancelMetadata = () => metadataController.abort();
    const unregisterMetadata = sessionResources.register(options.sessionId, cancelMetadata);
    options.signal?.addEventListener('abort', cancelMetadata, { once: true });
    let rejectMetadata!: () => void;
    const interruptedMetadata = new Promise<never>((_, reject) => {
        rejectMetadata = () => reject(cancelled());
        metadataController.signal.addEventListener('abort', rejectMetadata, { once: true });
    });
    let info: Awaited<ReturnType<typeof sessionFileDownloadInfo>>;
    try {
        info = await Promise.race([options.fileInfo ?? sessionFileDownloadInfo(options.sessionId, options.path), interruptedMetadata]);
    } finally {
        metadataController.signal.removeEventListener('abort', rejectMetadata);
        options.signal?.removeEventListener('abort', cancelMetadata);
        unregisterMetadata();
        pendingMetadata.delete(metadataController);
    }
    if (options.signal?.aborted || generation !== currentGeneration || !retained()) throw cancelled();
    if (!info.success) throw new Error(info.error);
    if (!Number.isSafeInteger(info.size) || info.size < 0) throw new Error('视频大小无效，请重试');
    if (info.size > CLOUD_FILE_THRESHOLD_BYTES) return acquireCloudWorkspaceFile({ ...options, fileInfo: info });
    const key = JSON.stringify([options.sessionId, options.path]);
    const mse = !globalThis.isSecureContext && /\.(?:mp4|m4v|mov)$/i.test(options.path)
        ? await import('./workspaceVideoMse') : undefined;
    if (options.signal?.aborted || generation !== currentGeneration || !retained()) throw cancelled();
    const useMse = mse?.canUseWorkspaceVideoMse(options.path) === true;
    // A file rewrite is never served from a previous open's cached original.
    // MediaSource belongs to one media element. Do not share it between two
    // simultaneously opened viewers, even when their original path matches.
    const liveKey = `${key}:${info.modified}:${info.size}${useMse ? `:mse:${Math.random()}` : ''}`;
    let entry = live.get(liveKey);
    if (!entry) {
        const controller = new AbortController();
        const next: Entry = { key: liveKey, cacheKey: key, sessionId: options.sessionId, controller, refs: 0, promise: undefined as never };
        const unregister = sessionResources.register(options.sessionId, () => dispose(next));
        controller.signal.addEventListener('abort', unregister, { once: true });
        const check = () => { if (controller.signal.aborted || generation !== currentGeneration || !retained()) throw cancelled(); };
        next.promise = (async () => {
            try {
                const cached = await readCachedWorkspaceVideo(key, info.modified, info.size, controller.signal).catch(() => null);
                check();
                if (cached) {
                    const url = URL.createObjectURL(cached.blob);
                    next.releaseSource = () => URL.revokeObjectURL(url);
                    retainSession(key, options.sessionId);
                    options.onProgress?.(1);
                    return { url, name: cached.name, size: cached.size, release: () => dispose(next) };
                }
                if (useMse) {
                    const stream = await mse!.createWorkspaceVideoMse({ ...options, fileInfo: info, signal: controller.signal });
                    next.releaseSource = stream.release;
                    check();
                    return { ...stream, release: () => dispose(next) };
                }
                const source = await createWorkspaceStream({ ...options, signal: controller.signal, preferStreaming: true, fileInfo: info, expectedFile: { modified: info.modified, size: info.size } });
                next.releaseSource = source.release;
                check();
                if (source.blob && source.size <= MAX_CACHED_VIDEO_BYTES) {
                    // Playback already has a usable source. Do not wait for an
                    // IndexedDB commit/readback or replace a playing URL. Its
                    // active staging is released on close; only committed
                    // originals remain under the shared five-file/5MiB cap.
                    // Keep unload cleanup registered until the commit settles,
                    // including the narrow commit-before-abort race.
                    const unregisterCacheCleanup = sessionResources.register(options.sessionId, () => {
                        void deleteCachedWorkspaceVideos(options.sessionId).then(deleted => { forgetKeys(deleted); notify(deleted); }).catch(() => undefined);
                    });
                    void storeWorkspaceVideo({ key, sessionId: options.sessionId, modified: info.modified, size: source.size, name: source.name, blob: source.blob }, controller.signal).then(evicted => {
                        if (generation === currentGeneration && retained()) retainSession(key, options.sessionId);
                        forgetKeys(evicted);
                        notify(evicted);
                    }).catch(() => undefined).finally(unregisterCacheCleanup);
                }
                return { url: source.url, name: source.name, size: source.size, release: () => dispose(next) };
            } catch (error) { dispose(next); throw error; }
        })();
        live.set(liveKey, next);
        entry = next;
    } else {
        // A second viewer is still a new open, even when it can share an
        // existing decoder source. Promote the persisted entry for other tabs.
        void readCachedWorkspaceVideo(key, info.modified, info.size, entry.controller.signal).catch(() => undefined);
    }
    const acquired = entry;
    acquired.refs++;
    let released = false;
    const release = () => {
        if (released) return;
        released = true;
        options.signal?.removeEventListener('abort', release);
        acquired.refs--;
        if (acquired.refs === 0) dispose(acquired);
    };
    options.signal?.addEventListener('abort', release, { once: true });
    // Cancellation settles immediately even if an RPC ignores AbortSignal.
    const interrupted = new Promise<never>((_, reject) => {
        const abort = () => { acquired.controller.signal.removeEventListener('abort', abort); options.signal?.removeEventListener('abort', abort); reject(cancelled()); };
        acquired.controller.signal.addEventListener('abort', abort, { once: true });
        options.signal?.addEventListener('abort', abort, { once: true });
        void acquired.promise.finally(() => { acquired.controller.signal.removeEventListener('abort', abort); options.signal?.removeEventListener('abort', abort); }).catch(() => undefined);
    });
    try {
        const source = await Promise.race([acquired.promise, interrupted]);
        if (released || acquired.controller.signal.aborted || options.signal?.aborted) throw cancelled();
        return { url: source.url, size: source.size, name: source.name, attach: source.attach, release, signal: acquired.controller.signal };
    } catch (error) { release(); throw error; }
}
