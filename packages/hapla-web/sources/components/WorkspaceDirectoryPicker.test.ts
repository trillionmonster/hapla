import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// @ts-expect-error installed renderer lacks declarations
import { act, create } from 'react-test-renderer';
const fixture = vi.hoisted(() => ({ browse: vi.fn(), dismiss: vi.fn() }));
vi.mock('@/utils/machineDirectoryBrowser', () => ({ browseMachineDirectory: fixture.browse }));
vi.mock('react-native', () => ({ View: 'View', Text: 'Text', Pressable: 'Pressable', TextInput: 'TextInput', ScrollView: 'ScrollView', ActivityIndicator: 'ActivityIndicator',
    Keyboard: { dismiss: fixture.dismiss }, StyleSheet: { create: (s: unknown) => s, hairlineWidth: 1 }, useWindowDimensions: () => ({ width: 390, height: 844 }) }));
vi.mock('@expo/vector-icons/Ionicons', () => ({ default: 'Ionicons' }));
vi.mock('react-native-unistyles', async () => { const { typeScale: typography } = await import('@/constants/typeScale'); return ({ StyleSheet: { create: (style: any) => style({ typography }), hairlineWidth: 1 }, useUnistyles: () => ({ theme: { typography,  dark: true, colors: { text: '#fff', textSecondary: '#aaa', divider: '#555', input: { background: '#222' } } } }) }); });
import { WorkspaceDirectoryPicker } from './WorkspaceDirectoryPicker';
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const listing = (path = '/projects') => ({ success: true, kind: 'directory', path, parentPath: '/', homePath: '/home/me', total: 2, nextOffset: null,
    entries: [{ name: 'folder', path: `${path}/folder`, type: 'directory', symlink: false }, { name: 'file.txt', path: `${path}/file.txt`, type: 'file', symlink: false }] });

describe('workspace directory picker', () => {
    let root: any;
    const select = vi.fn(); const close = vi.fn();
    const render = async (machineId = 'machine') => {
        const component = React.createElement(WorkspaceDirectoryPicker, { machineId, value: '/projects', recent: [{ key: '/recent', label: '~/recent' }], onSelect: select, onClose: close });
        await act(async () => { root ? root.update(component) : root = create(component); });
    };
    const button = (label: string) => root.root.findAllByType('Pressable').find((node: any) => node.props.accessibilityLabel === label);
    beforeEach(() => { fixture.browse.mockReset().mockResolvedValue(listing()); fixture.dismiss.mockClear(); select.mockReset(); close.mockReset(); });
    afterEach(async () => { if (root) await act(async () => root.unmount()); root = undefined; });

    it('keeps files disabled, opens a folder without choosing it, and chooses with one click', async () => {
        await render();
        expect(button('文件，不可选择 file.txt').props.disabled).toBe(true);
        await act(async () => button('打开文件夹 folder').props.onPress());
        expect(fixture.browse).toHaveBeenLastCalledWith('machine', { path: '/projects/folder', showHidden: false, offset: 0 });
        expect(select).not.toHaveBeenCalled();
        fixture.browse.mockResolvedValueOnce(listing('/projects/folder'));
        await act(async () => button('选用目录 folder').props.onPress());
        expect(select).toHaveBeenCalledExactlyOnceWith('/projects/folder');
        expect(fixture.dismiss).toHaveBeenCalled();
    });
    it('checks typed paths and refuses files without overwriting the parent selection', async () => {
        await render();
        await act(async () => root.root.findByType('TextInput').props.onChangeText('/projects/file.txt'));
        fixture.browse.mockResolvedValueOnce({ success: false, code: 'not_directory', error: '此路径是文件' });
        await act(async () => button('使用此路径').props.onPress());
        expect(select).not.toHaveBeenCalled();
        expect(JSON.stringify(root.toJSON())).toContain('此路径是文件');
        await act(async () => root.root.findByType('TextInput').props.onChangeText('/new-project'));
        fixture.browse.mockResolvedValueOnce({ ...listing('/new-project'), kind: 'missing', entries: [] });
        await act(async () => button('使用此路径').props.onPress());
        expect(select).toHaveBeenCalledExactlyOnceWith('/new-project');
    });
    it('selects a validated recent folder immediately', async () => {
        await render(); fixture.browse.mockResolvedValueOnce(listing('/recent'));
        await act(async () => button('选择最近目录 ~/recent').props.onPress());
        expect(fixture.browse).toHaveBeenLastCalledWith('machine', { path: '/recent', mode: 'check' });
        expect(select).toHaveBeenCalledExactlyOnceWith('/recent');
    });
    it('ignores stale navigation when the user edits the address', async () => {
        let finish!: (result: unknown) => void;
        fixture.browse.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
        await render();
        await act(async () => root.root.findByType('TextInput').props.onChangeText('/my-new-draft'));
        await act(async () => finish(listing('/old-reply')));
        expect(root.root.findByType('TextInput').props.value).toBe('/my-new-draft');
    });
    it('does not commit a pending selection after closing or switching machines', async () => {
        await render(); let finish!: (result: unknown) => void;
        fixture.browse.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
        await act(async () => { void button('使用此路径').props.onPress(); });
        await act(async () => button('关闭目录选择').props.onPress());
        await act(async () => finish(listing('/stale')));
        expect(select).not.toHaveBeenCalled(); expect(close).toHaveBeenCalledOnce();
        fixture.browse.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
        await act(async () => { void button('使用此路径').props.onPress(); });
        await render('another-machine');
        await act(async () => finish(listing('/wrong-machine')));
        expect(select).not.toHaveBeenCalled();
    });
});
