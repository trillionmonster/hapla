/** A software keyboard's Return key always means a newline. */
export function composerUsesTouchKeyboard(): boolean {
    if (typeof window === 'undefined') return false;
    return window.innerWidth <= 700
        || (typeof navigator !== 'undefined' && navigator.maxTouchPoints > 0)
        || (typeof window.matchMedia === 'function' && window.matchMedia('(any-pointer: coarse)').matches);
}
