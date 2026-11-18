/** Keep an unsubmitted prompt in its caller while provider authority is unavailable. */
export class RuntimeTurnBarrier {
    private generation = 0;
    private closed = false;
    private waiters = new Set<() => void>();

    constructor(
        private readonly waitForIdle: () => Promise<void>,
        private readonly onUnavailable: (error: unknown) => void,
    ) {}

    async wait(): Promise<boolean> {
        while (!this.closed) {
            const generation = this.generation;
            try {
                await this.waitForIdle();
                return !this.closed;
            } catch (error) {
                this.onUnavailable(error);
                // Recovery can race the failed await. Do not miss that signal.
                if (generation !== this.generation) continue;
                if (!this.closed) await new Promise<void>((resolve) => this.waiters.add(resolve));
            }
        }
        return false;
    }

    recovered(): void {
        this.generation++;
        for (const resolve of this.waiters) resolve();
        this.waiters.clear();
    }

    close(): void {
        this.closed = true;
        this.recovered();
    }
}
