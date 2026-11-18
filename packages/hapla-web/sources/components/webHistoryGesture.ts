export type WebHistoryGestureKind = 'wheel' | 'touch' | 'native' | 'explicit';

/**
 * Tracks the physical input sequence independently from scroll event timing.
 * A long main-thread pause must not turn the tail of one wheel gesture into a
 * fresh pagination generation, and adding another finger must not restart a
 * touch gesture.
 */
export class WebHistoryGestureTracker {
    private activeKind: WebHistoryGestureKind | null = null;
    private activeTouchCount = 0;

    hasActiveTouch(): boolean {
        return this.activeTouchCount > 0;
    }

    beginWheel(): boolean {
        if (this.hasActiveTouch()) return false;
        if (this.activeKind === 'wheel') return false;
        this.activeKind = 'wheel';
        return true;
    }

    beginTouch(activeTouchCount: number): boolean {
        const nextCount = normalizeTouchCount(activeTouchCount);
        const firstContact = this.activeTouchCount === 0 && nextCount > 0;
        this.activeTouchCount = nextCount;
        if (!firstContact) return false;
        this.activeKind = 'touch';
        return true;
    }

    updateTouch(activeTouchCount: number): boolean {
        const hadContact = this.activeTouchCount > 0;
        this.activeTouchCount = normalizeTouchCount(activeTouchCount);
        return hadContact && this.activeTouchCount === 0;
    }

    beginNative(): void {
        this.activeKind = 'native';
    }

    beginExplicit(): void {
        this.activeKind = 'explicit';
    }

    finish(): void {
        this.activeKind = null;
        this.activeTouchCount = 0;
    }
}

function normalizeTouchCount(value: number): number {
    if (!Number.isFinite(value)) return 0;
    return Math.max(0, Math.floor(value));
}
