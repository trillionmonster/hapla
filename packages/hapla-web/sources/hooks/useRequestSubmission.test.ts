import React from 'react';
import { describe, expect, it } from 'vitest';
// @ts-expect-error installed renderer lacks declarations
import { act, create } from 'react-test-renderer';
import { useRequestSubmission } from './useRequestSubmission';
import { sessionResources } from '@/sync/sessionResources';
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe('request submission authority', () => {
    it('waits after RPC acknowledgement, rejects double submission, and resolves only on authoritative status', async () => {
        let hook!: ReturnType<typeof useRequestSubmission>;
        function Harness({ status }: { status: 'pending' | 'submitting' | 'approved' }) { hook = useRequestSubmission('session', 'request', status); return null; }
        let root: any; await act(async () => { root = create(React.createElement(Harness, { status: 'pending' })); });
        let calls = 0;
        await act(async () => { await hook.submit(async () => { calls++; }); });
        expect(hook.phase).toBe('waiting');
        await act(async () => { await hook.submit(async () => { calls++; }); });
        expect(calls).toBe(1);
        await act(async () => root.update(React.createElement(Harness, { status: 'approved' })));
        expect(hook.isBusy).toBe(false);
        await act(async () => root.unmount());
    });

    it('allows retry on error and ignores an old-session response after unload', async () => {
        let hook!: ReturnType<typeof useRequestSubmission>;
        function Harness() { hook = useRequestSubmission('request-unload', 'request', 'pending'); return null; }
        let root: any; await act(async () => { root = create(React.createElement(Harness)); });
        await act(async () => { await hook.submit(async () => { throw new Error('transport'); }); });
        expect(hook.error).toBe('提交失败，请重试'); expect(hook.isBusy).toBe(false);
        let finish!: () => void;
        let action!: Promise<boolean>;
        await act(async () => { action = hook.submit(() => new Promise<void>((resolve) => { finish = resolve; })); });
        sessionResources.release('request-unload');
        await act(async () => { finish(); await action; });
        expect(await action).toBe(false);
        await act(async () => root.unmount());
    });

    it('does not return to waiting if provider resolution arrives before the RPC response', async () => {
        let hook!: ReturnType<typeof useRequestSubmission>;
        function Harness({ status }: { status: 'pending' | 'approved' }) { hook = useRequestSubmission('fast-request', 'request', status); return null; }
        let root: any; await act(async () => { root = create(React.createElement(Harness, { status: 'pending' })); });
        let finish!: () => void; let action!: Promise<boolean>;
        await act(async () => { action = hook.submit(() => new Promise<void>((resolve) => { finish = resolve; })); });
        await act(async () => root.update(React.createElement(Harness, { status: 'approved' })));
        await act(async () => { finish(); await action; });
        expect(hook.isBusy).toBe(false);
        await act(async () => root.unmount());
    });
});
