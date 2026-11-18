import type { SessionScrollAnchor } from './sessionResources';

/** Keeps only cursor primitives; viewability can arrive after the final scroll event. */
export class SessionScrollAnchorTracker {
    private visible: Omit<SessionScrollAnchor, 'offset'> | undefined;
    private offset = 0;
    private restoring: boolean;
    private lastSavedAt = 0;

    constructor(saved: SessionScrollAnchor | undefined, private readonly save: (anchor: SessionScrollAnchor) => void) {
        this.restoring = !!saved && saved.offset > 10;
    }

    viewable(anchor: Omit<SessionScrollAnchor, 'offset'>): void {
        this.visible = anchor;
        // FlatList computes viewability after dispatching onScroll. Persist this
        // newest cursor even if there is no subsequent scroll event before blur.
        if (this.offset > 10) this.flush();
    }

    scroll(offset: number, now = Date.now()): void {
        this.offset = offset;
        if (now - this.lastSavedAt >= 250 || offset <= 10) this.flush(now);
    }

    restored(): void { this.restoring = false; }

    flush(now = Date.now()): void {
        if (this.restoring) return;
        if (this.offset > 10 && this.visible?.seq === undefined) return;
        this.lastSavedAt = now;
        this.save(this.offset <= 10 ? { offset: 0, branchId: this.visible?.branchId } : { ...this.visible, offset: this.offset });
    }
}
