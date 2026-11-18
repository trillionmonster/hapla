import { setTimeout as delay } from 'node:timers/promises';
import type { TurnMediaScan } from './turnMediaArtifacts';
import { ArtifactDeliveryLedger, type ArtifactDeliver } from './artifactDeliveryLedger';

export type ArtifactStep = { turnId: string; branchId?: string; sourceId?: string; time: number; batchId: string };
type Request = { step: ArtifactStep; hints: Set<string> };

/** A bounded, event-driven queue. No filesystem polling runs while Codex is
 * idle. A failed/unstable candidate gets bounded retries and remains eligible
 * at the next completed step; only durable delivery acknowledges a version. */
export class TurnArtifactDelivery {
    private readonly controller = new AbortController();
    private readonly requests: Request[] = [];
    private readonly ledger: ArtifactDeliveryLedger;
    private readonly hintOrigins = new Map<string, ArtifactStep>();
    private running: Promise<void> | null = null;
    private closing = false;

    constructor(private readonly options: {
        scan: (hints: string[], signal: AbortSignal, step: ArtifactStep) => Promise<TurnMediaScan>;
        deliver: ArtifactDeliver;
        ledger?: ArtifactDeliveryLedger;
        onError: (error: unknown) => void;
        throttleMs?: number;
        retryMs?: number;
        maxDrainMs?: number;
    }) { this.ledger = options.ledger ?? new ArtifactDeliveryLedger({ onError: options.onError }); }

    request(step: ArtifactStep, hints: string[] = []): void {
        if (this.closing || this.controller.signal.aborted) return;
        for (const path of hints) this.hintOrigins.set(path, { ...step });
        // Bound queued scans during a burst of tool completions. Coalescing a
        // scan is safe: it still inspects every changed file in the same turn.
        const last = this.requests.at(-1);
        if (last && (last.step.sourceId === step.sourceId || this.requests.length >= 16)) {
            for (const path of hints) last.hints.add(path);
            // Keep the newest cutoff when coalescing; otherwise writes from
            // later steps would be excluded even from the final catch-up scan.
            last.step = last.step.sourceId === step.sourceId ? { ...step } : {
                turnId: step.turnId, branchId: step.branchId, time: step.time,
                batchId: `artifacts:${step.turnId}:remaining`,
            };
        } else this.requests.push({ step: { ...step }, hints: new Set(hints) });
        this.start();
    }

    private start(): void {
        if (this.running) return;
        this.running = this.run().catch(error => {
            if (!this.controller.signal.aborted) this.options.onError(error);
        }).finally(() => { this.running = null; });
    }

    private async run(): Promise<void> {
        const signal = this.controller.signal;
        while (this.requests.length && !signal.aborted) {
            await delay(this.options.throttleMs ?? 350, undefined, { signal });
            const request = this.requests.shift()!;
            for (let attempt = 0; attempt < 3 && !signal.aborted; attempt++) {
                const scan = await this.options.scan([...request.hints], signal, request.step);
                // Capture the entire discovered set before the first transfer.
                // A bounded turn drain can no longer forget the unstarted tail.
                for (const candidate of scan.candidates) this.ledger.capture(candidate,
                    this.hintOrigins.get(candidate.path) ?? request.step, this.options.deliver);
                const retry = await this.ledger.drain(signal) || scan.pending;
                if (!retry || signal.aborted) break;
                if (attempt < 2) await delay(this.options.retryMs ?? 1_000, undefined, { signal });
            }
        }
    }

    async finish(step: ArtifactStep): Promise<void> {
        this.request(step);
        this.closing = true;
        const timer = setTimeout(() => this.cancel(), this.options.maxDrainMs ?? 30_000);
        try {
            // Delivery ACKs may be stalled by a disconnected server. Cancel
            // releases the turn without blocking keepalive or interruption.
            await new Promise<void>(resolve => {
                const done = () => { this.controller.signal.removeEventListener('abort', done); resolve(); };
                this.controller.signal.addEventListener('abort', done, { once: true });
                if (this.controller.signal.aborted) done();
                else void (this.running ?? Promise.resolve()).then(done);
            });
        } finally { clearTimeout(timer); }
    }

    cancel(): void {
        this.closing = true;
        this.requests.length = 0;
        this.controller.abort();
    }
}

export function isCompletedArtifactStep(message: Record<string, unknown>): boolean {
    if (message.type === 'exec_command_end') {
        return (message.status === 'completed' || (message.status === undefined && message.exit_code === 0))
            && message.exit_code !== null && (message.exit_code === undefined || message.exit_code === 0)
            && message.completedByTurn !== true && message.commandNotStarted !== true;
    }
    if (message.type === 'patch_apply_end') return message.status === 'completed';
    if (message.type === 'mcp_tool_call_end') {
        return message.status === 'completed' && !message.error
            && !(message.result && typeof message.result === 'object' && 'isError' in message.result && message.result.isError);
    }
    return false;
}
