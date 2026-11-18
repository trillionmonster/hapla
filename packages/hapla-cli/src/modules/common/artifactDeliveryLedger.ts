import type { ArtifactStep } from './turnArtifactDelivery';
import type { TurnMediaCandidate } from './turnMediaArtifacts';

/** Returning a receipt transfers ownership to the existing session outbox.
 * It must never enqueue the same file again while that outbox owns delivery. */
export type ArtifactDeliveryResult = boolean | { receipt: Promise<void> };
export type ArtifactDeliver = (candidate: TurnMediaCandidate, step: ArtifactStep, signal: AbortSignal) => Promise<ArtifactDeliveryResult>;
type Entry = { candidate: TurnMediaCandidate; step: ArtifactStep; deliver: ArtifactDeliver; receipt?: Promise<void> };

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
    return new Promise((resolve, reject) => {
        const abort = () => reject(signal.reason);
        if (signal.aborted) { abort();void promise.catch(() => undefined);return; }
        signal.addEventListener('abort', abort, { once: true });
        void promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
    });
}

/** Session-lifetime, metadata-only backlog. A per-turn drain may be cancelled,
 * but discovered candidates and their original source survive that cancellation.
 * Only completed-step/reconnection events drain it; there is no idle polling. */
export class ArtifactDeliveryLedger {
    private readonly pending = new Map<string, Entry>();
    private readonly acknowledged = new Map<string, true>();
    private running: Promise<boolean> | null = null;

    constructor(private readonly options: { onError: (error: unknown) => void; maxEntries?: number }) {}

    get pendingCount(): number { return this.pending.size; }
    private pathKey(candidate: TurnMediaCandidate, step: ArtifactStep): string { return `${step.branchId ?? ''}\0${candidate.path}`; }

    capture(candidate: TurnMediaCandidate, step: ArtifactStep, deliver: ArtifactDeliver): void {
        const pathKey = this.pathKey(candidate, step), key = `${pathKey}\0${candidate.version}`;
        if (this.acknowledged.has(key) || this.pending.has(key)) return;
        // A superseded version cannot be read again. Keep already-enqueued
        // versions with their own receipts, but replace unsubmitted old versions.
        for (const [existingKey, entry] of this.pending) {
            if (!entry.receipt && this.pathKey(entry.candidate, entry.step) === pathKey) this.pending.delete(existingKey);
        }
        if (this.pending.size >= (this.options.maxEntries ?? 20_000)) {
            throw new Error('Generated-artifact backlog reached its bounded capacity; pending deliveries were retained');
        }
        this.pending.set(key, { candidate: { ...candidate }, step: { ...step }, deliver });
    }

    private acknowledge(key: string, entry: Entry): void {
        if (this.pending.get(key) !== entry) return;
        this.pending.delete(key);
        this.acknowledged.delete(key);
        this.acknowledged.set(key, true);
        while (this.acknowledged.size > (this.options.maxEntries ?? 20_000)) this.acknowledged.delete(this.acknowledged.keys().next().value!);
    }

    async drain(signal: AbortSignal): Promise<boolean> {
        // A reconnect and an active turn share two workers; they do not create
        // competing upload pools or enqueue the same pending file twice.
        while (this.running) await abortable(this.running, signal);
        signal.throwIfAborted();
        const task = this.performDrain(signal);
        this.running = task;
        try { return await task; }
        finally { if (this.running === task) this.running = null; }
    }

    private async performDrain(signal: AbortSignal): Promise<boolean> {
        const entries = [...this.pending.entries()].filter(([, entry]) => !entry.receipt);
        let index = 0, retry = false;
        await Promise.all([0, 1].map(async () => {
            while (index < entries.length && !signal.aborted) {
                const [key, entry] = entries[index++];
                if (this.pending.get(key) !== entry || entry.receipt) continue;
                try {
                    const operation = entry.deliver(entry.candidate, entry.step, signal);
                    // Observe the actual completion even if the caller stops
                    // waiting immediately after enqueue. This closes the narrow
                    // abort/receipt race without retransmitting an outbox item.
                    const recorded = operation.then(result => {
                        if (result && typeof result === 'object') {
                            entry.receipt = result.receipt;
                            void result.receipt.then(() => this.acknowledge(key, entry), this.options.onError);
                        } else if (result === true) this.acknowledge(key, entry);
                        return result;
                    });
                    if (!await abortable(recorded, signal)) retry = true;
                } catch (error) {
                    retry = true;
                    if (!signal.aborted) this.options.onError(error);
                }
            }
        }));
        return retry;
    }
}
