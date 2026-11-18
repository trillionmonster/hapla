import { describe, expect, it, vi } from 'vitest';
import { CodexCommandTermination } from './codexCommandTermination';

const item = { type: 'commandExecution', id: 'owned-item', processId: 'native-17', status: 'inProgress' };
const terminal = { itemId: 'owned-item', processId: 'native-17', command: 'work', cwd: '/work', osPid: 271007 };

describe('native Codex command termination', () => {
    it('releases only never-granted approvals without any evidence that the command started', () => {
        const tracker = new CodexCommandTermination();
        for (const id of ['unapproved', 'unknown', 'approved', 'output', 'process']) {
            tracker.observe('thread-a', 'turn-a', { ...item, id, processId: id === 'process' ? 'native-running' : null }, false);
            if (id !== 'unknown') tracker.observeApproval('thread-a', 'turn-a', id, 'pending');
        }
        tracker.observeApproval('thread-a', 'turn-a', 'approved', 'granted');
        tracker.observeApproval('thread-a', 'turn-a', 'approved', 'pending'); // Later approval cannot undo prior permission.
        tracker.observeOutput('thread-a', 'turn-a', 'output');
        tracker.observe('thread-a', 'other-turn', { ...item, id: 'unapproved', processId: null }, false);
        tracker.observeApproval('thread-a', 'other-turn', 'unapproved', 'pending');
        expect(tracker.takeUnstartedApprovals('thread-a', 'turn-a').map(command => command.itemId)).toEqual(['unapproved']);
        expect(tracker.pending('thread-a', 'turn-a').map(command => command.itemId)).toEqual(['unknown', 'approved', 'output', 'process']);
        expect(tracker.pending('thread-a', 'other-turn')).toHaveLength(1);
    });
    it('paginates and terminates only the exact native command, then waits for disappearance', async () => {
        const tracker = new CodexCommandTermination();
        tracker.observe('thread-a', 'turn-a', item, false);
        tracker.observe('thread-a', 'other-turn', { ...item, id: 'unrelated' }, false);
        let live = true;
        let acknowledged = false;
        const calls: Array<{ method: string; params: any }> = [];
        const transport = {
            assertCurrent() {},
            async request<T>(method: string, params: any): Promise<T> {
                calls.push({ method, params });
                if (method === 'thread/backgroundTerminals/terminate') {
                    acknowledged = true;
                    return { terminated: true } as T;
                }
                if (!params.cursor) return { data: [{ ...terminal, itemId: 'unrelated', processId: 'other-process' }], nextCursor: 'page-two' } as T;
                return { data: live ? [terminal] : [], nextCursor: null } as T;
            },
        };
        await tracker.capture('thread-a', 'turn-a', transport);
        let settled = false;
        const cleanup = tracker.terminate('thread-a', 'turn-a', transport, 1_000).then(() => { settled = true; });
        await vi.waitFor(() => expect(acknowledged).toBe(true));
        expect(settled).toBe(false);
        expect(calls.filter((call) => call.method.endsWith('/terminate'))).toEqual([
            { method: 'thread/backgroundTerminals/terminate', params: { threadId: 'thread-a', processId: 'native-17' } },
        ]);
        live = false;
        await cleanup;
        expect(tracker.pending('thread-a', 'turn-a')).toEqual([]);
        expect(tracker.pending('thread-a', 'other-turn')).toHaveLength(1);
    });

    it('does not treat a command never present in the list as stopped or target a reused process', async () => {
        const tracker = new CodexCommandTermination();
        tracker.observe('thread-a', 'turn-a', item, false);
        const request = vi.fn(async (_method: string, _params: unknown) => ({ data: [{ ...terminal, processId: 'different-process' }], nextCursor: null }));
        const transport = { assertCurrent() {}, request: request as any };
        await expect(tracker.terminate('thread-a', 'turn-a', transport, 20)).rejects.toThrow('not confirmed');
        expect(request.mock.calls.every(([method]) => method === 'thread/backgroundTerminals/list')).toBe(true);
        expect(tracker.pending('thread-a', 'turn-a')).toHaveLength(1);
    });

    it('stops before issuing terminate when the runtime changes during a list request', async () => {
        const tracker = new CodexCommandTermination();
        tracker.observe('thread-a', 'turn-a', item, false);
        let current = true;
        const calls: string[] = [];
        const transport = {
            assertCurrent() { if (!current) throw new Error('old epoch'); },
            async request<T>(method: string): Promise<T> {
                calls.push(method);
                current = false;
                return { data: [terminal], nextCursor: null } as T;
            },
        };
        await expect(tracker.terminate('thread-a', 'turn-a', transport, 500)).rejects.toThrow('old epoch');
        expect(calls).toEqual(['thread/backgroundTerminals/list']);
    });

    it('accepts an actual command terminal without fabricating a process termination', async () => {
        const tracker = new CodexCommandTermination();
        tracker.observe('thread-a', 'turn-a', item, false);
        tracker.observe('thread-a', 'turn-a', { ...item, status: 'failed', exitCode: 130 }, true);
        const request = vi.fn();
        await tracker.terminate('thread-a', 'turn-a', { assertCurrent() {}, request }, 50);
        expect(request).not.toHaveBeenCalled();
    });
});
