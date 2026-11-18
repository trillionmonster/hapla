import { afterEach, describe, expect, it, vi } from 'vitest';
import { ForwardScrollViewport, type ForwardScrollViewportProps } from './ForwardScrollViewport';
import type { ForwardScrollRow, ForwardScrollSnapshot } from './forwardScrollAnchor';

type Internals = {
    viewport: HTMLDivElement;
    content: HTMLDivElement;
    mounted: boolean;
    initialPositionApplied: boolean;
    followingLatest: boolean;
    measureRows: () => ForwardScrollRow[];
    isNestedScroller: () => boolean;
    refreshBaseline: () => void;
    handleResize: () => void;
    handleScroll: () => void;
    handleTouchStart: (event: TouchEvent) => void;
    handleTouchMove: (event: TouchEvent) => void;
    handleTouchEnd: (event: TouchEvent) => void;
    handleWheel: (event: WheelEvent) => void;
    clearQuietTimer: () => void;
    baseline: ForwardScrollSnapshot | null;
};

function harness(props: Partial<ForwardScrollViewportProps> = {}) {
    const component = new ForwardScrollViewport({ children: null, ...props });
    const internal = component as unknown as Internals;
    let top = 500;
    const writes: number[] = [];
    const element = {
        get scrollTop() { return top; },
        set scrollTop(value: number) { writes.push(value); top = value; },
        scrollHeight: 2000,
        clientHeight: 600,
    };
    let rows: ForwardScrollRow[] = [{ id: 'reading', contentTop: 400, height: 800 }];
    internal.viewport = element as HTMLDivElement;
    internal.mounted = true;
    internal.initialPositionApplied = true;
    internal.followingLatest = false;
    internal.measureRows = () => rows;
    internal.isNestedScroller = () => false;
    internal.refreshBaseline();
    return { component, internal, element, writes,
        setPhysicalScroll(value: number) { top = value; },
        setRows(value: ForwardScrollRow[]) { rows = value; },
    };
}

const touch = (count: number, y = 100) => ({ touches: Array.from({ length: count }, () => ({ clientY: y })) }) as unknown as TouchEvent;
const wheel = (deltaY = -50) => ({ deltaX: 0, deltaY }) as WheelEvent;

afterEach(() => vi.useRealTimers());

describe('ForwardScrollViewport layout ownership', () => {
    it('measures only requested older rows rather than unrelated live content or status height', () => {
        const h = harness();
        h.internal.content = { children: [
            { getAttribute: () => null, getBoundingClientRect: () => ({ height: 32 }) },
            { getAttribute: () => 'older', getBoundingClientRect: () => ({ height: 68 }) },
            { getAttribute: () => 'live', getBoundingClientRect: () => ({ height: 4000 }) },
        ] } as unknown as HTMLDivElement;
        expect(h.component.getRowsHeight(new Set(['older']))).toBe(68);
        expect(h.component.getRowsHeight(new Set())).toBe(0);
    });
    it('reports actual row height even when min-height makes content fill an otherwise empty viewport', () => {
        const onLayout = vi.fn();
        const h = harness({ onLayout });
        h.element.scrollHeight = h.element.clientHeight;
        h.internal.content = { children: [
            { matches: () => false, getBoundingClientRect: () => ({ height: 32 }) },
            { matches: () => true, getBoundingClientRect: () => ({ height: 68 }) },
            { matches: () => true, getBoundingClientRect: () => ({ height: 40 }) },
        ] } as unknown as HTMLDivElement;
        h.internal.handleResize();
        expect(onLayout).toHaveBeenLastCalledWith({ viewportHeight: 600, rowsHeight: 108 });
    });
    it('corrects a React prepend once and never corrects it again on ResizeObserver or queued scroll', () => {
        const h = harness();
        const snapshot = h.component.getSnapshotBeforeUpdate();
        h.element.scrollHeight += 120;
        h.setRows([{ id: 'reading', contentTop: 520, height: 800 }]);
        h.component.componentDidUpdate({ children: null }, undefined, snapshot);
        expect(h.writes).toEqual([620]);
        h.internal.handleResize();
        h.internal.handleScroll();
        expect(h.writes).toEqual([620]);
        h.internal.clearQuietTimer();
    });

    it('makes no scroll writes while the user moves through an unchanged layout', () => {
        vi.useFakeTimers();
        const onUserScroll = vi.fn();
        const h = harness({ onUserScroll });
        h.internal.handleTouchStart(touch(1));
        for (const value of [450, 300, 280, 290, 700, 1000]) {
            h.setPhysicalScroll(value);
            h.internal.handleScroll();
            h.internal.handleResize();
        }
        expect(h.writes).toEqual([]);
        expect(onUserScroll).toHaveBeenCalledTimes(6);
        h.internal.clearQuietTimer();
    });

    it('does not turn an external scrollTop placement into a history gesture', () => {
        const onGestureStart = vi.fn();
        const onUserScroll = vi.fn();
        const onHistoryIntent = vi.fn();
        const h = harness({ onGestureStart, onUserScroll, onHistoryIntent });
        h.setPhysicalScroll(20);
        h.internal.handleScroll();
        expect(onGestureStart).not.toHaveBeenCalled();
        expect(onUserScroll).not.toHaveBeenCalled();
        expect(onHistoryIntent).not.toHaveBeenCalled();
        expect(h.writes).toEqual([]);
        expect(h.internal.baseline?.scrollTop).toBe(20);
    });

    it('preserves real scrolling when an image grows before ResizeObserver delivers', () => {
        vi.useFakeTimers();
        const h = harness();
        h.setPhysicalScroll(450);
        h.element.scrollHeight += 96;
        h.setRows([{ id: 'reading', contentTop: 496, height: 800 }]);
        h.internal.handleScroll();
        h.internal.handleResize();
        expect(h.writes).toEqual([546]);
        h.internal.clearQuietTimer();
    });

    it('resumes streaming follow after the user scrolls back to the bottom', () => {
        vi.useFakeTimers();
        const h = harness();
        h.component.scrollToLatest(); h.internal.handleScroll();
        h.internal.handleWheel(wheel(-100));
        h.setPhysicalScroll(1300); h.internal.handleScroll();
        h.element.scrollHeight += 100; h.internal.handleResize();
        expect(h.writes).toEqual([1400]);
        h.internal.handleWheel(wheel(200));
        h.setPhysicalScroll(1500); h.internal.handleScroll();
        h.element.scrollHeight += 100; h.internal.handleResize();
        expect(h.writes).toEqual([1400, 1600]);
        h.internal.clearQuietTimer();
    });

    it('keeps the latest token visible through a delayed scroll event and viewport resize', () => {
        const h = harness();
        h.component.scrollToLatest(); h.internal.handleScroll();
        h.element.scrollHeight += 100;
        h.setPhysicalScroll(1398); h.internal.handleScroll();
        expect(h.internal.followingLatest).toBe(true);
        expect(h.element.scrollTop).toBe(1500);
        h.element.clientHeight -= 100; h.internal.handleResize();
        expect(h.element.scrollTop).toBe(1600);
        h.element.scrollHeight += 80; h.internal.handleResize();
        expect(h.element.scrollTop).toBe(1680);
    });

    it('waits for the first Normal-mode row and then performs initial placement only once', () => {
        const h = harness();
        h.internal.initialPositionApplied = false;
        h.setPhysicalScroll(0);
        h.setRows([]);
        h.internal.refreshBaseline();
        h.internal.handleResize();
        expect(h.writes).toEqual([]);
        h.setRows([{ id: 'first-answer', contentTop: 0, height: 2000 }]);
        h.component.componentDidUpdate({ children: null }, undefined, h.internal.baseline);
        expect(h.writes).toEqual([1400]);
        h.internal.handleResize();
        expect(h.writes).toEqual([1400]);
    });

    it('restores the same paragraph inside a tall cached message without index retries', () => {
        const h = harness({ initialAnchor: { id: 'long', viewportTop: -700, distanceFromBottom: 500 } });
        h.internal.initialPositionApplied = false;
        h.setRows([{ id: 'long', contentTop: 300, height: 1600 }]);
        h.internal.handleResize();
        expect(h.writes).toEqual([1000]);
        expect(h.internal.followingLatest).toBe(false);
    });

    it('restores an old cached row without viewportTop at the row start', () => {
        const h = harness({ initialAnchor: { id: 'reading', distanceFromBottom: 30 } });
        h.internal.initialPositionApplied = false;
        h.internal.handleResize();
        expect(h.writes).toEqual([400]);
    });

    it('does not perform delayed initial positioning once a user starts a gesture', () => {
        const h = harness({ initialAnchor: { id: 'old', distanceFromBottom: 200 } });
        h.internal.initialPositionApplied = false;
        h.setRows([]);
        h.setPhysicalScroll(0);
        h.internal.refreshBaseline();
        h.internal.handleTouchStart(touch(1));
        h.setRows([{ id: 'old', contentTop: 800, height: 500 }]);
        h.internal.handleResize();
        expect(h.writes).toEqual([]);
        expect(h.internal.followingLatest).toBe(false);
    });

    it('publishes the whole row position while a Markdown paragraph owns the layout anchor', () => {
        const onPosition = vi.fn();
        const h = harness({ onPosition });
        h.setRows([
            { id: 'paragraph', contentTop: 450, height: 250, rowId: 'reading', rowContentTop: 100 },
            { id: 'reading', contentTop: 100, height: 1700 },
        ]);
        h.internal.refreshBaseline();
        h.internal.handleResize();
        expect(onPosition).toHaveBeenLastCalledWith({
            scrollTop: 500, distanceFromBottom: 900, anchorId: 'reading', anchorViewportTop: -400,
        });
    });
});

describe('ForwardScrollViewport physical gestures', () => {
    it('keeps a finger held down active and includes subsequent inertia in that same gesture', () => {
        vi.useFakeTimers();
        const onGestureStart = vi.fn();
        const onGestureEnd = vi.fn();
        const onInteractionChange = vi.fn();
        const h = harness({ onGestureStart, onGestureEnd, onInteractionChange });
        h.internal.handleTouchStart(touch(1));
        h.internal.handleTouchStart(touch(2));
        vi.advanceTimersByTime(2000);
        expect(onGestureStart).toHaveBeenCalledTimes(1);
        expect(onGestureEnd).not.toHaveBeenCalled();
        h.internal.handleTouchEnd(touch(1));
        vi.advanceTimersByTime(2000);
        expect(onGestureEnd).not.toHaveBeenCalled();
        h.internal.handleTouchEnd(touch(0));
        vi.advanceTimersByTime(100);
        h.setPhysicalScroll(400);
        h.internal.handleScroll();
        vi.advanceTimersByTime(179);
        expect(onGestureEnd).not.toHaveBeenCalled();
        vi.advanceTimersByTime(1);
        expect(onGestureStart).toHaveBeenCalledTimes(1);
        expect(onGestureEnd).toHaveBeenCalledTimes(1);
        expect(onInteractionChange.mock.calls).toEqual([[true], [false]]);
    });

    it('keeps wheel bursts 466ms apart within one 750ms gesture', () => {
        vi.useFakeTimers();
        const onGestureStart = vi.fn();
        const onGestureEnd = vi.fn();
        const h = harness({ onGestureStart, onGestureEnd });
        h.internal.handleWheel(wheel());
        vi.advanceTimersByTime(466);
        h.internal.handleWheel(wheel());
        vi.advanceTimersByTime(749);
        expect(onGestureStart).toHaveBeenCalledTimes(1);
        expect(onGestureEnd).not.toHaveBeenCalled();
        vi.advanceTimersByTime(1);
        expect(onGestureEnd).toHaveBeenCalledTimes(1);
    });

    it('only requests history near the top while moving toward older messages', () => {
        vi.useFakeTimers();
        const onHistoryIntent = vi.fn();
        const h = harness({ onHistoryIntent });
        h.internal.handleWheel(wheel(-50));
        expect(onHistoryIntent).not.toHaveBeenCalled();
        h.setPhysicalScroll(100);
        h.internal.handleWheel(wheel(50));
        expect(onHistoryIntent).not.toHaveBeenCalled();
        h.internal.handleWheel(wheel(-50));
        expect(onHistoryIntent).toHaveBeenCalledTimes(1);
        h.internal.handleTouchStart(touch(1, 200));
        h.internal.handleTouchMove(touch(1, 150));
        expect(onHistoryIntent).toHaveBeenCalledTimes(1);
        h.internal.handleTouchMove(touch(1, 220));
        expect(onHistoryIntent).toHaveBeenCalledTimes(2);
        h.internal.clearQuietTimer();
    });

    it('does not load history while a nested tool scrolls or a pinch gesture moves', () => {
        vi.useFakeTimers();
        const onHistoryIntent = vi.fn();
        const h = harness({ onHistoryIntent });
        h.setPhysicalScroll(100);
        h.internal.isNestedScroller = () => true;
        h.internal.handleWheel(wheel());
        h.internal.handleTouchStart(touch(1, 100));
        h.internal.handleTouchMove(touch(1, 200));
        expect(onHistoryIntent).not.toHaveBeenCalled();
        h.internal.handleTouchEnd(touch(0));
        vi.advanceTimersByTime(180);
        h.internal.isNestedScroller = () => false;
        h.internal.handleTouchStart(touch(2, 100));
        h.internal.handleTouchMove(touch(2, 200));
        expect(onHistoryIntent).not.toHaveBeenCalled();
        h.internal.clearQuietTimer();
    });
});
