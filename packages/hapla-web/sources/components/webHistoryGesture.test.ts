import { describe, expect, it } from 'vitest';
import { WebHistoryGestureTracker } from './webHistoryGesture';

describe('WebHistoryGestureTracker', () => {
    it('keeps one wheel generation open until the quiet timer finishes it', () => {
        const tracker = new WebHistoryGestureTracker();
        expect(tracker.beginWheel()).toBe(true);
        expect(tracker.beginWheel()).toBe(false);
        expect(tracker.beginWheel()).toBe(false);
        tracker.finish();
        expect(tracker.beginWheel()).toBe(true);
    });

    it('does not start a new generation when another finger is added', () => {
        const tracker = new WebHistoryGestureTracker();
        expect(tracker.beginTouch(1)).toBe(true);
        expect(tracker.hasActiveTouch()).toBe(true);
        expect(tracker.beginTouch(2)).toBe(false);
        expect(tracker.updateTouch(1)).toBe(false);
        expect(tracker.hasActiveTouch()).toBe(true);
        expect(tracker.updateTouch(0)).toBe(true);
        expect(tracker.hasActiveTouch()).toBe(false);
    });

    it('opens a new generation when contact resumes after every finger left', () => {
        const tracker = new WebHistoryGestureTracker();
        expect(tracker.beginTouch(1)).toBe(true);
        expect(tracker.updateTouch(0)).toBe(true);
        expect(tracker.beginTouch(1)).toBe(true);
    });

    it('lets a touch supersede an unfinished wheel tail', () => {
        const tracker = new WebHistoryGestureTracker();
        expect(tracker.beginWheel()).toBe(true);
        expect(tracker.beginTouch(1)).toBe(true);
        expect(tracker.beginWheel()).toBe(false);
        expect(tracker.updateTouch(0)).toBe(true);
        expect(tracker.beginWheel()).toBe(true);
    });
});
