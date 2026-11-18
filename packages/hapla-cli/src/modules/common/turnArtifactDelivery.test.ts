import { describe, expect, it, vi } from 'vitest';
import { TurnArtifactDelivery, isCompletedArtifactStep, type ArtifactStep } from './turnArtifactDelivery';
import type { TurnMediaCandidate } from './turnMediaArtifacts';
import { ArtifactDeliveryLedger } from './artifactDeliveryLedger';

const step = (sourceId: string): ArtifactStep => ({ turnId: 'turn', branchId: 'branch', sourceId, time: 123, batchId: `batch:${sourceId}` });
const file = (name: string, version = '1'): TurnMediaCandidate => ({ path: `/work/${name}.mp4`, size: 10, mimeType: 'video/mp4', version });
const waitFor = async (check: () => boolean) => { for (let n = 0; n < 100; n++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 2)); } throw new Error('Condition did not settle'); };

describe('TurnArtifactDelivery', () => {
    it.each(['next completed step', 'connection recovery'])('retains all 30 discovered files across a drain deadline and retries on %s without duplicate outbox items', async trigger => {
        const files = Array.from({ length: 30 }, (_, index) => file(String(index)));
        const ledger = new ArtifactDeliveryLedger({ onError: vi.fn() });
        let online = false;let acknowledge!: () => void;
        const disconnectedReceipt = new Promise<void>(resolve => { acknowledge = resolve; });
        const enqueued: Array<{ path: string; source: ArtifactStep }> = [];
        const deliver = vi.fn(async (candidate: TurnMediaCandidate, source: ArtifactStep, signal: AbortSignal) => {
            if (!online && !['/work/0.mp4', '/work/1.mp4'].includes(candidate.path)) {
                await new Promise<void>((_resolve, reject) => { if (signal.aborted) reject(signal.reason);else signal.addEventListener('abort', () => reject(signal.reason), { once: true }); });
            }
            enqueued.push({ path: candidate.path, source });
            return { receipt: online ? Promise.resolve() : disconnectedReceipt };
        });
        const firstTurn = new TurnArtifactDelivery({ ledger, scan: async () => ({ candidates: files, pending: false }), deliver, throttleMs: 0, maxDrainMs: 20, onError: vi.fn() });
        await firstTurn.finish(step('original-tool'));
        expect(enqueued).toHaveLength(2);expect(ledger.pendingCount).toBe(30);
        online = true;
        if (trigger === 'connection recovery') await ledger.drain(new AbortController().signal);
        else {
            // The next turn's baseline has swallowed these existing files.
            // The session ledger, not that new scan, must retain the other 28.
            await new TurnArtifactDelivery({ ledger, scan: async () => ({ candidates: [], pending: false }), deliver, throttleMs: 0, onError: vi.fn() })
                .finish({ ...step('new-tool'), turnId: 'new-turn', time: 999 });
        }
        expect(enqueued).toHaveLength(30);expect(new Set(enqueued.map(entry => entry.path)).size).toBe(30);
        expect(enqueued.every(entry => entry.source.turnId === 'turn' && entry.source.sourceId === 'original-tool' && entry.source.time === 123)).toBe(true);
        expect(ledger.pendingCount).toBe(2);acknowledge();await waitFor(() => ledger.pendingCount === 0);
        await ledger.drain(new AbortController().signal);expect(enqueued).toHaveLength(30);
    });

    it('uses an unanchored remaining batch for generic scans coalesced by queue overflow', async () => {
        const sources: ArtifactStep[] = [];
        const queue = new TurnArtifactDelivery({
            scan: async (_hints, _signal, source) => ({ candidates: source.sourceId ? [] : [file('coalesced')], pending: false }),
            deliver: async (_candidate, source) => { sources.push(source);return true; },
            throttleMs: 0, onError: vi.fn(),
        });
        for (let index = 0; index < 30; index++) queue.request({ ...step(`tool-${index}`), time: 100 + index });
        await queue.finish({ ...step('last-tool'), time: 200 });
        expect(sources).toEqual([{ turnId: 'turn', branchId: 'branch', time: 200, batchId: 'artifacts:turn:remaining' }]);
    });

    it('does not lose newer-version deduplication when an older outbox ACK arrives last', async () => {
        const ledger = new ArtifactDeliveryLedger({ onError: vi.fn() });
        let acknowledgeOld!: () => void;const oldReceipt = new Promise<void>(resolve => { acknowledgeOld = resolve; });
        const deliver = vi.fn(async (candidate: TurnMediaCandidate) => ({ receipt: candidate.version === '1' ? oldReceipt : Promise.resolve() }));
        ledger.capture(file('result', '1'), step('first'), deliver);await ledger.drain(new AbortController().signal);
        ledger.capture(file('result', '2'), step('second'), deliver);await ledger.drain(new AbortController().signal);
        acknowledgeOld();await waitFor(() => ledger.pendingCount === 0);
        ledger.capture(file('result', '2'), step('third'), deliver);await ledger.drain(new AbortController().signal);
        expect(deliver).toHaveBeenCalledTimes(2);
    });
    it('delivers a ready item before a slow item or turn completion, preserving source context', async () => {
        let release!: () => void;
        const slow = new Promise<void>(resolve => { release = resolve; });
        const acknowledged: string[] = [];
        const seen: ArtifactStep[] = [];
        const queue = new TurnArtifactDelivery({
            scan: async () => ({ candidates: [file('fast'), file('slow')], pending: false }),
            deliver: async (candidate, source) => { seen.push(source); if (candidate.path.includes('slow')) await slow; acknowledged.push(candidate.path); return true; },
            throttleMs: 0, retryMs: 0, onError: vi.fn(),
        });
        const source = step('tool-1');queue.request(source);source.branchId = 'later-branch';
        await waitFor(() => acknowledged.length === 1);
        expect(acknowledged).toEqual(['/work/fast.mp4']);
        expect(seen.every(value => value.branchId === 'branch' && value.sourceId === 'tool-1' && value.time === 123)).toBe(true);
        release();await queue.finish(step('tail'));
        expect(acknowledged).toEqual(['/work/fast.mp4', '/work/slow.mp4']);
    });

    it('retries a failed ACK and delivers a later version of the same path', async () => {
        let failed = false;
        const deliver = vi.fn(async () => { if (!failed) { failed = true; throw new Error('ACK failed'); } return true; });
        const queue = new TurnArtifactDelivery({
            scan: async (_hints, _signal, source) => ({ candidates: [file('result', source.sourceId === 'tail' ? '2' : '1')], pending: false }),
            deliver, throttleMs: 0, retryMs: 0, onError: vi.fn(),
        });
        queue.request(step('tool-1'));await waitFor(() => deliver.mock.calls.length === 2);
        await queue.finish(step('tail'));
        expect(deliver.mock.calls.map(call => (call as unknown as [TurnMediaCandidate])[0].version)).toEqual(['1', '1', '2']);
    });

    it('collects all 30 files with at most two deliveries in flight', async () => {
        const files = Array.from({ length: 30 }, (_, index) => file(String(index)));
        let active = 0, maximum = 0;const delivered: string[] = [];
        const queue = new TurnArtifactDelivery({
            scan: async () => ({ candidates: files, pending: false }),
            deliver: async candidate => { active++;maximum = Math.max(maximum, active);await new Promise(resolve => setTimeout(resolve, 1));delivered.push(candidate.path);active--;return true; },
            throttleMs: 0, retryMs: 0, onError: vi.fn(),
        });
        await queue.finish(step('tool-1'));
        expect(new Set(delivered).size).toBe(30);expect(maximum).toBe(2);
    });

    it('bounds/coalesces a completion burst while keeping explicit provider origins', async () => {
        const scan = vi.fn(async (hints: string[]) => ({ candidates: hints.map(path => ({ ...file('unused'), path })), pending: false }));
        const sources = new Map<string, string>();
        const queue = new TurnArtifactDelivery({ scan, deliver: async (candidate, source) => { sources.set(candidate.path, source.sourceId!);return true; }, throttleMs: 1, retryMs: 0, onError: vi.fn() });
        for (let index = 0; index < 100; index++) queue.request(step(`provider-${index}`), [`/work/image-${index}.png`]);
        await queue.finish(step('tail'));
        expect(scan.mock.calls.length).toBeLessThanOrEqual(16);
        expect(sources.size).toBe(100);expect(sources.get('/work/image-99.png')).toBe('provider-99');
    });

    it('cancel releases an ACK drain immediately and prevents further delivery', async () => {
        const deliver = vi.fn(async () => new Promise<boolean>(() => {}));
        const queue = new TurnArtifactDelivery({ scan: async () => ({ candidates: [file('one')], pending: false }), deliver, throttleMs: 0, onError: vi.fn(), maxDrainMs: 60_000 });
        const done = vi.fn();const draining = queue.finish(step('tool')).then(done);
        await waitFor(() => deliver.mock.calls.length === 1);queue.cancel();await draining;
        expect(done).toHaveBeenCalledOnce();queue.request(step('ignored'));expect(deliver).toHaveBeenCalledTimes(1);
    });

    it('bounds finish even if delivery never receives an ACK', async () => {
        const queue = new TurnArtifactDelivery({ scan: async () => ({ candidates: [file('one')], pending: false }), deliver: async () => new Promise<boolean>(() => {}), throttleMs: 0, maxDrainMs: 10, onError: vi.fn() });
        await queue.finish(step('tool'));queue.cancel();
    });

    it('cancels before discovery and retries unstable scans only a bounded number of times', async () => {
        const scan = vi.fn(async () => ({ candidates: [], pending: true }));
        const options = { scan, deliver: vi.fn(), throttleMs: 0, retryMs: 0, onError: vi.fn() };
        const cancelled = new TurnArtifactDelivery(options);cancelled.cancel();await cancelled.finish(step('tail'));expect(scan).not.toHaveBeenCalled();
        await new TurnArtifactDelivery(options).finish(step('tail'));expect(scan).toHaveBeenCalledTimes(3);
    });
});

describe('completed artifact discovery boundary', () => {
    it('accepts only successful completed steps, excluding interruption and synthetic turn cleanup', () => {
        expect(isCompletedArtifactStep({ type: 'exec_command_end', status: 'completed', exit_code: 0 })).toBe(true);
        expect(isCompletedArtifactStep({ type: 'exec_command_end', status: 'completed', exit_code: null })).toBe(false);
        expect(isCompletedArtifactStep({ type: 'exec_command_end', status: 'completed', exit_code: 0, completedByTurn: true })).toBe(false);
        expect(isCompletedArtifactStep({ type: 'exec_command_end', status: 'interrupted', exit_code: 130 })).toBe(false);
        expect(isCompletedArtifactStep({ type: 'mcp_tool_call_end', status: 'completed', result: { isError: true } })).toBe(false);
        expect(isCompletedArtifactStep({ type: 'mcp_tool_call_end', status: 'completed' })).toBe(true);
        expect(isCompletedArtifactStep({ type: 'agent_message' })).toBe(false);
    });
});
