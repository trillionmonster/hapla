import * as React from 'react';
import {
    captureForwardScrollSnapshot,
    forwardScrollCorrection,
    type ForwardScrollRow,
    type ForwardScrollSnapshot,
} from './forwardScrollAnchor';

export type ForwardScrollPosition = {
    distanceFromBottom: number;
    scrollTop: number;
    anchorId?: string;
    anchorViewportTop?: number;
};

export type ForwardScrollInitialAnchor = {
    id?: string;
    viewportTop?: number;
    distanceFromBottom?: number;
};

export type ForwardScrollLayout = { viewportHeight: number; rowsHeight: number };

export type ForwardScrollViewportProps = {
    children: React.ReactNode;
    onPosition?: (position: ForwardScrollPosition) => void;
    onLayout?: (layout: ForwardScrollLayout) => void;
    onUserScroll?: (position: { scrollTop: number; previousScrollTop: number }) => void;
    onGestureStart?: () => void;
    onGestureEnd?: () => void;
    onHistoryIntent?: () => void;
    onInteractionChange?: (active: boolean) => void;
    initialAnchor?: ForwardScrollInitialAnchor;
    historyThreshold?: number;
    style?: React.CSSProperties;
};

const ROW_SELECTOR = '[data-hapla-forward-row]';
const TOUCH_QUIET_MS = 180;
const WHEEL_QUIET_MS = 750;
const BOTTOM_SLOP = 4;
const FOLLOW_RESUME_SLOP = 48;

/**
 * Web's chronological message viewport. It owns scroll position completely:
 * native anchoring and transforms are disabled, and layout changes receive one
 * synchronous correction. User scrolling alone never causes a scroll write.
 */
export class ForwardScrollViewport extends React.Component<ForwardScrollViewportProps> {
    private viewport: HTMLDivElement | null = null;
    private content: HTMLDivElement | null = null;
    private resizeObserver: ResizeObserver | null = null;
    private observedRows = new Set<Element>();
    private baseline: ForwardScrollSnapshot | null = null;
    private followingLatest = true;
    private initialPositionApplied = false;
    private lastObservedScrollTop = 0;
    private programmaticScrollTop: number | null = null;
    private interaction: 'touch' | 'wheel' | 'keyboard' | 'scrollbar' | null = null;
    private touchCount = 0;
    private lastTouchY: number | null = null;
    private touchInNestedScroller = false;
    private quietTimer: ReturnType<typeof setTimeout> | null = null;
    private mounted = false;

    getElement = (): HTMLDivElement | null => this.viewport;

    getRowsHeight = (keys: ReadonlySet<string>): number => Array.from(this.content?.children ?? []).reduce((height, element) =>
        height + (keys.has(element.getAttribute('data-hapla-forward-row') ?? '') ? element.getBoundingClientRect().height : 0), 0);

    scrollToLatest = (): void => {
        this.followingLatest = true;
        this.initialPositionApplied = true;
        const viewport = this.viewport;
        if (!viewport) return;
        this.writeScrollTop(Math.max(0, viewport.scrollHeight - viewport.clientHeight));
        this.refreshBaseline();
        this.publishPosition();
    };

    restoreAnchor = (anchor: ForwardScrollInitialAnchor): void => {
        this.initialPositionApplied = false;
        this.applyInitialPosition(anchor);
        this.refreshBaseline();
        this.publishPosition();
    };

    componentDidMount(): void {
        this.mounted = true;
        const viewport = this.viewport;
        if (!viewport) return;
        viewport.addEventListener('scroll', this.handleScroll, { passive: true });
        viewport.addEventListener('wheel', this.handleWheel, { passive: true });
        viewport.addEventListener('touchstart', this.handleTouchStart, { passive: true });
        viewport.addEventListener('touchmove', this.handleTouchMove, { passive: true });
        viewport.addEventListener('touchend', this.handleTouchEnd, { passive: true });
        viewport.addEventListener('touchcancel', this.handleTouchEnd, { passive: true });
        viewport.addEventListener('keydown', this.handleKeyDown);
        viewport.addEventListener('pointerdown', this.handlePointerDown, { passive: true });
        window.addEventListener('pointerup', this.handlePointerUp, { passive: true });
        if (typeof ResizeObserver !== 'undefined') {
            this.resizeObserver = new ResizeObserver(this.handleResize);
            this.resizeObserver.observe(viewport);
            if (this.content) this.resizeObserver.observe(this.content);
        }
        this.observeRows();
        this.applyInitialPosition();
        this.refreshBaseline();
        this.publishPosition();
        this.publishLayout();
    }

    getSnapshotBeforeUpdate(): ForwardScrollSnapshot | null {
        return this.captureSnapshot();
    }

    componentDidUpdate(_previous: ForwardScrollViewportProps, _state: unknown, snapshot: ForwardScrollSnapshot | null): void {
        this.observeRows();
        if (!this.applyInitialPosition()) this.reconcileLayout(snapshot);
        // The ResizeObserver delivery for this same commit now compares with
        // the committed layout, so it cannot apply this correction a second time.
        this.refreshBaseline();
        this.publishPosition();
        this.publishLayout();
    }

    componentWillUnmount(): void {
        this.mounted = false;
        this.clearQuietTimer();
        this.resizeObserver?.disconnect();
        const viewport = this.viewport;
        viewport?.removeEventListener('scroll', this.handleScroll);
        viewport?.removeEventListener('wheel', this.handleWheel);
        viewport?.removeEventListener('touchstart', this.handleTouchStart);
        viewport?.removeEventListener('touchmove', this.handleTouchMove);
        viewport?.removeEventListener('touchend', this.handleTouchEnd);
        viewport?.removeEventListener('touchcancel', this.handleTouchEnd);
        viewport?.removeEventListener('keydown', this.handleKeyDown);
        viewport?.removeEventListener('pointerdown', this.handlePointerDown);
        window.removeEventListener('pointerup', this.handlePointerUp);
    }

    private measureRows(): ForwardScrollRow[] {
        const viewport = this.viewport;
        if (!viewport || !this.content) return [];
        const viewportTop = viewport.getBoundingClientRect().top + viewport.clientTop;
        const viewportBottom = viewportTop + viewport.clientHeight;
        const retainedRows = new Set(this.baseline?.anchors.map((anchor) => anchor.rowId ?? anchor.id));
        return Array.from(this.content.querySelectorAll<HTMLElement>(ROW_SELECTOR)).flatMap((element) => {
            const rect = element.getBoundingClientRect();
            const id = element.getAttribute('data-hapla-forward-row')!;
            const contentTop = rect.top - viewportTop + viewport.scrollTop;
            const blocks: ForwardScrollRow[] = [];
            // A capped transcript can still contain thousands of paragraphs.
            // Only inspect blocks inside visible or retained anchor rows.
            const markdownRoots = (retainedRows.has(id) || (rect.bottom > viewportTop && rect.top < viewportBottom))
                ? element.querySelectorAll('[data-hapla-markdown]') : [];
            Array.from(markdownRoots).forEach((markdown, rootIndex) => {
                if (markdown.closest(ROW_SELECTOR) !== element) return;
                Array.from(markdown.children).forEach((block, blockIndex) => {
                    const blockRect = block.getBoundingClientRect();
                    blocks.push({
                        id: `${id}\u0000markdown:${rootIndex}:${blockIndex}`,
                        contentTop: blockRect.top - viewportTop + viewport.scrollTop,
                        height: blockRect.height,
                        rowId: id,
                        rowContentTop: contentTop,
                    });
                });
            });
            return [...blocks, { id, contentTop, height: rect.height }];
        });
    }

    private captureSnapshot(): ForwardScrollSnapshot | null {
        const viewport = this.viewport;
        if (!viewport) return null;
        return captureForwardScrollSnapshot(viewport.scrollTop, viewport.scrollHeight, viewport.clientHeight,
            this.measureRows(), this.followingLatest);
    }

    private refreshBaseline(): void {
        this.baseline = this.captureSnapshot();
        this.lastObservedScrollTop = this.viewport?.scrollTop ?? 0;
    }

    private reconcileLayout(snapshot: ForwardScrollSnapshot | null): void {
        const viewport = this.viewport;
        if (!viewport || !snapshot) return;
        const correction = forwardScrollCorrection({ ...snapshot, followingLatest: this.followingLatest }, {
            scrollTop: viewport.scrollTop,
            scrollHeight: viewport.scrollHeight,
            viewportHeight: viewport.clientHeight,
            rows: this.measureRows(),
        });
        if (correction !== null) this.writeScrollTop(correction);
    }

    private writeScrollTop(target: number): void {
        const viewport = this.viewport;
        if (!viewport || Math.abs(viewport.scrollTop - target) <= 0.5) return;
        viewport.scrollTop = target;
        // Read the actually applied value. Never chase clamped or delayed
        // Safari writes with timers/animation frames during a physical gesture.
        this.programmaticScrollTop = viewport.scrollTop;
        this.lastObservedScrollTop = viewport.scrollTop;
    }

    private applyInitialPosition(requestedAnchor = this.props.initialAnchor): boolean {
        const viewport = this.viewport;
        if (!viewport || this.initialPositionApplied) return false;
        const rows = this.measureRows();
        // A Normal-mode filter can initially contain no rows. Its first actual
        // row performs the one initial placement, without index-based retries.
        if (rows.length === 0 || viewport.clientHeight === 0) return false;
        this.initialPositionApplied = true;
        const anchor = requestedAnchor;
        const row = anchor?.id ? rows.find((candidate) => candidate.id === anchor.id) : undefined;
        const maximum = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
        this.followingLatest = (anchor?.distanceFromBottom ?? (anchor?.id ? Infinity : 0)) <= BOTTOM_SLOP;
        const target = this.followingLatest ? maximum : row
            ? row.contentTop - (anchor?.viewportTop ?? 0)
            : maximum - Math.max(0, anchor?.distanceFromBottom ?? 0);
        this.writeScrollTop(Math.max(0, Math.min(maximum, target)));
        return true;
    }

    private publishPosition(): void {
        const viewport = this.viewport;
        if (!viewport) return;
        const anchor = this.baseline?.anchors[0];
        this.props.onPosition?.({
            distanceFromBottom: Math.max(0, viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop),
            scrollTop: viewport.scrollTop,
            anchorId: anchor?.rowId ?? anchor?.id,
            anchorViewportTop: anchor ? (anchor.rowContentTop ?? anchor.contentTop) - viewport.scrollTop : undefined,
        });
    }

    private publishLayout(): void {
        if (!this.viewport || !this.content || !this.props.onLayout) return;
        // The content has minHeight:100%, so scrollHeight cannot distinguish
        // one short reply from a full transcript. Measure actual message rows.
        const rowsHeight = Array.from(this.content.children).reduce((height, element) =>
            height + (element.matches(ROW_SELECTOR) ? element.getBoundingClientRect().height : 0), 0);
        this.props.onLayout({ viewportHeight: this.viewport.clientHeight, rowsHeight });
    }

    private observeRows(): void {
        if (!this.resizeObserver || !this.content) return;
        const next = new Set(this.content.querySelectorAll(ROW_SELECTOR));
        for (const element of this.observedRows) {
            if (!next.has(element)) this.resizeObserver.unobserve(element);
        }
        for (const element of next) {
            if (!this.observedRows.has(element)) this.resizeObserver.observe(element);
        }
        this.observedRows = next;
    }

    private handleResize = (): void => {
        if (!this.mounted) return;
        if (!this.applyInitialPosition()) this.reconcileLayout(this.baseline);
        this.refreshBaseline();
        this.publishPosition();
        this.publishLayout();
    };

    private handleScroll = (): void => {
        const viewport = this.viewport;
        if (!viewport) return;
        const top = viewport.scrollTop;
        const previousScrollTop = this.lastObservedScrollTop;
        const programmatic = this.programmaticScrollTop !== null && Math.abs(top - this.programmaticScrollTop) <= 0.5;
        this.programmaticScrollTop = null;
        const moved = Math.abs(top - previousScrollTop) > 0.5;
        if (!programmatic && moved) {
            // Browser scroll events are also trusted after an external
            // scrollTop assignment. Only a preceding physical input can open
            // a history gesture; a scroll event by itself cannot do so.
            if (this.interaction) {
                // Only a reading gesture changes follow intent. A streaming
                // layout, keyboard resize or delayed browser scroll event
                // must not silently turn following off.
                if (!this.touchInNestedScroller) {
                    if (top < previousScrollTop - 0.5) this.followingLatest = false;
                    else if (viewport.scrollHeight - viewport.clientHeight - top <= FOLLOW_RESUME_SLOP) {
                        this.followingLatest = true;
                    }
                }
                this.scheduleQuietEnd();
                this.props.onUserScroll?.({ scrollTop: top, previousScrollTop });
                if (top < previousScrollTop && !this.touchInNestedScroller) this.requestHistory();
            }
        }
        // If a layout and a physical scroll happened in one browser delivery,
        // preserve the real movement and compensate only the content offset.
        this.reconcileLayout(this.baseline);
        this.refreshBaseline();
        this.publishPosition();
    };

    private requestHistory(): void {
        if (this.viewport && this.viewport.scrollTop <= (this.props.historyThreshold ?? 240)) {
            this.props.onHistoryIntent?.();
        }
    }

    private isNestedScroller(target: EventTarget | null): boolean {
        if (!(target instanceof Element)) return false;
        let element: Element | null = target;
        while (element && element !== this.viewport) {
            if (element instanceof HTMLElement) {
                const overflow = getComputedStyle(element).overflowY;
                if (/(auto|scroll)/.test(overflow) && element.scrollHeight > element.clientHeight + 1) return true;
            }
            element = element.parentElement;
        }
        return false;
    }

    private handleWheel = (event: WheelEvent): void => {
        if (this.touchCount > 0 || Math.abs(event.deltaY) <= Math.abs(event.deltaX) || this.isNestedScroller(event.target)) return;
        if (this.interaction !== 'wheel') this.beginInteraction('wheel');
        this.scheduleQuietEnd();
        if (event.deltaY < 0) { this.followingLatest = false; this.requestHistory(); }
        else if (this.viewport && this.viewport.scrollHeight - this.viewport.clientHeight - this.viewport.scrollTop <= FOLLOW_RESUME_SLOP) this.scrollToLatest();
    };

    private handleTouchStart = (event: TouchEvent): void => {
        const firstContact = this.touchCount === 0 && event.touches.length > 0;
        this.touchCount = event.touches.length;
        this.clearQuietTimer();
        if (!firstContact) return;
        this.touchInNestedScroller = this.isNestedScroller(event.target);
        this.lastTouchY = event.touches[0]?.clientY ?? null;
        this.beginInteraction('touch');
    };

    private handleTouchMove = (event: TouchEvent): void => {
        this.touchCount = event.touches.length;
        const nextY = event.touches[0]?.clientY ?? null;
        if (this.touchCount === 1 && !this.touchInNestedScroller && nextY !== null
            && this.lastTouchY !== null && nextY - this.lastTouchY > 0.5) { this.followingLatest = false; this.requestHistory(); }
        this.lastTouchY = nextY;
    };

    private handleTouchEnd = (event: TouchEvent): void => {
        this.touchCount = event.touches.length;
        this.lastTouchY = event.touches[0]?.clientY ?? null;
        if (this.touchCount === 0) this.scheduleQuietEnd();
    };

    private handleKeyDown = (event: KeyboardEvent): void => {
        const element = event.target;
        if (element instanceof HTMLElement && (element.isContentEditable
            || /^(INPUT|TEXTAREA|SELECT)$/.test(element.tagName))) return;
        if (this.isNestedScroller(element) || !['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)) return;
        if (this.interaction !== 'keyboard') this.beginInteraction('keyboard');
        this.scheduleQuietEnd();
        if (['ArrowUp', 'PageUp', 'Home'].includes(event.key) || (event.key === ' ' && event.shiftKey)) { this.followingLatest = false; this.requestHistory(); }
    };

    private handlePointerDown = (event: PointerEvent): void => {
        if (event.pointerType !== 'mouse' || event.target !== this.viewport) return;
        this.beginInteraction('scrollbar');
        this.scheduleQuietEnd();
    };

    private handlePointerUp = (): void => {
        if (this.interaction === 'scrollbar') this.scheduleQuietEnd();
    };

    private beginInteraction(kind: NonNullable<ForwardScrollViewport['interaction']>): void {
        if (kind !== 'touch') this.touchInNestedScroller = false;
        if (!this.initialPositionApplied) {
            // Once the user has started reading, a late first filtered row or
            // resize must not pull them to the originally requested position.
            this.initialPositionApplied = true;
            this.followingLatest = false;
        }
        const wasActive = this.interaction !== null;
        if (wasActive) this.props.onGestureEnd?.();
        this.interaction = kind;
        this.clearQuietTimer();
        if (!wasActive) this.props.onInteractionChange?.(true);
        this.props.onGestureStart?.();
    }

    private clearQuietTimer(): void {
        if (this.quietTimer !== null) clearTimeout(this.quietTimer);
        this.quietTimer = null;
    }

    private scheduleQuietEnd(): void {
        this.clearQuietTimer();
        if (this.touchCount > 0 || this.interaction === null) return;
        this.quietTimer = setTimeout(() => {
            this.quietTimer = null;
            if (!this.mounted || this.touchCount > 0) return;
            this.interaction = null;
            this.touchInNestedScroller = false;
            this.props.onGestureEnd?.();
            this.props.onInteractionChange?.(false);
        }, this.interaction === 'wheel' ? WHEEL_QUIET_MS : TOUCH_QUIET_MS);
    }

    render(): React.ReactNode {
        return <div
            ref={(element) => { this.viewport = element; }}
            data-hapla-forward-viewport="true"
            data-hapla-chat-scroller="forward"
            tabIndex={0}
            style={{ ...this.props.style, display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0,
                overflowY: 'auto', overflowX: 'hidden', overflowAnchor: 'none', scrollBehavior: 'auto',
                overscrollBehaviorY: 'contain', WebkitOverflowScrolling: 'touch' }}
        >
            <div ref={(element) => { this.content = element; }} data-hapla-forward-content="true"
                style={{ display: 'flex', flexDirection: 'column', flexShrink: 0, minHeight: '100%',
                    justifyContent: 'flex-end', overflowAnchor: 'none' }}>
                {this.props.children}
            </div>
        </div>;
    }
}
