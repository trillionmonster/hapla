import { afterEach, describe, expect, it, vi } from 'vitest';
import { resetFavicon, updateFaviconWithNotification } from './faviconGenerator';

function documentFixture(initialHref?: string) {
    const attributes = new Map<string, string>();
    if (initialHref) attributes.set('href', initialHref);
    const changeHref = vi.fn((value: string) => attributes.set('href', value));
    const icon = {
        rel: 'icon',
        type: 'image/x-icon',
        set href(value: string) { changeHref(value); },
        getAttribute: (name: string) => attributes.get(name) ?? null,
        setAttribute: (name: string, value: string) => attributes.set(name, value),
    };
    let attached = initialHref !== undefined;
    const appendChild = vi.fn(() => { attached = true; });
    vi.stubGlobal('document', {
        querySelector: () => attached ? icon : null,
        createElement: () => icon,
        head: { appendChild },
    });
    return { attributes, icon, changeHref, appendChild };
}

afterEach(() => vi.unstubAllGlobals());

describe('brand favicon state', () => {
    it('replaces a cached legacy H with the new brand and correct image type', () => {
        const { attributes, icon, changeHref } = documentFixture('/favicon.ico?t=old');
        resetFavicon();
        expect(attributes.get('href')).toBe('/brand/hapla-favicon-v1.svg');
        expect(icon.type).toBe('image/svg+xml');
        expect(attributes.get('sizes')).toBe('any');
        expect(changeHref).toHaveBeenCalledTimes(1);
    });

    it('changes only on permission state transitions so reconciliations do not blink', () => {
        const { attributes, changeHref } = documentFixture('/brand/hapla-favicon-v1.svg');
        resetFavicon();
        resetFavicon();
        expect(changeHref).not.toHaveBeenCalled();
        updateFaviconWithNotification();
        updateFaviconWithNotification();
        expect(attributes.get('href')).toBe('/brand/hapla-favicon-active-v1.svg');
        expect(changeHref).toHaveBeenCalledTimes(1);
        resetFavicon();
        resetFavicon();
        expect(attributes.get('href')).toBe('/brand/hapla-favicon-v1.svg');
        expect(changeHref).toHaveBeenCalledTimes(2);
    });

    it('adds a single icon when a document has none', () => {
        const { attributes, appendChild } = documentFixture();
        updateFaviconWithNotification();
        updateFaviconWithNotification();
        expect(appendChild).toHaveBeenCalledTimes(1);
        expect(attributes.get('href')).toBe('/brand/hapla-favicon-active-v1.svg');
    });

    it('supports non-browser imports', () => {
        vi.stubGlobal('document', undefined);
        expect(() => { resetFavicon(); updateFaviconWithNotification(); }).not.toThrow();
    });
});
