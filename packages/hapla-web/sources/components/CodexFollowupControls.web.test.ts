import * as React from 'react';
// @ts-expect-error installed renderer lacks declarations
import { act, create } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const fixture = vi.hoisted(() => ({ session: {} as any, rpc: vi.fn() }));
vi.mock('@/sync/storage', () => ({ useSession: () => fixture.session }));
vi.mock('@/sync/apiSocket', () => ({ apiSocket: { sessionCommand: fixture.rpc } }));
vi.mock('@expo/vector-icons/Ionicons', () => ({ default: 'Icon' }));
vi.mock('./layout', () => ({ layout: { maxWidth: 800 } }));
vi.mock('./codexFollowupStyle', () => ({ useCodexFollowupStyle: () => ({}) }));
import { CodexFollowupControls } from './CodexFollowupControls.web';

let root: any;
beforeEach(() => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    vi.clearAllMocks();
    vi.stubGlobal('document', new EventTarget());
    vi.stubGlobal('requestAnimationFrame', (callback: () => void) => { callback(); return 0; });
    fixture.session = { agentState: { codexInputs: { paused: true, items: [{ id: 'input-1', message: 'Original queued question', revision: 4, createdAt: 1 }] } } };
    fixture.rpc.mockResolvedValue({});
});
afterEach(async () => { if (root) await act(async () => root.unmount()); root = undefined; vi.unstubAllGlobals(); });
async function mount(onMode = vi.fn()) { await act(async () => { root = create(React.createElement(CodexFollowupControls, { sessionId: 'session', mode: 'steer', onMode, onSideChat: vi.fn() })); }); }
const labelled = (label: string) => root.root.findAllByType('button').find((button: any) => button.props['aria-label'] === label);
const click = async (label: string) => { await act(async () => labelled(label).props.onClick()); };

describe('Web follow-up controls', () => {
    it('changes delivery mode without canceling or submitting a task', async () => {
        const onMode = vi.fn(); await mount(onMode);
        await click('选择发送方式');
        await click('旁问 BTW');
        expect(onMode).toHaveBeenCalledWith('btw');
        expect(fixture.rpc).not.toHaveBeenCalled();
        expect(root.root.findAll((node: any) => node.props.role === 'menu')).toHaveLength(0);
    });
    it('retains an edited question and shows the error when its queue revision is stale', async () => {
        await mount(); await click('查看待发送队列'); await click('修改');
        await act(async () => root.root.findByType('textarea').props.onChange({ target: { value: 'Edited queued question' } }));
        fixture.rpc.mockRejectedValueOnce(new Error('这条消息已被修改，请刷新队列'));
        const save = root.root.findAllByType('button').find((button: any) => button.children.includes('保存'));
        await act(async () => save.props.onClick());
        expect(fixture.rpc).toHaveBeenCalledWith('session', 'codex-queue', { action: 'update', id: 'input-1', revision: 4, text: 'Edited queued question' });
        expect(root.root.findByType('textarea').props.value).toBe('Edited queued question');
        expect(root.root.findAll((node: any) => node.props.role === 'alert')[0].children).toContain('这条消息已被修改，请刷新队列');
    });
    it('dismisses the queue with Escape before any task interruption handler can run', async () => {
        await mount(); await click('查看待发送队列');
        const abort = vi.fn(); document.addEventListener('keydown', abort);
        const escape = Object.assign(new Event('keydown', { cancelable: true }), { key: 'Escape' });
        await act(async () => document.dispatchEvent(escape));
        expect(escape.defaultPrevented).toBe(true);
        expect(abort).not.toHaveBeenCalled();
        expect(fixture.rpc).not.toHaveBeenCalled();
        expect(root.root.findAllByType('section')).toHaveLength(0);
    });
});
