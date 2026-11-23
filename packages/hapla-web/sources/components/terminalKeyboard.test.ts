import { describe, expect, it, vi } from 'vitest';
import { terminalKeyHandler } from './terminalKeyboard';

function key(value: string, options: Record<string, boolean> = {}) { return { type: 'keydown', key: value, ctrlKey: false, shiftKey: false, metaKey: false, altKey: false, preventDefault: vi.fn(), stopPropagation: vi.fn(), ...options } as unknown as KeyboardEvent; }
describe('browser terminal shortcuts', () => {
    it('lets native paste handle Ctrl+V on HTTP without transmitting literal-next to the shell', () => {
        const event = key('v', { ctrlKey: true });
        const terminal = { hasSelection: () => false, getSelection: () => '', paste: vi.fn() };
        expect(terminalKeyHandler(terminal, undefined)(event)).toBe(false);
        expect(event.preventDefault).not.toHaveBeenCalled(); expect(terminal.paste).not.toHaveBeenCalled();
        expect(terminalKeyHandler(terminal, undefined)(key('v', { ctrlKey: true, shiftKey: true }))).toBe(false);
    });
    it('retains shell Ctrl+C/D/K and copies only through the explicit clipboard shortcut', () => {
        const clipboard = { readText: vi.fn(), writeText: vi.fn().mockResolvedValue(undefined) };
        const handler = terminalKeyHandler({ hasSelection: () => true, getSelection: () => 'output', paste: vi.fn() }, clipboard);
        for (const name of ['c', 'd', 'a', 'e', 'k', 'u', 'r']) { const event = key(name, { ctrlKey: true }); expect(handler(event)).toBe(true); expect(event.stopPropagation).toHaveBeenCalled(); expect(event.preventDefault).not.toHaveBeenCalled(); }
        expect(handler(key('c', { ctrlKey: true, shiftKey: true }))).toBe(false);
        expect(clipboard.writeText).toHaveBeenCalledWith('output');
    });
});
