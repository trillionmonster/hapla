export const HISTORY_AUTO_LOAD_DISTANCE = 320;

export type HistoryScrollMetrics = {
    offset: number;
    viewport: number;
    content: number;
};

/** In an inverted list, older records sit at the maximum scroll offset. */
export function isNearOlderHistoryEdge(
    metrics: HistoryScrollMetrics,
    threshold = HISTORY_AUTO_LOAD_DISTANCE,
): boolean {
    if (![metrics.offset, metrics.viewport, metrics.content, threshold].every(Number.isFinite)) return false;
    if (metrics.viewport <= 0 || metrics.content <= 0 || threshold < 0) return false;
    return metrics.content - metrics.viewport - Math.max(0, metrics.offset) <= threshold;
}

/** Layout changes may re-fire onEndReached; only new user intent opens another page. */
export class SessionHistoryGate {
    private armed = false;
    private autoFillAvailable = true;
    private pending = false;
    private gesture = 0;
    private consumedGesture = 0;

    /**
     * Opens a new user-intent generation. Repeated movement and inertia from
     * that gesture may arm the gate, but can consume at most one page.
     * A gesture that starts while a request is pending deliberately cannot
     * unlock another page when that request finishes.
     */
    beginGesture(): void {
        if (this.pending) return;
        this.gesture += 1;
        this.armed = false;
    }

    userScrolledTowardHistory(): void {
        if (!this.pending && this.gesture > this.consumedGesture) this.armed = true;
    }

    endGesture(): void { this.armed = false; }

    take(): boolean {
        if (this.pending || (!this.armed && !this.autoFillAvailable)) return false;
        if (this.gesture > this.consumedGesture) this.consumedGesture = this.gesture;
        this.armed = false;
        this.autoFillAvailable = false;
        this.pending = true;
        return true;
    }

    complete(): void { this.pending = false; }

    /** Measured underfill may scan hidden events without fabricating a gesture. */
    takeAutomatic(): boolean {
        if (this.pending) return false;
        this.armed = false;
        this.autoFillAvailable = false;
        this.consumedGesture = this.gesture;
        this.pending = true;
        return true;
    }
}
