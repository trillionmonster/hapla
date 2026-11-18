import type { Message } from '@/sync/typesMessage';

export const MAX_INPUT_HISTORY = 50;

/**
 * Returns recent, non-empty user inputs with the newest entry first.
 * Consecutive duplicates are collapsed so holding ArrowUp remains useful.
 */
export function buildInputHistory(
    messages: readonly Message[],
    limit: number = MAX_INPUT_HISTORY,
): string[] {
    const history: string[] = [];

    for (let index = messages.length - 1; index >= 0 && history.length < limit; index -= 1) {
        const message = messages[index];
        if (message.kind !== 'user-text' || !message.text.trim()) {
            continue;
        }
        if (history[history.length - 1] !== message.text) {
            history.push(message.text);
        }
    }

    return history;
}

export function canNavigateInputHistory(
    direction: 'up' | 'down',
    text: string,
    selection: { start: number; end: number },
): boolean {
    if (selection.start !== selection.end) {
        return false;
    }

    if (direction === 'up') {
        const firstNewline = text.indexOf('\n');
        return firstNewline === -1 || selection.start <= firstNewline;
    }

    const lastNewline = text.lastIndexOf('\n');
    return lastNewline === -1 || selection.end > lastNewline;
}
