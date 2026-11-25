import { describe, it, expect } from 'vitest';
import { contextRemaining, activeContextUsage } from './contextUsage';
describe('runtime context capacity', () => {
    it('does not reuse another model or thread capacity', () => {
        const value = { usedTokens: 100, contextWindow: 1000, model: 'a', threadId: 'thread-a' };
        expect(activeContextUsage(value, 'default', 'thread-a')).toBe(value);
        expect(activeContextUsage(value, 'b', 'thread-a')).toBeNull();
        expect(activeContextUsage(value, 'a', 'thread-b')).toBeNull();
    });
    it('uses each runtime capacity and leaves unavailable capacities unknown', () => {
        expect(contextRemaining(100_000, 200_000)).toBe(50);
        expect(contextRemaining(100_000, 1_000_000)).toBe(90);
        expect(contextRemaining(210_000, 200_000)).toBe(0);
        expect(contextRemaining(100_000, null)).toBeNull();
        expect(contextRemaining(100_000, 0)).toBeNull();
        expect(contextRemaining(NaN, 100_000)).toBeNull();
    });
});
