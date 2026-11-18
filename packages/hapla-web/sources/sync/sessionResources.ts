/** Conservative retained-size estimate; shared object references are counted once. */
export function estimateRetainedBytes(value: unknown): number {
    const seen = new Set<object>();
    const stack: unknown[] = [value];
    let bytes = 0;
    while (stack.length) {
        const current = stack.pop();
        if (typeof current === 'string') { bytes += current.length * 2 + 16; continue; }
        if (current === null || typeof current !== 'object') { bytes += 8; continue; }
        if (seen.has(current)) continue;
        seen.add(current);
        if (ArrayBuffer.isView(current)) { bytes += current.byteLength + 64; continue; }
        if (current instanceof ArrayBuffer) { bytes += current.byteLength + 32; continue; }
        bytes += 64;
        if (current instanceof Map) for (const [key, entry] of current) stack.push(key, entry);
        else if (current instanceof Set || Array.isArray(current)) for (const entry of current) stack.push(entry);
        else for (const [key, entry] of Object.entries(current)) { bytes += key.length * 2 + 8; stack.push(entry); }
    }
    return bytes;
}

export class ByteLruCache<T> {
    private entries = new Map<string, { value: T; bytes: number; owner?: string }>();
    bytes = 0;
    constructor(readonly maxBytes: number) {}
    get size() { return this.entries.size; }
    get(key: string): T | undefined {
        const entry = this.entries.get(key);
        if (!entry) return undefined;
        this.entries.delete(key);
        this.entries.set(key, entry);
        return entry.value;
    }
    set(key: string, value: T, owner?: string): void {
        this.delete(key);
        const bytes = estimateRetainedBytes(value);
        if (bytes > this.maxBytes) return;
        this.entries.set(key, { value, bytes, owner });
        this.bytes += bytes;
        while (this.bytes > this.maxBytes) this.delete(this.entries.keys().next().value!);
    }
    delete(key: string): void {
        const entry = this.entries.get(key);
        if (entry) { this.bytes -= entry.bytes; this.entries.delete(key); }
    }
    clearOwner(owner: string): void {
        for (const [key, entry] of this.entries) if (entry.owner === owner) this.delete(key);
    }
    clear(): void { this.entries.clear(); this.bytes = 0; }
}

export class SessionResourceRegistry {
    private cleanups = new Map<string, Set<() => void>>();
    private generations = new Map<string, number>();
    register(sessionId: string, cleanup: () => void): () => void {
        const entries = this.cleanups.get(sessionId) ?? new Set<() => void>();
        entries.add(cleanup);
        this.cleanups.set(sessionId, entries);
        return () => {
            entries.delete(cleanup);
            if (entries.size === 0 && this.cleanups.get(sessionId) === entries) this.cleanups.delete(sessionId);
        };
    }
    isRetained(sessionId: string): boolean { return this.cleanups.has(sessionId); }
    capture(sessionId: string): () => boolean {
        const generation = this.generations.get(sessionId) ?? 0;
        return () => generation === (this.generations.get(sessionId) ?? 0);
    }
    release(sessionId: string): void {
        this.generations.set(sessionId, (this.generations.get(sessionId) ?? 0) + 1);
        const entries = this.cleanups.get(sessionId);
        this.cleanups.delete(sessionId);
        for (const cleanup of entries ?? []) {
            try { cleanup(); } catch (error) { console.warn('Session resource cleanup failed', error); }
        }
    }
    releaseAll(): void {
        for (const sessionId of [...this.cleanups.keys()]) this.release(sessionId);
    }
    trackObjectUrl(sessionId: string, url: string): () => void {
        let released = false;
        const revoke = () => { if (!released) { released = true; URL.revokeObjectURL(url); } };
        const unregister = this.register(sessionId, revoke);
        return () => { unregister(); revoke(); };
    }
    getStats() { return { sessions: this.cleanups.size, resources: [...this.cleanups.values()].reduce((count, entries) => count + entries.size, 0) }; }
}

export const sessionResources = new SessionResourceRegistry();
export const MAX_SESSION_CACHE_BYTES = 24 * 1024 * 1024;

export type SessionScrollAnchor = { sourceSessionId?: string; messageId?: string; seq?: number; offset: number; branchId?: string; viewportTop?: number };
export type SessionViewState = {
    anchor?: SessionScrollAnchor;
    historyDirection?: 'oldest' | 'newest';
    historyLoading?: boolean;
    oldestSeq?: number;
    newestSeq?: number;
    hasOlder?: boolean;
    hasNewer?: boolean;
    wasLoaded?: boolean;
};
