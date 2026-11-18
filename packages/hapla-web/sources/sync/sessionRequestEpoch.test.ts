import { describe, expect, it } from 'vitest';
import { SessionRequestEpochs } from './sessionRequestEpoch';

describe('session request epochs', () => {
    it('rejects a delayed page after a newer window request while preserving another session request', async () => {
        const epochs = new SessionRequestEpochs();
        const currentA = epochs.capture('a');
        const currentB = epochs.capture('b');
        let release!: () => void;
        const waiting = new Promise<void>((resolve) => { release = resolve; });
        const committed: string[] = [];
        const oldPage = waiting.then(() => { if (currentA()) committed.push('old page'); });
        epochs.invalidate('a');
        if (epochs.capture('a')()) committed.push('latest page');
        release();
        await oldPage;
        expect(committed).toEqual(['latest page']);
        expect(currentB()).toBe(true);
    });

    it('invalidates pending decryption when a session is deleted and recreated', () => {
        const epochs = new SessionRequestEpochs();
        const pending = epochs.capture('session');
        epochs.invalidate('session');
        expect(pending()).toBe(false);
        expect(epochs.capture('session')()).toBe(true);
    });

    it('rejects deleted sessions discovered by an already pending session-list request', () => {
        const epochs = new SessionRequestEpochs();
        const isCurrent = epochs.snapshot();
        epochs.invalidate('deleted');
        expect(isCurrent('deleted')).toBe(false);
        expect(isCurrent('retained')).toBe(true);
    });
});
