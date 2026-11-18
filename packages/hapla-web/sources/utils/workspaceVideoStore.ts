/** Original video bytes are retained only after an explicit open. IndexedDB's
 * read/write transaction serializes eviction across tabs, including on HTTP. */
export const MAX_CACHED_VIDEOS = 5;
import { CLOUD_FILE_THRESHOLD_BYTES } from '@hapla/wire';
export const MAX_CACHED_VIDEO_BYTES = 5 * CLOUD_FILE_THRESHOLD_BYTES;
const DATABASE = 'hapla-opened-videos-v1';
const STORE = 'videos';
const TIMEOUT = 15_000;

export type CachedWorkspaceVideo = {
    key: string; sessionId: string; modified: number; size: number;
    name: string; blob: Blob; lastOpened: number;
};

export function videoEvictionKeys(records: Pick<CachedWorkspaceVideo, 'key' | 'size' | 'lastOpened'>[]): string[] {
    const ordered = [...records].sort((a, b) => b.lastOpened - a.lastOpened || a.key.localeCompare(b.key));
    let bytes = 0;
    let count = 0;
    return ordered.filter(record => {
        if (!Number.isSafeInteger(record.size) || record.size < 0 || record.size > CLOUD_FILE_THRESHOLD_BYTES || count >= MAX_CACHED_VIDEOS || bytes + record.size > MAX_CACHED_VIDEO_BYTES) return true;
        bytes += record.size; count++;
        return false;
    }).map(record => record.key);
}

function transaction<T>(issue: (store: IDBObjectStore, done: (value: T) => void) => void, signal?: AbortSignal): Promise<T> {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) { reject(new DOMException('Cancelled', 'AbortError')); return; }
        if (typeof indexedDB === 'undefined') { reject(new Error('Video cache unavailable')); return; }
        let db: IDBDatabase | undefined;
        let tx: IDBTransaction | undefined;
        let settled = false;
        let value: T;
        const finish = (error?: unknown) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            signal?.removeEventListener('abort', abort);
            db?.close();
            error ? reject(error) : resolve(value);
        };
        const abort = () => { try { tx?.abort(); } catch {} finish(new DOMException('Cancelled', 'AbortError')); };
        const timer = setTimeout(() => { try { tx?.abort(); } catch {} finish(new Error('视频缓存操作超时，请重试')); }, TIMEOUT);
        signal?.addEventListener('abort', abort, { once: true });
        let request: IDBOpenDBRequest;
        try { request = indexedDB.open(DATABASE, 2); }
        catch (error) { finish(error); return; }
        request.onupgradeneeded = () => {
            if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE, { keyPath: 'key' });
            else {
                // Remove originals retained by the previous whole-file path.
                // A cursor avoids loading all old Blobs into an array at once.
                const cursor = request.transaction!.objectStore(STORE).openCursor();
                cursor.onsuccess = () => { const row = cursor.result; if (!row) return; if (row.value.size > CLOUD_FILE_THRESHOLD_BYTES) row.delete(); row.continue(); };
            }
        };
        request.onerror = () => finish(request.error || new Error('视频缓存不可用'));
        request.onsuccess = () => {
            db = request.result;
            if (settled || signal?.aborted) { db.close(); return; }
            try {
                tx = db.transaction(STORE, 'readwrite');
                tx.oncomplete = () => finish();
                tx.onerror = tx.onabort = () => finish(tx?.error || new Error('视频缓存不可用'));
                issue(tx.objectStore(STORE), result => { value = result; });
            } catch (error) { try { tx?.abort(); } catch {} finish(error); }
        };
    });
}

export function readCachedWorkspaceVideo(key: string, modified: number, size: number, signal?: AbortSignal): Promise<CachedWorkspaceVideo | null> {
    return transaction((store, done) => {
        const request = store.get(key);
        request.onsuccess = () => {
            const record = request.result as CachedWorkspaceVideo | undefined;
            if (!record || record.size > CLOUD_FILE_THRESHOLD_BYTES || record.modified !== modified || record.size !== size || !(record.blob instanceof Blob) || record.blob.size !== size) {
                if (record) store.delete(key);
                done(null); return;
            }
            const all = store.getAll();
            all.onsuccess = () => {
                // Monotonic across concurrent tabs, even for opens in one ms.
                record.lastOpened = Math.max(Date.now(), ...(all.result as CachedWorkspaceVideo[]).map(item => item.lastOpened + 1));
                store.put(record);
                done(record);
            };
        };
    }, signal);
}

export function storeWorkspaceVideo(record: Omit<CachedWorkspaceVideo, 'lastOpened'>, signal?: AbortSignal): Promise<string[]> {
    if (!Number.isSafeInteger(record.size) || record.size < 0 || !(record.blob instanceof Blob) || record.blob.size !== record.size) return Promise.reject(new Error('视频缓存原文件大小不一致'));
    return transaction((store, done) => {
        const request = store.getAll();
        request.onsuccess = () => {
            const records = (request.result as CachedWorkspaceVideo[]).filter(item => item.key !== record.key);
            const lastOpened = Math.max(Date.now(), ...records.map(item => item.lastOpened + 1));
            const next = { ...record, lastOpened };
            records.push(next);
            const evicted = videoEvictionKeys(records);
            if (!evicted.includes(record.key)) store.put(next);
            for (const key of evicted) store.delete(key);
            done(evicted);
        };
    }, signal);
}

export function deleteCachedWorkspaceVideos(sessionId?: string): Promise<string[]> {
    if (typeof indexedDB === 'undefined') return Promise.resolve([]);
    return transaction((store, done) => {
        const request = store.getAll();
        request.onsuccess = () => {
            const keys = (request.result as CachedWorkspaceVideo[]).filter(record => !sessionId || record.sessionId === sessionId).map(record => record.key);
            for (const key of keys) store.delete(key);
            done(keys);
        };
    });
}
