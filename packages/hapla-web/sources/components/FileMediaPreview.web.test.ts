import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// @ts-expect-error installed renderer lacks declarations
import { act, create } from 'react-test-renderer';

vi.mock('react-native', () => ({ Pressable: 'Pressable', View: 'View', Platform: { OS: 'web' } }));
vi.mock('@/components/StyledText', () => ({ Text: 'Text' }));
vi.mock('react-native-unistyles', async () => { const { typeScale: typography } = await import('@/constants/typeScale'); return ({ useUnistyles: () => ({ theme: { typography,  colors: {} } }) }); });

import { FileMediaPreview } from './FileMediaPreview.web';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

class MediaElement {
    pause = vi.fn();
    removeAttribute = vi.fn();
    load = vi.fn();
}
class VideoElement extends MediaElement {}

describe('FileMediaPreview video stream attachment', () => {
    let root: any;
    let page: EventTarget;
    let video: VideoElement;
    const render = async (props: Partial<React.ComponentProps<typeof FileMediaPreview>> = {}) => {
        const element = React.createElement(FileMediaPreview, {
            fileName: 'preview.mp4', kind: 'video', mimeType: 'video/mp4', url: 'blob:mse-preview', ...props,
        });
        await act(async () => {
            root ? root.update(element) : root = create(element, {
                createNodeMock: (node: { type: string }) => node.type === 'video' ? video : null,
            });
        });
    };

    beforeEach(() => {
        page = new EventTarget();
        video = new VideoElement();
        vi.stubGlobal('window', page);
        vi.stubGlobal('HTMLMediaElement', MediaElement);
        vi.stubGlobal('HTMLVideoElement', VideoElement);
    });
    afterEach(async () => {
        if (root) await act(async () => root.unmount());
        root = undefined;
        vi.unstubAllGlobals();
    });

    it('attaches the acquired MediaSource to the actual video and detaches and clears it on close', async () => {
        const detach = vi.fn();
        const attachVideo = vi.fn(() => detach);
        await render({ attachVideo });
        expect(attachVideo).toHaveBeenCalledWith(video, expect.any(Function));
        expect(attachVideo).toHaveBeenCalledTimes(1);
        expect(root.root.findByType('video').props.preload).toBe('metadata');
        await act(async () => root.unmount()); root = undefined;
        expect(detach).toHaveBeenCalledTimes(1);
        expect(video.pause).toHaveBeenCalledTimes(1);
        expect(video.removeAttribute).toHaveBeenCalledWith('src');
        expect(video.load).toHaveBeenCalledTimes(1);
    });

    it('reports asynchronous stream failures and native video failures to the lease owner', async () => {
        const onError = vi.fn();
        const attachVideo = vi.fn((_video: HTMLVideoElement, report?: (message: string) => void) => {
            return () => {};
        });
        await render({ attachVideo, onError });
        await act(async () => attachVideo.mock.calls[0][1]?.('视频分段读取失败，请重试'));
        expect(onError).toHaveBeenCalledWith('视频分段读取失败，请重试');
        await act(async () => root.root.findByType('video').props.onError());
        expect(onError).toHaveBeenLastCalledWith('媒体无法加载或浏览器不支持此编码，请重试或下载查看');
    });

    it('detaches immediately on pagehide even when the browser preserves the React tree', async () => {
        const detach = vi.fn();
        await render({ attachVideo: () => detach });
        await act(async () => page.dispatchEvent(new Event('pagehide')));
        expect(detach).toHaveBeenCalledTimes(1);
        expect(video.pause).toHaveBeenCalledTimes(1);
        expect(video.removeAttribute).toHaveBeenCalledWith('src');
        await act(async () => root.unmount()); root = undefined;
        expect(detach).toHaveBeenCalledTimes(1);
        expect(video.load).toHaveBeenCalledTimes(1);
    });

    it('continues to support an ordinary HTTP or cached Blob video without a stream attachment', async () => {
        await render({ url: 'http://example.test/video.mp4' });
        expect(root.root.findByType('video').props.src).toBe('http://example.test/video.mp4');
        expect(root.root.findByType('video').props.preload).toBe('metadata');
    });
});
