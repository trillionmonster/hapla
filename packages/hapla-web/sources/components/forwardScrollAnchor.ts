export type ForwardScrollRow = {
    id: string;
    /** Position in the scrollable content, independent of the current scroll. */
    contentTop: number;
    height: number;
    /** A Markdown block is a more precise reading anchor than its whole row. */
    rowId?: string;
    rowContentTop?: number;
};

export type ForwardScrollSnapshot = {
    scrollTop: number;
    scrollHeight: number;
    viewportHeight: number;
    followingLatest: boolean;
    anchors: Array<{ id: string; contentTop: number; rowId?: string; rowContentTop?: number }>;
};

export function captureForwardScrollSnapshot(
    scrollTop: number,
    scrollHeight: number,
    viewportHeight: number,
    rows: readonly ForwardScrollRow[],
    followingLatest: boolean,
): ForwardScrollSnapshot {
    // Keep the first partially visible row: its negative visual top preserves
    // the reading position inside a message taller than the entire viewport.
    const visible = rows.filter((row) => row.height > 0
        && row.contentTop + row.height > scrollTop
        && row.contentTop < scrollTop + viewportHeight);
    const blocks = visible.filter((row) => row.rowId !== undefined).slice(0, 3);
    const wholeRows = visible.filter((row) => row.rowId === undefined).slice(0, 4);
    return {
        scrollTop,
        scrollHeight,
        viewportHeight,
        followingLatest,
        anchors: [...blocks, ...wholeRows].map(({ id, contentTop, rowId, rowContentTop }) => ({
            id, contentTop, ...(rowId === undefined ? {} : { rowId, rowContentTop }),
        })),
    };
}

/**
 * A single layout transaction has at most one correction. Compare content
 * positions, not visual positions, so real scrolling between measurements is
 * preserved. No height-based guess is made when every captured row disappeared.
 */
export function forwardScrollCorrection(
    previous: ForwardScrollSnapshot,
    current: {
        scrollTop: number;
        scrollHeight: number;
        viewportHeight: number;
        rows: readonly ForwardScrollRow[];
    },
): number | null {
    let anchorDelta: number | null = null;
    for (const anchor of previous.anchors) {
        const row = current.rows.find((candidate) => candidate.id === anchor.id);
        if (row) {
            anchorDelta = row.contentTop - anchor.contentTop;
            break;
        }
    }
    const layoutChanged = Math.abs(current.scrollHeight - previous.scrollHeight) > 0.5
        || Math.abs(current.viewportHeight - previous.viewportHeight) > 0.5
        || (anchorDelta !== null && Math.abs(anchorDelta) > 0.5);
    if (!layoutChanged) return null;

    const maximum = Math.max(0, current.scrollHeight - current.viewportHeight);
    const desired = previous.followingLatest
        ? maximum
        : anchorDelta === null ? current.scrollTop : current.scrollTop + anchorDelta;
    const target = Math.max(0, Math.min(maximum, desired));
    // An unchanged layout must never interfere with Safari's rubber banding.
    if (!previous.followingLatest && (anchorDelta === null || Math.abs(anchorDelta) <= 0.5)) return null;
    return Math.abs(target - current.scrollTop) > 0.5 ? target : null;
}
