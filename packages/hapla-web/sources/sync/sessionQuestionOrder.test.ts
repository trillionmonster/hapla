import { describe, expect, it } from 'vitest';
import { visibleSessionsByQuestion } from './sessionQuestionOrder';

describe('visible folder question order', () => {
    const online = { id: 'online', createdAt: 20, lastUserMessageAt: 100 };
    const offline = { id: 'offline', createdAt: 10, lastUserMessageAt: 200 };
    it('mixes expanded offline rows by question time without online priority', () => {
        const group = { onlineSessions: [online], offlineSessions: [offline] };
        expect(visibleSessionsByQuestion(group, true).map(row => row.id)).toEqual(['offline', 'online']);
        expect(visibleSessionsByQuestion(group, false).map(row => row.id)).toEqual(['online']);
    });
    it('keeps order when presence changes while offline rows are expanded', () => {
        expect(visibleSessionsByQuestion({ onlineSessions: [online, offline], offlineSessions: [] }, true).map(row => row.id)).toEqual(['offline', 'online']);
    });
    it('preserves stable conversation identity for equal timestamps', () => {
        const left = { id: 'new-runtime', questionOrderId: 'a', lastUserMessageAt: 100 };
        const right = { id: 'old-runtime', questionOrderId: 'b', lastUserMessageAt: 100 };
        expect(visibleSessionsByQuestion({ onlineSessions: [right], offlineSessions: [left] }, true)).toEqual([left, right]);
    });
});
