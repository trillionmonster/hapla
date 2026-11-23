import * as React from 'react';
// @ts-expect-error installed renderer lacks declarations
import { act, create } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('@expo/vector-icons/Ionicons', () => ({ default: 'Icon' }));
vi.mock('./codexFollowupStyle', () => ({ useCodexFollowupStyle: () => ({}) }));
vi.mock('@/sync/apiSocket', () => ({ apiSocket: { sessionCommand: vi.fn() } }));
import { MobileComposerBar } from './MobileComposerBar.web';
let root: any;
beforeEach(() => {
    vi.useFakeTimers();
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    vi.stubGlobal('document', new EventTarget());
});
afterEach(async () => {
    if (root) await act(async () => root.unmount());
    root = undefined;
    vi.useRealTimers();
    vi.unstubAllGlobals();
});
function props(overrides: any = {}): any {
    return {
        hasContent: false,
        canSend: false,
        aborting: false,
        onSend: vi.fn(),
        onSettings: vi.fn(),
        ...overrides,
    };
}
const button = (label: string) =>
    root.root.findAllByType('button').find((node: any) => node.props['aria-label'] === label);
describe('compact mobile composer', () => {
    it('prevents a rapid second send tap from turning into an unintended main-task stop', async () => {
        const state = props({ hasContent: true, canSend: true, onAbort: vi.fn() });
        await act(async () => {
            root = create(React.createElement(MobileComposerBar, state));
        });
        await act(async () => button('Send message').props.onClick());
        expect(state.onSend).toHaveBeenCalledTimes(1);
        await act(async () =>
            root.update(
                React.createElement(MobileComposerBar, { ...state, hasContent: false, canSend: false }),
            ),
        );
        expect(button('停止当前任务')).toBeUndefined();
        expect(button('Send message').props.disabled).toBe(true);
        await act(async () => vi.advanceTimersByTime(700));
        expect(state.onAbort).not.toHaveBeenCalled();
        await act(async () => button('停止当前任务').props.onClick());
        expect(state.onAbort).toHaveBeenCalledTimes(1);
    });
    it('keeps an existing draft sendable and makes explicit stop available through the menu', async () => {
        const state = props({ hasContent: true, canSend: true, onAbort: vi.fn() });
        await act(async () => {
            root = create(React.createElement(MobileComposerBar, state));
        });
        expect(button('Send message').props.disabled).toBe(false);
        await act(async () => button('更多输入操作').props.onClick());
        await act(async () => button('停止当前任务').props.onClick());
        expect(state.onAbort).toHaveBeenCalledTimes(1);
        expect(state.onSend).not.toHaveBeenCalled();
        expect(root.root.findAll((node: any) => node.props.role === 'menu')).toHaveLength(0);
    });
    it('opens history without sending or interrupting the conversation', async () => {
        const state = props({ onHistory: vi.fn(), onAbort: vi.fn() });
        await act(async () => {
            root = create(React.createElement(MobileComposerBar, state));
        });
        await act(async () => button('更多输入操作').props.onClick());
        await act(async () => button('当前会话全部历史问题').props.onClick());
        expect(state.onHistory).toHaveBeenCalledTimes(1);
        expect(state.onAbort).not.toHaveBeenCalled();
        expect(state.onSend).not.toHaveBeenCalled();
    });

    it('dismisses the input menu with Escape before an interruption handler can run', async () => {
        const state = props({ onAbort: vi.fn() });
        await act(async () => {
            root = create(React.createElement(MobileComposerBar, state));
        });
        await act(async () => button('更多输入操作').props.onClick());
        const interrupt = vi.fn();
        document.addEventListener('keydown', interrupt);
        const escape = Object.assign(new Event('keydown', { cancelable: true }), { key: 'Escape' });
        await act(async () => document.dispatchEvent(escape));
        expect(escape.defaultPrevented).toBe(true);
        expect(interrupt).not.toHaveBeenCalled();
        expect(state.onAbort).not.toHaveBeenCalled();
        expect(root.root.findAll((node: any) => node.props.role === 'menu')).toHaveLength(0);
    });
});
