export type CodexStreamSnapshot = {
    id: string;
    turnId: string;
    branchId?: string;
    text: string;
    seq: number;
    epoch?: string;
    kind?: 'tool-output' | 'reasoning-summary';
    callId?: string;
    truncated?: boolean;
    totalBytes?: number;
};

type Entry = {
    snapshot: CodexStreamSnapshot;
    timer: ReturnType<typeof setTimeout> | null;
    lastSentAt: number;
    final: boolean;
};

/** Keeps the final snapshot alive until its matching durable message is acknowledged. */
export class CodexSessionStreamBuffer {
    private readonly entries = new Map<string, Entry>();

    constructor(private readonly publish: (snapshot: CodexStreamSnapshot) => void, private readonly intervalMs = 80) {}

    append(context: Pick<CodexStreamSnapshot, 'id' | 'turnId' | 'branchId' | 'epoch'>, delta: string): void {
        const entry = this.entries.get(context.id);
        const sameItem = entry && this.sameContext(entry.snapshot, context);
        if (sameItem && entry.final) return;
        this.update({ ...context, text: (sameItem ? entry.snapshot.text : '') + delta });
    }

    update(snapshot: Omit<CodexStreamSnapshot, 'seq'>): void {
        let entry = this.entries.get(snapshot.id);
        if (entry && !this.sameContext(entry.snapshot, snapshot)) {
            if (entry.timer) clearTimeout(entry.timer);
            entry = undefined;
        }
        if (entry?.final) return;
        if (!entry) {
            entry = { snapshot: { ...snapshot, seq: 0 }, timer: null, lastSentAt: 0, final: false };
            this.entries.set(snapshot.id, entry);
        }
        entry.snapshot = { ...snapshot, seq: entry.snapshot.seq + 1 };
        const delayMs = Math.max(0, this.intervalMs - (Date.now() - entry.lastSentAt));
        if (delayMs === 0) this.flushEntry(entry);
        else if (!entry.timer) entry.timer = setTimeout(() => this.flushEntry(entry!), delayMs);
    }

    /** Returns a callback scoped to this exact item generation, for the persistence acknowledgement. */
    finish(id: string, text?: string): () => void {
        const entry = this.entries.get(id);
        if (!entry) return () => {};
        if (typeof text === 'string') entry.snapshot = { ...entry.snapshot, text, seq: entry.snapshot.seq + 1 };
        entry.final = true;
        this.flushEntry(entry);
        return () => {
            if (this.entries.get(id) === entry) this.entries.delete(id);
        };
    }

    flushTurn(turnId: string): void {
        for (const entry of this.entries.values()) {
            if (entry.snapshot.turnId === turnId) this.flushEntry(entry);
        }
    }

    dispose(): void {
        for (const entry of this.entries.values()) {
            if (entry.timer) clearTimeout(entry.timer);
        }
        this.entries.clear();
    }

    private flushEntry(entry: Entry): void {
        if (entry.timer) clearTimeout(entry.timer);
        entry.timer = null;
        entry.lastSentAt = Date.now();
        this.publish({ ...entry.snapshot });
    }

    private sameContext(a: Pick<CodexStreamSnapshot, 'turnId' | 'branchId' | 'epoch'>, b: Pick<CodexStreamSnapshot, 'turnId' | 'branchId' | 'epoch'>): boolean {
        return a.turnId === b.turnId && a.branchId === b.branchId && a.epoch === b.epoch;
    }
}
