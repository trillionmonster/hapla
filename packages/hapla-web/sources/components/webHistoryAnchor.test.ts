import { describe, expect, it } from 'vitest';
import {
    advanceWebHistoryAnchor,
    rankWebHistoryAnchors,
    webHistoryAnchorCorrection,
    type WebHistoryAnchorSnapshot,
} from './webHistoryAnchor';

describe('web older-history visual anchor', () => {
    it('selects a visible message near the viewport center and ignores clipped candidates', () => {
        expect(rankWebHistoryAnchors(100, 700, [
            { id: 'above', top: 0, bottom: 80 },
            { id: 'top', top: 80, bottom: 260 },
            { id: 'center', top: 320, bottom: 520 },
            { id: 'huge-partial', top: -500, bottom: 1_200 },
            { id: 'below', top: 720, bottom: 900 },
        ]).map((candidate) => candidate.id)).toEqual(['center', 'top', 'huge-partial']);
    });

    it('prefers a fully visible message over one spanning the viewport', () => {
        expect(rankWebHistoryAnchors(100, 700, [
            { id: 'spanning', top: -500, bottom: 1_300 },
            { id: 'stable', top: 260, bottom: 420 },
        ])[0]?.id).toBe('stable');
    });

    it('subtracts real inverted scrolling and compensates only layout movement', () => {
        const captured: WebHistoryAnchorSnapshot = {
            messageId: 'message',
            viewportTop: 220,
            scrollOffset: 400,
        };
        // A gesture moves both scrollTop and the item down by 75px: no correction.
        expect(webHistoryAnchorCorrection(captured, 295, 475)).toBe(0);
        // The same gesture plus a 180px upward layout jump restores exactly 180px.
        expect(webHistoryAnchorCorrection(captured, 115, 475)).toBe(180);
    });

    it('corrects pure layout displacement and never rolls back without a DOM anchor', () => {
        const anchored: WebHistoryAnchorSnapshot = {
            messageId: 'message',
            viewportTop: 295,
            scrollOffset: 475,
        };
        expect(webHistoryAnchorCorrection(anchored, 415, 475)).toBe(-120);
        expect(webHistoryAnchorCorrection({ ...anchored, viewportTop: null }, null, 620)).toBe(0);
    });

    it('carries a correction target across a clamped or delayed scroll write', () => {
        const anchored: WebHistoryAnchorSnapshot = {
            messageId: 'message',
            viewportTop: 220,
            scrollOffset: 400,
        };
        // Gesture +75, layout -180 => requested correction +180. Only 40px of
        // offset is currently available, so keep the 295px visual target.
        const advanced = advanceWebHistoryAnchor(anchored, 115, 475, 515);
        expect(advanced).toEqual({
            messageId: 'message',
            viewportTop: 295,
            scrollOffset: 515,
        });
        // If the DOM only moved by the applied 40px, the next frame retains the
        // remaining 140px correction instead of accepting a permanent jump.
        expect(webHistoryAnchorCorrection(advanced, 155, 515)).toBe(140);
    });
});
