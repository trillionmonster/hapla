import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
// @ts-expect-error installed renderer lacks declarations
import { act, create } from 'react-test-renderer';

const calls = vi.hoisted(() => ({ openURL: vi.fn(), push: vi.fn(), download: vi.fn(), browserDownload: vi.fn(), alert: vi.fn() }));
vi.mock('@/utils/browserDownload', () => ({ handOffBrowserDownload: calls.browserDownload }));
vi.mock('react-native', () => ({ Platform: { OS: 'web' }, useWindowDimensions: () => ({ width: 1280 }), View: 'div', Pressable: 'button', Linking: { openURL: calls.openURL } }));
vi.mock('@expo/vector-icons/Ionicons', () => ({ default: 'icon' }));
vi.mock('@/components/StyledText', () => ({ Text: 'span' }));
vi.mock('@/constants/Typography', () => ({ Typography: { default: () => ({}), mono: () => ({}) } }));
vi.mock('@/modal', () => ({ Modal: { alert: calls.alert } }));
vi.mock('expo-router', () => ({ useRouter: () => ({ push: calls.push }) }));
vi.mock('@/sync/storage', () => ({ storage: { getState: () => ({ sessions: { session: { metadata: { path: '/root/work', machineId: 'machine' } } } }) } }));
vi.mock('@/utils/workspaceFileTransfer', () => ({ downloadWorkspaceFile: calls.download, formatFileSize: (size: number) => `${size} B` }));
vi.mock('@/components/media/MediaGallery', () => ({ MediaGallery: 'media-gallery' }));
vi.mock('react-native-unistyles', async () => { const { typeScale: typography } = await import('@/constants/typeScale');
    const token: any = new Proxy({}, { get: () => token });
    const theme = { typography,  colors: token };
    return { useUnistyles: () => ({ theme }), StyleSheet: { create: (style: any) => style(theme) } };
});

import { FileArtifactView } from './FileArtifactView';
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe('FileArtifactView media references', () => {
    beforeEach(() => vi.clearAllMocks());
    it.each(['installer.exe', 'archive.zip', 'plugin.dll'])('offers only download for unsupported binary %s without reading it on render', async ref => {
        calls.download.mockResolvedValue(undefined);
        let root: any;
        await act(async () => { root = create(React.createElement(FileArtifactView, {
            sessionId: 'session', tool: { createdAt: 127, input: { ref, size: 47 * 1024 * 1024 } },
        } as any)); });
        const buttons = root.root.findAllByType('button');
        expect(buttons).toHaveLength(1);
        expect(buttons[0].props.accessibilityLabel).toBe(`下载 ${ref}`);
        expect(calls.download).not.toHaveBeenCalled();
        expect(calls.push).not.toHaveBeenCalled();
        await act(async () => buttons[0].props.onPress());
        expect(calls.download).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'session', path: ref }));
        await act(async () => root.unmount());
    });

    it('recognizes a signed external executable despite its display caption and preserves the exact download URL', async () => {
        const ref = 'https://cdn.example.test/releases/installer.exe?X-Amz-Signature=FAKE';
        let root: any;
        await act(async () => { root = create(React.createElement(FileArtifactView, {
            sessionId: 'session', tool: { createdAt: 128, input: { ref, name: '安装程序' } },
        } as any)); });
        const buttons = root.root.findAllByType('button');
        expect(buttons).toHaveLength(1);
        await act(async () => buttons[0].props.onPress());
        expect(calls.browserDownload).toHaveBeenCalledWith(ref, '安装程序');
        expect(calls.openURL).not.toHaveBeenCalled();
        expect(calls.download).not.toHaveBeenCalled();
        await act(async () => root.unmount());
    });

    it.each(['report.md', 'report.html', 'report.htm', 'diagram.svg', 'image.png', 'audio.mp3'])('retains the supported preview action for %s', async ref => {
        let root: any;
        await act(async () => { root = create(React.createElement(FileArtifactView, {
            sessionId: 'session', tool: { createdAt: 129, input: { ref } },
        } as any)); });
        const buttons = root.root.findAllByType('button');
        expect(buttons).toHaveLength(2);
        expect(buttons[0].props.accessibilityLabel).toBe(`预览 ${ref}`);
        await act(async () => buttons[0].props.onPress());
        expect(calls.push).toHaveBeenCalledTimes(1);
        expect(calls.download).not.toHaveBeenCalled();
        await act(async () => root.unmount());
    });

    it('does not report an intentional download cancellation as a failure', async () => {
        calls.download.mockRejectedValueOnce(new DOMException('下载已取消', 'AbortError'));
        let root: any;
        await act(async () => { root = create(React.createElement(FileArtifactView, {
            sessionId: 'session', tool: { createdAt: 126, input: { ref: 'report.md' } },
        } as any)); });
        await act(async () => root.root.findAllByType('button')[1].props.onPress());
        expect(calls.download).toHaveBeenCalledTimes(1); expect(calls.alert).not.toHaveBeenCalled();
        await act(async () => root.unmount());
    });

    it('renders one signed external video card with its exact URL and no workspace route or duplicate toolbar', async () => {
        const ref = 'https://cdn.example.test/render/final%20cut.mp4?X-Amz-Credential=FAKE%2Fscope&X-Amz-Signature=not-a-secret&part=1+2&part=%2b#t=1';
        let root: any;
        await act(async () => { root = create(React.createElement(FileArtifactView, {
            sessionId: 'session', tool: { createdAt: 123, input: { ref, name: ref.split('/').pop(), mimeType: 'video/mp4' } },
        } as any)); });
        const galleries = root.root.findAllByType('media-gallery');
        expect(galleries).toHaveLength(1);
        expect(galleries[0].props.media).toEqual([{
            url: ref, mediaType: 'video/mp4', name: 'final cut.mp4', workspaceVideo: undefined, previewRevision: '123',
        }]);
        expect(root.root.findAllByType('button')).toHaveLength(0);
        expect(calls.download).not.toHaveBeenCalled();
        expect(calls.push).not.toHaveBeenCalled();
        await act(async () => root.unmount());
    });

    it('retains rooted local video metadata and still renders just one media card', async () => {
        let root: any;
        await act(async () => { root = create(React.createElement(FileArtifactView, {
            sessionId: 'session', tool: { createdAt: 124, input: { ref: 'clips/final.mp4', size: 2048 } },
        } as any)); });
        expect(root.root.findAllByType('media-gallery')).toHaveLength(1);
        expect(root.root.findByType('media-gallery').props.media[0]).toEqual({
            url: 'clips/final.mp4', name: 'final.mp4', mediaType: 'video/mp4', size: 2048,
            workspaceVideo: { sessionId: 'session', path: '/root/work/clips/final.mp4' }, previewRevision: '124',
        });
        expect(root.root.findAllByType('button')).toHaveLength(0);
        await act(async () => root.unmount());
    });

    it('opens an external document without invoking local file RPC', async () => {
        const ref = 'https://cdn.example.test/report.pdf?X-Amz-Signature=FAKE';
        let root: any;
        await act(async () => { root = create(React.createElement(FileArtifactView, {
            sessionId: 'session', tool: { createdAt: 125, input: { ref } },
        } as any)); });
        expect(root.root.findAllByType('media-gallery')).toHaveLength(0);
        const buttons = root.root.findAllByType('button');
        expect(buttons).toHaveLength(2);
        await act(async () => buttons[0].props.onPress());
        await act(async () => buttons[1].props.onPress());
        expect(calls.openURL.mock.calls).toEqual([[ref]]);
        expect(calls.browserDownload).toHaveBeenCalledWith(ref, 'report.pdf');
        expect(calls.download).not.toHaveBeenCalled();
        expect(calls.push).not.toHaveBeenCalled();
        await act(async () => root.unmount());
    });
});
