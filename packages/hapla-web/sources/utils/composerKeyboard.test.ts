import { afterEach, describe, expect, it, vi } from 'vitest';
import { composerUsesTouchKeyboard } from './composerKeyboard';
afterEach(() => vi.unstubAllGlobals());
describe('newline on software keyboards', () => {
    it('keeps phone Return as newline when a browser reports its primary pointer as fine', () => {
        vi.stubGlobal('window', { innerWidth: 390, matchMedia: () => ({ matches: false }) });
        vi.stubGlobal('navigator', { maxTouchPoints: 0 });
        expect(composerUsesTouchKeyboard()).toBe(true);
    });
    it('keeps tablet Return as newline with an attached fine pointer', () => {
        vi.stubGlobal('window', { innerWidth: 1024, matchMedia: () => ({ matches: false }) });
        vi.stubGlobal('navigator', { maxTouchPoints: 5 });
        expect(composerUsesTouchKeyboard()).toBe(true);
    });
    it('preserves the desktop Enter setting for physical keyboard users', () => {
        vi.stubGlobal('window', { innerWidth: 1440, matchMedia: () => ({ matches: false }) });
        vi.stubGlobal('navigator', { maxTouchPoints: 0 });
        expect(composerUsesTouchKeyboard()).toBe(false);
    });
});
