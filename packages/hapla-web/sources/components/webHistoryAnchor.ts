export type WebHistoryAnchorCandidate = {
    id: string;
    top: number;
    bottom: number;
};

export type WebHistoryAnchorSnapshot = {
    messageId: string | null;
    viewportTop: number | null;
    scrollOffset: number;
};

/** Prefer complete stable messages, then rank visible candidates from the viewport center outwards. */
export function rankWebHistoryAnchors(
    viewportTop: number,
    viewportBottom: number,
    candidates: WebHistoryAnchorCandidate[],
): WebHistoryAnchorCandidate[] {
    if (!Number.isFinite(viewportTop) || !Number.isFinite(viewportBottom) || viewportBottom <= viewportTop) return [];
    const viewportCenter = (viewportTop + viewportBottom) / 2;
    return candidates.flatMap((candidate) => {
        if (!candidate.id || !Number.isFinite(candidate.top) || !Number.isFinite(candidate.bottom)) return [];
        const visibleTop = Math.max(viewportTop, candidate.top);
        const visibleBottom = Math.min(viewportBottom, candidate.bottom);
        const overlap = visibleBottom - visibleTop;
        const height = candidate.bottom - candidate.top;
        if (overlap <= 1 || height <= 1) return [];
        const visibleCenter = (visibleTop + visibleBottom) / 2;
        const fullyVisible = candidate.top >= viewportTop && candidate.bottom <= viewportBottom;
        return [{
            candidate,
            fullyVisible,
            visibleRatio: overlap / height,
            distance: Math.abs(visibleCenter - viewportCenter),
            overlap,
        }];
    }).sort((left, right) => Number(right.fullyVisible) - Number(left.fullyVisible)
        || right.visibleRatio - left.visibleRatio
        || left.distance - right.distance
        || right.overlap - left.overlap)
        .map(({ candidate }) => candidate);
}

/**
 * In RN Web's inverted list, an item's viewport position and scrollTop both
 * move in the same direction. Subtract the real scroll delta from the item's
 * rect delta, then compensate only the remaining layout shift. This preserves
 * touch and momentum movement that happened while the page was loading.
 */
export function webHistoryAnchorCorrection(
    anchor: WebHistoryAnchorSnapshot,
    currentViewportTop: number | null,
    currentScrollOffset: number,
): number {
    if (anchor.viewportTop !== null && currentViewportTop !== null && Number.isFinite(currentViewportTop)) {
        const rectDelta = currentViewportTop - anchor.viewportTop;
        const scrollDelta = currentScrollOffset - anchor.scrollOffset;
        return scrollDelta - rectDelta;
    }
    // Without a surviving DOM anchor there is no way to distinguish a real
    // touch/momentum delta from a layout delta. Keeping the current offset is
    // safer than pulling the user's gesture back to an older snapshot.
    return 0;
}

/**
 * Rebase to the visual position the anchor should reach after its requested
 * correction. Keeping this target (instead of the possibly clamped or
 * compositor-delayed current rect) carries any unapplied residual into the
 * next frame.
 */
export function advanceWebHistoryAnchor(
    anchor: WebHistoryAnchorSnapshot,
    currentViewportTop: number,
    currentScrollOffset: number,
    appliedScrollOffset: number,
): WebHistoryAnchorSnapshot {
    const correction = webHistoryAnchorCorrection(anchor, currentViewportTop, currentScrollOffset);
    return {
        ...anchor,
        viewportTop: currentViewportTop + correction,
        scrollOffset: appliedScrollOffset,
    };
}
