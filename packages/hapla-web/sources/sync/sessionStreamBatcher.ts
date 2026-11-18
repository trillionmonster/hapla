import { estimateRetainedBytes } from './sessionResources';
import type { SessionStream } from './sessionStream';

/** Coalesces only snapshots of the same item; independent tools and summaries retain separate slots. */
export class SessionStreamBatcher {
    private pending = new Map<string, Map<string, SessionStream>>();
    private timers = new Map<string, ReturnType<typeof setTimeout>>();
    constructor(private apply: (sessionId: string, stream: SessionStream) => void, private interval: () => number = () => 50) {}
    enqueue(sessionId: string, stream: SessionStream): void {
        const entries = this.pending.get(sessionId) ?? new Map<string, SessionStream>();
        const key = JSON.stringify([stream.branchId ?? 'main', stream.kind ?? 'text', stream.callId ?? stream.id]);
        const old = entries.get(key);
        if (old && (old.seq !== undefined && stream.seq !== undefined ? old.seq >= stream.seq : old.updatedAt > stream.updatedAt)) return;
        const preview = stream.text.length > 256 * 1024 ? { ...stream, text: stream.text.slice(-256 * 1024), truncated: true } : stream;
        entries.set(key, preview);
        let bytes = estimateRetainedBytes(entries);
        for (const [id, value] of entries) {
            if (bytes <= 2 * 1024 * 1024) break;
            if (id === key) continue;
            bytes -= estimateRetainedBytes(value) + id.length * 2 + 16;
            entries.delete(id);
        }
        this.pending.set(sessionId, entries);
        if (!this.timers.has(sessionId)) this.timers.set(sessionId, setTimeout(() => this.flush(sessionId), this.interval()));
    }
    flush(sessionId: string): void {
        const entries = this.pending.get(sessionId);
        this.clear(sessionId);
        for (const stream of entries?.values() ?? []) this.apply(sessionId, stream);
    }
    clear(sessionId: string): void {
        const timer = this.timers.get(sessionId); if (timer) clearTimeout(timer);
        this.timers.delete(sessionId); this.pending.delete(sessionId);
    }
    getStats() { return { sessions: this.pending.size, items: [...this.pending.values()].reduce((size, entries) => size + entries.size, 0) }; }
}
