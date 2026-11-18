import React from 'react';
import { describe, expect, it } from 'vitest';
// @ts-expect-error installed renderer lacks declarations
import { act, create } from 'react-test-renderer';
import { useWorkspaceMode } from './useWorkspaceMode';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe('workspace mode for the current visit', () => {
    it('supports toggling and resets when switching sessions or entering again', async () => {
        let hook!: ReturnType<typeof useWorkspaceMode>;
        const observed: string[] = [];
        function Harness({ sessionId }: { sessionId: string }) {
            hook = useWorkspaceMode(sessionId);
            observed.push(`${sessionId}:${hook[0]}`);
            return null;
        }
        let root: any;
        await act(async () => { root = create(React.createElement(Harness, { sessionId: 'a' })); });
        expect(hook[0]).toBe('normal');
        await act(async () => hook[1]('coder'));
        expect(hook[0]).toBe('coder');
        await act(async () => hook[1]('normal'));
        expect(hook[0]).toBe('normal');
        await act(async () => hook[1]('coder'));
        await act(async () => root.update(React.createElement(Harness, { sessionId: 'b' })));
        expect(hook[0]).toBe('normal');
        expect(observed).not.toContain('b:coder');
        await act(async () => root.update(React.createElement(Harness, { sessionId: 'a' })));
        expect(hook[0]).toBe('normal');
        await act(async () => hook[1]('coder'));
        await act(async () => root.unmount());
        await act(async () => { root = create(React.createElement(Harness, { sessionId: 'a' })); });
        expect(hook[0]).toBe('normal');
        await act(async () => root.unmount());
    });
});
