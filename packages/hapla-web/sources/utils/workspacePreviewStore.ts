// HTTP supports IndexedDB. Normal profiles can store committed Blobs outside the
// JS heap. Private/blocked storage uses browser-managed Blobs, which may use RAM.
const DATABASE = 'hapla-workspace-preview-v1';
const CHUNKS = 'chunks';
const OWNERS = 'owners';
const TIMEOUT_MS = 15_000;
const STALE_MS = 24 * 60 * 60 * 1000;
const CLOSED_OWNER_PREFIX = 'hapla:closed-workspace-preview:v1:';
const ownerRange = (owner: string) => IDBKeyRange.bound(`${owner}:`, `${owner}:\uffff`);
function closedOwners(): string[] {
    try {
        const ids: string[] = [];
        for (let index = 0; index < localStorage.length; index++) {
            const key = localStorage.key(index);
            if (key?.startsWith(CLOSED_OWNER_PREFIX) && /^[a-f0-9]{32}$/.test(key.slice(CLOSED_OWNER_PREFIX.length))) ids.push(key.slice(CLOSED_OWNER_PREFIX.length));
        }
        return ids;
    } catch { return []; }
}
function markClosedOwner(id: string): void {
    try { localStorage.setItem(CLOSED_OWNER_PREFIX + id, '1'); } catch { /* Expiry sweep remains available. */ }
}
function forgetClosedOwners(ids: string[]): void {
    try { for (const id of ids) localStorage.removeItem(CLOSED_OWNER_PREFIX + id); } catch { /* Next page retries. */ }
}

/** Run at document startup/restore, before the new page creates any previews.
 * Browser teardown can abort asynchronous pagehide deletion. A synchronous
 * closed-owner marker survives until deletion commits. Active tabs have no such
 * marker, so a new/duplicated tab cannot delete another tab's live previews.
 */
export async function cleanupPreviousPagePreviews(): Promise<void> {
    const ids = closedOwners();
    if (!ids.length || typeof indexedDB === 'undefined') return;
    await new Promise<void>(resolve => {
        let db: IDBDatabase | undefined;
        let tx: IDBTransaction | undefined;
        let settled = false;
        const finish = (deleted: boolean) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            if (deleted) forgetClosedOwners(ids);
            db?.close();
            resolve();
        };
        const timer = setTimeout(() => { try { tx?.abort(); } catch { /* Already ended. */ } finish(false); }, TIMEOUT_MS);
        let request: IDBOpenDBRequest;
        try { request = indexedDB.open(DATABASE, 1); }
        catch { finish(false); return; }
        request.onerror = () => finish(false);
        request.onupgradeneeded = () => {
            request.result.createObjectStore(CHUNKS);
            request.result.createObjectStore(OWNERS);
        };
        request.onsuccess = () => {
            db = request.result;
            if (settled) { db.close(); return; }
            try {
                tx = db.transaction([CHUNKS, OWNERS], 'readwrite');
                for (const id of ids) {
                    tx.objectStore(CHUNKS).delete(ownerRange(id));
                    tx.objectStore(OWNERS).delete(id);
                }
                tx.oncomplete = () => finish(true);
                tx.onabort = tx.onerror = () => finish(false);
            } catch { finish(false); }
        };
    }).catch(() => undefined);
}
export type WorkspacePreviewStore = { append: (blob: Blob) => Promise<Blob>; close: () => void };

/** Remove all persisted preview bytes when the browser changes accounts. */
export async function clearWorkspacePreviewPersistence(): Promise<void> {
    if (typeof indexedDB === 'undefined') return;
    await new Promise<void>((resolve, reject) => {
        let db: IDBDatabase | undefined;
        let tx: IDBTransaction | undefined;
        let settled = false;
        const finish = (error?: Error) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            db?.close();
            error ? reject(error) : resolve();
        };
        const failure = () => finish(new Error('无法清除上一个账号的文件缓存，请重试'));
        const timer = setTimeout(() => { try { tx?.abort(); } catch { /* Already ended. */ } failure(); }, TIMEOUT_MS);
        let request: IDBOpenDBRequest;
        try { request = indexedDB.open(DATABASE, 1); }
        catch { finish(); return; } // Unavailable storage cannot contain readable preview bytes.
        request.onupgradeneeded = () => {
            request.result.createObjectStore(CHUNKS);
            request.result.createObjectStore(OWNERS);
        };
        request.onerror = failure;
        request.onsuccess = () => {
            db = request.result;
            if (settled) { db.close(); return; }
            try {
                tx = db.transaction([CHUNKS, OWNERS], 'readwrite');
                tx.objectStore(CHUNKS).clear();
                tx.objectStore(OWNERS).clear();
                tx.oncomplete = () => finish();
                tx.onerror = tx.onabort = failure;
            } catch { failure(); }
        };
    });
}
const cancelled = () => new DOMException('Cancelled', 'AbortError');
const quotaError = (problem: unknown) => (problem as DOMException)?.name === 'QuotaExceededError';
const storageError = (problem: unknown) => new Error(quotaError(problem)
    ? '浏览器临时存储空间不足，请释放设备空间后重试' : '文件临时存储失败，请重试');

export async function openWorkspacePreviewStore(signal: AbortSignal): Promise<WorkspacePreviewStore> {
    if (signal.aborted) throw cancelled();
    const memory = (): WorkspacePreviewStore => {
        let closed = false;
        const close = () => {
            closed = true;
            signal.removeEventListener('abort', close);
            globalThis.removeEventListener?.('pagehide', close);
        };
        signal.addEventListener('abort', close, { once: true });
        globalThis.addEventListener?.('pagehide', close);
        return { append: async blob => { if (signal.aborted || closed) throw cancelled(); return blob; }, close };
    };
    if (typeof indexedDB === 'undefined') return memory();
    let db: IDBDatabase;
    try {
        db = await new Promise<IDBDatabase>((resolve, reject) => {
            const request = indexedDB.open(DATABASE, 1);
            let settled = false;
            const finish = (problem?: unknown) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                signal.removeEventListener('abort', abort);
                problem ? reject(problem) : resolve(request.result);
            };
            const abort = () => finish(cancelled());
            const timer = setTimeout(() => finish(new Error('文件临时存储连接超时')), TIMEOUT_MS);
            signal.addEventListener('abort', abort, { once: true });
            request.onupgradeneeded = () => { request.result.createObjectStore(CHUNKS); request.result.createObjectStore(OWNERS); };
            request.onerror = () => finish(request.error);
            request.onsuccess = () => { if (settled) request.result.close(); else finish(); };
        });
    } catch (problem) {
        if (signal.aborted) throw cancelled();
        if (quotaError(problem)) throw storageError(problem);
        return memory();
    }
    const id = Array.from(crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2, '0')).join('');
    const range = ownerRange;
    let sequence = 0;
    let closed = false;
    let active: IDBTransaction | null = null;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    // A page in the back/forward cache must not pin whole preview files. The
    // file screen reloads its presentation on pageshow when restored from it.
    const onPageHide = () => close();
    const close = () => {
        if (closed) return;
        closed = true;
        markClosedOwner(id);
        clearInterval(heartbeat);
        signal.removeEventListener('abort', close);
        globalThis.removeEventListener?.('pagehide', onPageHide);
        try { active?.abort(); } catch { /* Already complete. */ }
        // WebKit needs the records alive until preview release, even after get.
        // Queue deletion before closing; later opens sweep crash leftovers.
        try {
            const tx = db.transaction([CHUNKS, OWNERS], 'readwrite');
            tx.objectStore(CHUNKS).delete(range(id));
            tx.objectStore(OWNERS).delete(id);
            tx.oncomplete = () => forgetClosedOwners([id]);
        } catch { /* Next open retries abandoned-record cleanup. */ }
        db.close();
    };
    signal.addEventListener('abort', close, { once: true });
    globalThis.addEventListener?.('pagehide', onPageHide);
    db.onversionchange = close;
    const transaction = <T>(mode: IDBTransactionMode, issue: (tx: IDBTransaction) => IDBRequest<T>, stores: string[] = [CHUNKS, OWNERS]): Promise<T> => {
        if (closed || signal.aborted) return Promise.reject(cancelled());
        return new Promise<T>((resolve, reject) => {
            const tx = db.transaction(stores, mode);
            active = tx;
            const request = issue(tx);
            let settled = false;
            const finish = (problem?: unknown) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                if (active === tx) active = null;
                problem ? reject(problem) : resolve(request.result);
            };
            const timer = setTimeout(() => {
                try { tx.abort(); } catch { /* WebKit may already have failed. */ }
                finish(new Error('文件临时存储写入超时，请重试'));
            }, TIMEOUT_MS);
            tx.oncomplete = () => finish();
            tx.onabort = () => finish(closed || signal.aborted ? cancelled() : tx.error || request.error || new Error('文件临时存储已中断'));
            tx.onerror = (event) => {
                // Some WebKit private contexts emit error without a subsequent
                // abort/complete when Blob storage is unsupported. Settle here.
                const problem = (event.target as IDBRequest)?.error || tx.error || request.error || new Error('文件临时存储不可用');
                event.preventDefault();
                try { tx.abort(); } catch { /* It may already be terminal. */ }
                finish(closed || signal.aborted ? cancelled() : problem);
            };
        });
    };
    try {
        await transaction('readwrite', tx => {
            const cursor = tx.objectStore(OWNERS).openCursor();
            cursor.onsuccess = () => {
                const entry = cursor.result;
                if (!entry) return;
                if (entry.value < Date.now() - STALE_MS) {
                    tx.objectStore(CHUNKS).delete(range(String(entry.key)));
                    entry.delete();
                }
                entry.continue();
            };
            return cursor;
        });
        // Safari private contexts expose IndexedDB but may reject Blob storage.
        // Probe before remote reads. This is a capability gate, not a size limit.
        await transaction('readwrite', tx => tx.objectStore(CHUNKS).put(new Blob(['probe']), `${id}:probe`), [CHUNKS]);
        await transaction('readwrite', tx => {
            tx.objectStore(OWNERS).put(Date.now(), id);
            return tx.objectStore(CHUNKS).delete(`${id}:probe`);
        });
    } catch (problem) {
        close();
        if (signal.aborted) throw cancelled();
        if (quotaError(problem)) throw storageError(problem);
        return memory();
    }
    heartbeat = setInterval(() => {
        if (closed) return;
        try { db.transaction(OWNERS, 'readwrite').objectStore(OWNERS).put(Date.now(), id); } catch { /* Next chunk surfaces failures. */ }
    }, 60_000);
    return {
        async append(blob) {
            if (closed || signal.aborted) throw cancelled();
            const key = `${id}:${sequence++}`;
            try {
                await transaction('readwrite', tx => tx.objectStore(CHUNKS).put(blob, key));
                const saved = await transaction<Blob | undefined>('readonly', tx => tx.objectStore(CHUNKS).get(key));
                if (!(saved instanceof Blob) || saved.size !== blob.size) throw new Error('文件临时存储校验失败');
                return saved;
            } catch (problem) {
                const wasCancelled = closed || signal.aborted || (problem as DOMException)?.name === 'AbortError';
                close();
                if (wasCancelled) throw cancelled();
                throw storageError(problem);
            }
        }, close,
    };
}
