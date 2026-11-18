import * as React from 'react';
// @ts-expect-error react-test-renderer is available in this repository without declarations.
import { act, create } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NativeStackHeaderProps } from '@react-navigation/native-stack';

const screen = vi.hoisted(() => ({ width: 1600 }));
vi.mock('react-native', () => ({ useWindowDimensions: () => screen }));
vi.mock('react-native-unistyles', async () => { const { typeScale: typography } = await import('@/constants/typeScale'); return ({ useUnistyles: () => ({ theme: { typography,  colors: { textSecondary: '#aaa' } } }) }); });
vi.mock('@expo/vector-icons/Ionicons', () => ({ default: () => null }));
vi.mock('../WorkspaceControl.web', () => ({
    useWorkspaceControlStyle: () => ({}),
    WorkspaceControl: (props: { onClick: () => void }) => React.createElement('button', { onClick: props.onClick }),
}));
vi.mock('./Header', () => ({ createHeader: () => React.createElement('mobile-header') }));
import { FilePreviewHeader } from './FilePreviewHeader.web';

function render(previous: { name: string; params?: { id: string } }, sessionId: string | undefined = 'session-a') {
    const navigation = {
        canGoBack: () => true,
        getState: () => ({ index: 1, routes: [previous, { name: 'session/[id]/file' }] }),
        goBack: vi.fn(),
        replace: vi.fn(),
    };
    const props = { navigation, route: { params: { id: sessionId } } } as unknown as NativeStackHeaderProps;
    let tree!: ReturnType<typeof create>;
    act(() => { tree = create(React.createElement(FilePreviewHeader, props)); });
    return { navigation, tree, close: () => act(() => tree.root.findByType('button').props.onClick()) };
}

describe('file preview close navigation', () => {
    beforeEach(() => { screen.width = 1600; });

    it('returns to the original file browser without replacing its state', () => {
        const { navigation, tree, close } = render({ name: 'session/[id]/files', params: { id: 'session-a' } });
        close();
        expect(navigation.goBack).toHaveBeenCalledOnce();
        expect(navigation.replace).not.toHaveBeenCalled();
        act(() => tree.unmount());
    });

    it('returns to the originating conversation', () => {
        const { navigation, tree, close } = render({ name: 'session/[id]', params: { id: 'session-a' } });
        close();
        expect(navigation.goBack).toHaveBeenCalledOnce();
        expect(navigation.replace).not.toHaveBeenCalled();
        act(() => tree.unmount());
    });

    it('ignores the session id Expo copies onto the initial index for a deep link', () => {
        const { navigation, tree, close } = render({ name: 'index', params: { id: 'session-a' } });
        close();
        expect(navigation.goBack).not.toHaveBeenCalled();
        expect(navigation.replace).toHaveBeenCalledWith('session/[id]', { id: 'session-a' });
        act(() => tree.unmount());
    });

    it('does not close into another session', () => {
        const { navigation, tree, close } = render({ name: 'session/[id]', params: { id: 'session-b' } });
        close();
        expect(navigation.goBack).not.toHaveBeenCalled();
        expect(navigation.replace).toHaveBeenCalledWith('session/[id]', { id: 'session-a' });
        act(() => tree.unmount());
    });

    it('does not reopen a previous file preview when closing', () => {
        const { navigation, tree, close } = render({ name: 'session/[id]/file', params: { id: 'session-a' } });
        close();
        expect(navigation.goBack).not.toHaveBeenCalled();
        expect(navigation.replace).toHaveBeenCalledWith('session/[id]', { id: 'session-a' });
        act(() => tree.unmount());
    });

    it('retains the existing phone header', () => {
        screen.width = 390;
        const { tree } = render({ name: 'session/[id]', params: { id: 'session-a' } });
        expect(tree.root.findAllByType('button')).toHaveLength(0);
        expect(tree.root.findAllByType('mobile-header')).toHaveLength(1);
        act(() => tree.unmount());
    });
});
