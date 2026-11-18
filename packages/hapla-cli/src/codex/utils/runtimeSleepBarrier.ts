/** Serialize manual sleep against queued input and the next provider Turn. */
export class RuntimeSleepBarrier {
    private phase: 'awake' | 'preparing' | 'prepared' | 'asleep' = 'awake';
    private inputVersion = 0;
    private operation: Promise<void> | null = null;
    private waiters: Array<(awake: boolean) => void> = [];

    noteInput(): void {
        this.inputVersion++;
        // A new prompt transparently wakes a just-prepared runtime before it exits.
        if (this.phase === 'prepared') this.cancel();
    }

    prepare(action: () => Promise<void>): Promise<void> {
        if (this.operation) return this.operation;
        if (this.phase === 'prepared' || this.phase === 'asleep') return Promise.resolve();
        const version = this.inputVersion;
        this.phase = 'preparing';
        this.operation = Promise.resolve().then(async () => {
            try {
                await action();
                if (version !== this.inputVersion) throw new Error('A new message arrived while sleep was being prepared; the runtime remains awake.');
                this.phase = 'prepared';
            } catch (error) {
                this.cancel();
                throw error;
            } finally { this.operation = null; }
        });
        return this.operation;
    }

    /** Commit only after the sleep RPC response has had a chance to be sent. */
    commit(): boolean {
        if (this.phase !== 'prepared') return false;
        this.phase = 'asleep';
        this.release(false);
        return true;
    }

    cancel(): void {
        this.phase = 'awake';
        this.release(true);
    }

    waitForTurn(): Promise<boolean> {
        if (this.phase === 'awake') return Promise.resolve(true);
        if (this.phase === 'asleep') return Promise.resolve(false);
        return new Promise((resolve) => { this.waiters.push(resolve); });
    }

    private release(awake: boolean): void {
        for (const resolve of this.waiters.splice(0)) resolve(awake);
    }
}
