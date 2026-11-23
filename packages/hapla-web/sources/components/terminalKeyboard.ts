type TerminalKeyboard = {
    hasSelection(): boolean;
    getSelection(): string;
    paste(text: string): void;
};

/** Clipboard shortcuts belong to the browser; shell control keys belong to PTY. */
export function terminalKeyHandler(terminal: TerminalKeyboard, clipboard: Pick<Clipboard, 'readText' | 'writeText'> | undefined) {
    return (event: KeyboardEvent): boolean => {
        if (event.type !== 'keydown') return true;
        const key = event.key.toLowerCase();
        const paste = !event.altKey && ((event.ctrlKey && key === 'v') || (event.metaKey && key === 'v') || (event.shiftKey && key === 'insert'));
        const copy = !event.altKey && key === 'c' && ((event.ctrlKey && event.shiftKey) || event.metaKey);
        if (paste) {
            // Let the trusted browser paste event supply clipboard data. This
            // also works on plain HTTP, where navigator.clipboard is absent.
            event.stopPropagation();
            return false;
        }
        if (copy) {
            if (terminal.hasSelection() && clipboard?.writeText) {
                event.preventDefault(); event.stopPropagation();
                void clipboard.writeText(terminal.getSelection()).catch(() => undefined);
            }
            return false;
        }
        // Prevent Hapla's global Ctrl+K handler, while xterm still encodes it.
        if (event.ctrlKey || event.altKey || event.metaKey) event.stopPropagation();
        return true;
    };
}
