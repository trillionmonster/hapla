import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// @ts-expect-error installed renderer lacks declarations
import { act, create } from 'react-test-renderer';

const fixtures = vi.hoisted(() => ({ open: vi.fn(), active: true, fontSizeLevel: 3 as 1 | 2 | 3 | 4 | 5, terminals: [] as any[], writes: vi.fn(), dispose: vi.fn() }));
vi.mock('@/utils/workspaceTerminal', () => ({ openWorkspaceTerminal: fixtures.open }));
vi.mock('@/sync/storage', () => ({ useSession: () => ({ active: fixtures.active, metadata: { machineId: 'machine' } }) }));
vi.mock('react-native', () => ({ ActivityIndicator: 'ActivityIndicator', Pressable: 'Pressable', View: 'View', Platform: { OS: 'web' }, useWindowDimensions: () => ({ width: 1200, height: 800 }) }));
vi.mock('@/components/StyledText', () => ({ Text: 'Text' }));
vi.mock('@expo/vector-icons/Ionicons', () => ({ default: 'Ionicons' }));
vi.mock('react-native-unistyles', async () => { const { createTypeScale } = await import('@/constants/typeScale'); return ({ useUnistyles: () => ({ theme: { typography: createTypeScale(fixtures.fontSizeLevel), dark: true, colors: {} } }) }); });
vi.mock('@xterm/xterm', () => ({ Terminal: class {
    options: any;
    constructor(options: any) { this.options = { ...options }; fixtures.terminals.push(this); }
    cols = 100; rows = 30; write = fixtures.writes; writeln = fixtures.writes; dispose = fixtures.dispose;
    loadAddon() {} open() {} focus() {} onData() {}
} }));
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { fit() {} } }));
import CoderTerminalPanel from './CoderTerminalPanel.web';
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe('terminal panel connection failures and cleanup', () => {
    let root: any;
    const render = async () => {
        const element = React.createElement(CoderTerminalPanel, { sessionId: 'session', cwd: '/data2/workspace/video-e2e', onClose: () => {} });
        await act(async () => { root ? root.update(element) : root = create(element, { createNodeMock: () => ({}) }); });
        await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
    };
    beforeEach(() => {
        fixtures.active = true; fixtures.fontSizeLevel = 3; fixtures.terminals.length = 0; fixtures.open.mockReset(); fixtures.writes.mockReset(); fixtures.dispose.mockReset();
        vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
    });
    afterEach(async () => { if (root) await act(async () => root.unmount()); root = undefined; vi.unstubAllGlobals(); });

    it('displays the failed start and reconnects with a working terminal instead of leaving a blank ready panel', async () => {
        fixtures.open.mockRejectedValueOnce(new Error('Access denied: Path is outside the working directory'));
        await render();
        await vi.waitFor(async () => { await act(async () => {}); expect(JSON.stringify(root.toJSON())).toContain('Access denied'); });
        expect(root.root.findAllByType('ActivityIndicator')).toHaveLength(0);
        const close = vi.fn().mockResolvedValue(undefined);
        const read = vi.fn().mockResolvedValue({ data: 'workspace $ ', cursor: 1, dataLost: false, exited: false });
        fixtures.open.mockResolvedValueOnce({ read, close, resize: vi.fn(), write: vi.fn() });
        const retry = root.root.findAllByType('Pressable').find((node: any) => node.props.accessibilityLabel === '重新连接终端');
        await act(async () => retry.props.onPress());
        await vi.waitFor(async () => { await act(async () => {}); expect(fixtures.open).toHaveBeenCalledTimes(2); });
        await vi.waitFor(async () => { await act(async () => {}); expect(fixtures.writes).toHaveBeenCalledWith('workspace $ '); });
        expect(JSON.stringify(root.toJSON())).not.toContain('Access denied');
        fixtures.active = false; await render();
        expect(fixtures.open).toHaveBeenCalledTimes(2);
        expect(close).not.toHaveBeenCalled();
        await act(async () => root.unmount()); root = undefined;
        expect(close).toHaveBeenCalledTimes(1);
    });


    it('resizes an open terminal when the font changes without restarting its process', async () => {
        const close = vi.fn().mockResolvedValue(undefined);
        const resize = vi.fn().mockResolvedValue(undefined);
        const read = vi.fn().mockResolvedValue({ data: '', cursor: 0, dataLost: false, exited: true });
        fixtures.open.mockResolvedValueOnce({ read, close, resize, write: vi.fn() });
        await render();
        await vi.waitFor(() => expect(read).toHaveBeenCalled());
        fixtures.fontSizeLevel = 5;
        await render();
        expect(fixtures.terminals[0].options.fontSize).toBe(20);
        expect(fixtures.terminals[0].options.lineHeight).toBe(31 / 20);
        expect(resize).toHaveBeenCalledWith(100, 30);
        expect(fixtures.open).toHaveBeenCalledTimes(1);
        expect(close).not.toHaveBeenCalled();
        expect(fixtures.dispose).not.toHaveBeenCalled();
    });

    it('ignores an outstanding read when the panel is closed and closes only its own connection', async () => {
        let resolve!: (value: unknown) => void;
        const close = vi.fn().mockResolvedValue(undefined);
        fixtures.open.mockResolvedValueOnce({ read: () => new Promise(done => { resolve = done; }), close, resize: vi.fn(), write: vi.fn() });
        await render();
        await act(async () => { await vi.waitFor(() => expect(resolve).toBeTypeOf('function')); });
        await act(async () => root.unmount()); root = undefined;
        await act(async () => resolve({ data: 'stale output', cursor: 1, dataLost: false, exited: false }));
        expect(fixtures.writes).not.toHaveBeenCalled();
        expect(close).toHaveBeenCalledTimes(1);
    });
});
