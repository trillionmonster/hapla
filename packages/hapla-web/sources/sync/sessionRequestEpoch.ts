/** Invalidates work already awaiting network, decryption, or a session lock. */
export class SessionRequestEpochs {
    private epochs = new Map<string, number>();

    capture(sessionId: string): () => boolean {
        const epoch = this.epochs.get(sessionId) ?? 0;
        return () => (this.epochs.get(sessionId) ?? 0) === epoch;
    }

    snapshot(): (sessionId: string) => boolean {
        const epochs = new Map(this.epochs);
        return (sessionId) => (this.epochs.get(sessionId) ?? 0) === (epochs.get(sessionId) ?? 0);
    }

    invalidate(sessionId: string): void {
        this.epochs.set(sessionId, (this.epochs.get(sessionId) ?? 0) + 1);
    }
}
