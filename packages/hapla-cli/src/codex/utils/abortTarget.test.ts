import { describe, expect, it } from 'vitest';
import { assertCodexAbortTarget } from './abortTarget';

describe('assertCodexAbortTarget', () => {
    const current = { epoch: 'epoch-b', threadId: 'thread-b', turnId: 'turn-b' };
    it('accepts the current captured target and internal stop calls', () => {
        expect(() => assertCodexAbortTarget({ ...current, requestId: 'request-b' }, current)).not.toThrow();
        expect(() => assertCodexAbortTarget(undefined, current)).not.toThrow();
        expect(() => assertCodexAbortTarget({}, current)).not.toThrow();
    });
    it.each(['epoch', 'threadId', 'turnId'])('rejects a stale %s before an interrupt can affect another turn', (key) => {
        expect(() => assertCodexAbortTarget({ ...current, requestId: 'request-a', [key]: 'old' }, current)).toThrow('previous Codex');
    });
    it('rejects incomplete correlation and requests for an already completed turn', () => {
        expect(() => assertCodexAbortTarget({ turnId: 'turn-b' }, current)).toThrow();
        expect(() => assertCodexAbortTarget({ ...current, requestId: 'request-b' }, { ...current, turnId: null })).toThrow();
    });

    it('allows a pending start only with its exact start id and rejects a later start', () => {
        const starting = { ...current, turn: 'starting', turnId: null, startId: 'start-b' };
        expect(() => assertCodexAbortTarget({ ...starting, requestId: 'request-b' }, starting)).not.toThrow();
        expect(() => assertCodexAbortTarget({ ...starting, startId: 'start-a', requestId: 'request-a' }, starting)).toThrow();
        expect(() => assertCodexAbortTarget({ ...starting, requestId: 'request-b' }, { ...starting, turn: 'completed' })).toThrow();
    });
});
