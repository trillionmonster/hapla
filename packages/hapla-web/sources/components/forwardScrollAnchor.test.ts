import { describe, expect, it } from 'vitest';
import { captureForwardScrollSnapshot, forwardScrollCorrection } from './forwardScrollAnchor';

describe('forward DOM scroll anchoring', () => {
    it('anchors a paragraph when an image above it expands inside the same long message', () => {
        const before = captureForwardScrollSnapshot(1000, 3000, 600, [
            { id: 'long', contentTop: 100, height: 2200 },
            { id: 'paragraph-5', contentTop: 950, height: 250, rowId: 'long', rowContentTop: 100 },
            { id: 'paragraph-6', contentTop: 1200, height: 300, rowId: 'long', rowContentTop: 100 },
        ], false);
        expect(before.anchors[0].id).toBe('paragraph-5');
        expect(before.anchors.at(-1)?.id).toBe('long');
        expect(forwardScrollCorrection(before, {
            scrollTop: 1000, scrollHeight: 3240, viewportHeight: 600,
            rows: [
                { id: 'long', contentTop: 100, height: 2440 },
                { id: 'paragraph-5', contentTop: 1190, height: 250, rowId: 'long', rowContentTop: 100 },
            ],
        })).toBe(1240);
    });

    it('preserves a reading position deep inside a tall message after history is prepended', () => {
        const before = captureForwardScrollSnapshot(1600, 4000, 600,
            [{ id: 'long', contentTop: 800, height: 2400 }], false);
        expect(before.anchors).toEqual([{ id: 'long', contentTop: 800 }]);
        expect(forwardScrollCorrection(before, {
            scrollTop: 1600, scrollHeight: 4500, viewportHeight: 600,
            rows: [{ id: 'long', contentTop: 1300, height: 2400 }],
        })).toBe(2100);
        // The same paragraph remains 800px inside the message.
        expect(2100 - 1300).toBe(1600 - 800);
    });

    it('preserves physical movement between the old and new layouts', () => {
        const before = captureForwardScrollSnapshot(800, 2500, 600,
            [{ id: 'row', contentTop: 700, height: 800 }], false);
        expect(forwardScrollCorrection(before, {
            scrollTop: 740, scrollHeight: 2620, viewportHeight: 600,
            rows: [{ id: 'row', contentTop: 820, height: 800 }],
        })).toBe(860);
    });

    it('falls back to another visible row if Normal filtering removes the first anchor', () => {
        const before = captureForwardScrollSnapshot(100, 2000, 600, [
            { id: 'tool', contentTop: 0, height: 200 },
            { id: 'answer', contentTop: 200, height: 500 },
        ], false);
        expect(forwardScrollCorrection(before, {
            scrollTop: 100, scrollHeight: 1800, viewportHeight: 600,
            rows: [{ id: 'answer', contentTop: 0, height: 500 }],
        })).toBe(0);
    });

    it('never guesses from total height when every old visible message disappeared', () => {
        const before = captureForwardScrollSnapshot(500, 2000, 600,
            [{ id: 'old', contentTop: 400, height: 800 }], false);
        expect(forwardScrollCorrection(before, {
            scrollTop: 500, scrollHeight: 2300, viewportHeight: 600,
            rows: [{ id: 'other', contentTop: 700, height: 800 }],
        })).toBeNull();
    });

    it('does not move a reader when a message below them grows', () => {
        const before = captureForwardScrollSnapshot(500, 2000, 600,
            [{ id: 'reading', contentTop: 400, height: 800 }], false);
        expect(forwardScrollCorrection(before, {
            scrollTop: 500, scrollHeight: 3000, viewportHeight: 600,
            rows: [{ id: 'reading', contentTop: 400, height: 800 }],
        })).toBeNull();
    });

    it('only follows the bottom when explicitly enabled, including viewport shrink', () => {
        const before = captureForwardScrollSnapshot(1400, 2000, 600,
            [{ id: 'last', contentTop: 1200, height: 800 }], true);
        const after = { scrollTop: 1400, scrollHeight: 2100, viewportHeight: 400,
            rows: [{ id: 'last', contentTop: 1200, height: 900 }] };
        expect(forwardScrollCorrection(before, after)).toBe(1700);
        expect(forwardScrollCorrection({ ...before, followingLatest: false }, after)).toBeNull();
    });

    it('does not touch scrollTop during scrolling or Safari overscroll without a layout change', () => {
        const before = captureForwardScrollSnapshot(0, 2000, 600,
            [{ id: 'first', contentTop: 0, height: 800 }], false);
        for (const scrollTop of [-90, 0, 200, 1500]) {
            expect(forwardScrollCorrection(before, {
                scrollTop, scrollHeight: 2000, viewportHeight: 600,
                rows: [{ id: 'first', contentTop: 0, height: 800 }],
            })).toBeNull();
        }
    });
});
