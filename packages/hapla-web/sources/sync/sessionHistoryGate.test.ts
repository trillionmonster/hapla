import { describe, expect, it } from 'vitest';
import { isNearOlderHistoryEdge, SessionHistoryGate } from './sessionHistoryGate';

describe('history page user intent', () => {
    it('serializes measured viewport fills with physical gestures without leaving them armed', () => {
        const gate = new SessionHistoryGate();
        expect(gate.takeAutomatic()).toBe(true);
        gate.beginGesture();
        gate.userScrolledTowardHistory();
        expect(gate.take()).toBe(false);
        expect(gate.takeAutomatic()).toBe(false);
        gate.complete();
        expect(gate.take()).toBe(false);
        expect(gate.takeAutomatic()).toBe(true);
        gate.complete();
        gate.beginGesture();
        gate.userScrolledTowardHistory();
        expect(gate.take()).toBe(true);
    });
    it('detects the older edge from inverted-list scroll metrics', () => {
        expect(isNearOlderHistoryEdge({ offset: 0, viewport: 700, content: 2_000 })).toBe(false);
        expect(isNearOlderHistoryEdge({ offset: 1_050, viewport: 700, content: 2_000 })).toBe(true);
        expect(isNearOlderHistoryEdge({ offset: 1_060, viewport: 700, content: 2_000 }, 200)).toBe(false);
        expect(isNearOlderHistoryEdge({ offset: 0, viewport: 0, content: 0 })).toBe(false);
    });

    it('allows one initial viewport fill and prevents layout-driven cascades through 100k history', () => {
        const gate = new SessionHistoryGate();
        expect(gate.take()).toBe(true);
        gate.complete();
        for (let page = 0; page < 1250; page++) expect(gate.take()).toBe(false);
        gate.beginGesture();
        gate.userScrolledTowardHistory();
        expect(gate.take()).toBe(true);
    });

    it('charges an automatic fill to a gesture that has already started', () => {
        const gate = new SessionHistoryGate();
        gate.beginGesture();
        expect(gate.take()).toBe(true);
        gate.complete();
        gate.userScrolledTowardHistory();
        expect(gate.take()).toBe(false);
        gate.beginGesture();
        gate.userScrolledTowardHistory();
        expect(gate.take()).toBe(true);
    });

    it('allows at most one page for the same gesture and inertia', () => {
        const gate = new SessionHistoryGate();
        gate.beginGesture();
        gate.userScrolledTowardHistory();
        expect(gate.take()).toBe(true);
        gate.userScrolledTowardHistory();
        expect(gate.take()).toBe(false);
        gate.complete();
        gate.userScrolledTowardHistory();
        expect(gate.take()).toBe(false);
        gate.beginGesture();
        gate.userScrolledTowardHistory();
        expect(gate.take()).toBe(true);
    });

    it('does not let a gesture that starts while pending unlock another page', () => {
        const gate = new SessionHistoryGate();
        gate.beginGesture();
        gate.userScrolledTowardHistory();
        expect(gate.take()).toBe(true);
        gate.beginGesture();
        gate.complete();
        gate.userScrolledTowardHistory();
        expect(gate.take()).toBe(false);
        gate.beginGesture();
        gate.userScrolledTowardHistory();
        expect(gate.take()).toBe(true);
    });

    it('does not retain stale intent after a gesture ends away from the edge', () => {
        const gate = new SessionHistoryGate();
        expect(gate.take()).toBe(true);
        gate.complete();
        gate.beginGesture();
        gate.userScrolledTowardHistory();
        gate.endGesture();
        expect(gate.take()).toBe(false);
    });
});
