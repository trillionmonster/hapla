import { describe, expect, it } from 'vitest';
import type { Message } from '@/sync/typesMessage';
import { buildInputHistory, canNavigateInputHistory } from './inputHistory';

const userMessage = (id: string, text: string): Message => ({
    kind: 'user-text',
    id,
    localId: null,
    createdAt: Number(id),
    text,
});

describe('buildInputHistory', () => {
    it('returns newest user inputs first and ignores empty input', () => {
        const messages: Message[] = [
            userMessage('1', 'first'),
            { kind: 'agent-text', id: '2', localId: null, createdAt: 2, text: 'answer' },
            userMessage('3', '   '),
            userMessage('4', 'latest'),
        ];

        expect(buildInputHistory(messages)).toEqual(['latest', 'first']);
    });

    it('collapses consecutive duplicates and respects the limit', () => {
        const messages = [
            userMessage('1', 'old'),
            userMessage('2', 'same'),
            userMessage('3', 'same'),
            userMessage('4', 'new'),
        ];

        expect(buildInputHistory(messages, 2)).toEqual(['new', 'same']);
    });
});

describe('canNavigateInputHistory', () => {
    it('allows single-line shell-style navigation from any caret position', () => {
        expect(canNavigateInputHistory('up', 'hello', { start: 3, end: 3 })).toBe(true);
        expect(canNavigateInputHistory('down', 'hello', { start: 3, end: 3 })).toBe(true);
    });

    it('only intercepts arrows on the boundary lines of multiline input', () => {
        const text = 'first\nmiddle\nlast';
        expect(canNavigateInputHistory('up', text, { start: 8, end: 8 })).toBe(false);
        expect(canNavigateInputHistory('up', text, { start: 3, end: 3 })).toBe(true);
        expect(canNavigateInputHistory('down', text, { start: 8, end: 8 })).toBe(false);
        expect(canNavigateInputHistory('down', text, { start: 15, end: 15 })).toBe(true);
    });
});
