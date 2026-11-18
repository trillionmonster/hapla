import { describe, expect, it, vi } from 'vitest';
import { runCodexStartup } from './startupReadiness';

describe('Codex startup readiness', () => {
    it('waits for provider connection and thread resume before acknowledging the worker', async () => {
        const events: string[] = [];
        let finishResume!: () => void;
        const startup = runCodexStartup({
            initialize: async () => {
                events.push('connected');
                await new Promise<void>(resolve => { finishResume = resolve; });
                events.push('resumed');
            },
            acknowledge: async () => { events.push('acknowledged'); },
            reportFailure: vi.fn(),
        });
        await Promise.resolve();
        expect(events).toEqual(['connected']);
        finishResume();
        await startup;
        expect(events).toEqual(['connected', 'resumed', 'acknowledged']);
    });

    it('never acknowledges an active-writer resume failure and reports the exact cause', async () => {
        const error = new Error('thread/resume: thread existing already has an active writer (code=-32600)');
        const acknowledge = vi.fn();
        const reportFailure = vi.fn();
        await expect(runCodexStartup({ initialize: async () => { throw error; }, acknowledge, reportFailure })).rejects.toBe(error);
        expect(acknowledge).not.toHaveBeenCalled();
        expect(reportFailure).toHaveBeenCalledExactlyOnceWith(error);
    });

    it('reports a rejected daemon readiness receipt without hiding the original error', async () => {
        const error = new Error('Daemon readiness acknowledgement failed: ownership mismatch');
        const reportFailure = vi.fn(() => { throw new Error('logging failed'); });
        await expect(runCodexStartup({ initialize: async () => {}, acknowledge: async () => { throw error; }, reportFailure })).rejects.toBe(error);
        expect(reportFailure).toHaveBeenCalledExactlyOnceWith(error);
    });
});
