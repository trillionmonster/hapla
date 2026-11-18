import * as React from 'react';
// @ts-expect-error installed renderer lacks declarations
import { act, create } from 'react-test-renderer';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

// Transport and authenticated URL preparation are covered by the cloud
// delivery suite; this SSR suite verifies card/link markup without Expo setup.
vi.mock('@/utils/cloudFileDelivery', () => ({ storedCloudPath: () => null, storedImagePreviewUrl: (uri: string) => uri.startsWith('/files/public/users/') ? `http://hapla.test${uri}?preview=image` : null, isCloudFileLink: (uri: string) => uri.includes('.r2.cloudflarestorage.com'), cloudStageLabel: () => '准备预览', acquireStoredCloudFile: vi.fn(), downloadStoredFile: vi.fn() }));

vi.mock('react-native', () => ({
    View: ({ children }: { children?: React.ReactNode }) => React.createElement('div', null, children),
    Pressable: ({ children }: { children?: React.ReactNode }) => React.createElement('button', null, children),
    Linking: { openURL: vi.fn() },
    useWindowDimensions: () => ({ width: 1200, height: 900 }),
}));
vi.mock('react-native-unistyles', async () => { const { typeScale: typography } = await import('@/constants/typeScale'); return ({
    useUnistyles: () => ({ theme: { typography,  colors: { text: '#111', surfaceHigh: '#eee' } } }),
}); });
vi.mock('@expo/vector-icons/Ionicons', () => ({ default: () => null }));
vi.mock('expo-image', () => ({
    Image: ({ source }: { source: { uri: string } }) => React.createElement('img', { src: source.uri }),
}));
vi.mock('@/components/StyledText', () => ({
    Text: ({ children, accessibilityRole }: { children?: React.ReactNode; accessibilityRole?: string }) =>
        React.createElement('span', { role: accessibilityRole }, children),
}));

import { MediaGallery as WebMediaGallery, ZoomableImage } from './MediaGallery.web';
import { MediaGallery as NativeMediaGallery, type MessageMedia } from './MediaGallery';
import { inferMediaType } from './mediaKind';
import { mediaFallbackLink } from './mediaFallbackLink';

function renderWeb(media: MessageMedia[]) {
    return renderToStaticMarkup(React.createElement(WebMediaGallery, { media }));
}

describe('media gallery link fallback', () => {
    it('retains the preview until the original image has actually loaded, including when the source changes', async () => {
        (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
        let root: any;
        const onError = vi.fn();
        const render = (src: string) => React.createElement(ZoomableImage, { src, previewSrc: '/small.jpg', onError });
        try {
            await act(async () => { root = create(render('/original.png')); });
            expect(root.root.findAllByType('img').map((img: any) => img.props.src)).toEqual(['/small.jpg', '/original.png']);
            expect(root.root.findAllByType('img')[1].props.style.opacity).toBe(0);
            await act(async () => root.root.findAllByType('img')[1].props.onLoad());
            expect(root.root.findAllByType('img').map((img: any) => img.props.src)).toEqual(['/original.png']);
            await act(async () => root.update(render('/next.png')));
            expect(root.root.findAllByType('img').map((img: any) => img.props.src)).toEqual(['/small.jpg', '/next.png']);
            await act(async () => root.root.findAllByType('img')[1].props.onError());
            expect(onError).toHaveBeenCalledOnce();
            expect(root.root.findAllByType('img')[0].props.src).toBe('/small.jpg');
        } finally { if (root) await act(async () => root.unmount()); }
    });
    it('renders stored image cards from small previews without preparing the R2 original', () => {
        const html = renderWeb([{ url: '/files/public/users/owner/chat-images/image.png', mediaType: 'image/png', name: 'image.png' }]);
        expect(html).toContain('data-stored-image-preview');
        expect(html).toContain('src="http://hapla.test/files/public/users/owner/chat-images/image.png?preview=image"');
        expect(html).toContain('loading="lazy"');
        expect(html).not.toContain('<progress');
    });
    it('renders unknown HTTP content as ordinary links without media or download controls', () => {
        const html = renderWeb([
            { url: 'https://github.com/example/project.git', mediaType: 'application/octet-stream' },
            { url: 'https://example.test/article', mediaType: 'text/html', name: '说明文档' },
        ]);
        expect(html).toContain('href="https://github.com/example/project.git"');
        expect(html).toContain('href="https://example.test/article"');
        expect(html).toContain('说明文档');
        expect(html).toContain('target="_blank"');
        expect(html).toContain('rel="noopener noreferrer"');
        expect(html).not.toMatch(/<(?:img|video|audio|button)\b/);
        expect(html).not.toContain('download=');
        expect(html).not.toContain('role="dialog"');
    });

    it('keeps declared extensionless images and known audio/video in media cards', () => {
        const html = renderWeb([
            { url: 'https://example.test/image-service?id=123', mediaType: 'image/png' },
            { url: 'https://example.test/music.mp3?token=valid', mediaType: 'audio/mpeg' },
            { url: 'https://example.test/movie.mp4', mediaType: 'video/mp4' },
        ]);
        expect(html).toContain('<img');
        expect(html).toContain('<audio');
        expect(html).not.toContain('<video');
        expect(html).toContain('data-video-card');
        expect(html).toContain('打开视频');
        expect(html).toContain('download=');
    });

    it('shows original video facts and a small poster without mounting a player', () => {
        const html = renderWeb([{ url: '/files/movie.mp4', mediaType: 'video/mp4', name: '演示.mp4', size: 123,
            video: { status: 'ready', durationSeconds: 125, width: 1920, height: 1080, aspectRatio: '16:9', sizeBytes: 10485760,
                posterDataUrl: 'data:image/jpeg;base64,YQ==' } }]);
        expect(html).not.toContain('<video');
        expect(html).toContain('2:05');
        expect(html).toContain('1920 × 1080');
        expect(html).toContain('16:9');
        expect(html).toContain('原文件 10.0 MiB');
        expect(html).toContain('10,485,760 字节');
        expect(html).toContain('视频封面');
    });

    it('exposes an independent download link without changing the signed URL or opening a player', () => {
        const url = 'https://external.example.com/video/original.mp4?X-Amz-Signature=abc%2F123&X-Amz-Expires=3600';
        const html = renderWeb([{ url, mediaType: 'video/mp4', name: '原片.mp4' }]);
        expect(html).toContain('</button><div data-video-download-action');
        expect(html).toContain('下载原视频');
        expect(html).toContain('href="' + url.replaceAll('&', '&amp;') + '"');
        expect(html).toContain('download="原片.mp4"');
        expect(html).not.toContain('<video');
        expect(html).not.toContain('role="dialog"');
    });

    it('marks an expired external download as unavailable without linking to a known 403', () => {
        const html = renderWeb([{ url: 'https://example.test/expired.mp4', mediaType: 'video/mp4',
            video: { status: 'unavailable', reason: 'source_expired', retryable: false } }]);
        expect(html).toContain('链接已过期，请更新链接');
        expect(html).toMatch(/<button[^>]*disabled=""[^>]*aria-label="下载原视频/);
        expect(html).not.toContain('href="https://example.test/expired.mp4"');
    });

    it('keeps local original downloads available even when their old preview expired', () => {
        const html = renderWeb([{ url: '/workspace/movie.mp4', mediaType: 'video/mp4',
            workspaceVideo: { sessionId: 'session', path: '/workspace/movie.mp4' },
            video: { status: 'unavailable', reason: 'source_expired' } }]);
        const action = html.slice(html.indexOf('data-video-download-action'));
        expect(action).toContain('下载原视频');
        expect(action).not.toContain('disabled=""');
        expect(action).not.toContain('href="/workspace/movie.mp4"');
    });

    it('does not crash the conversation when a local video lacks its workspace association', () => {
        const html = renderWeb([{ url: 'file:///missing/movie.mp4', mediaType: 'video/mp4' }]);
        expect(html).toContain('缺少可下载的原文件地址');
        expect(html).toContain('disabled=""');
        expect(html).not.toContain('href="file:');
    });

    it('retains explicit image intent without replacing recognizable audio/video extensions', () => {
        expect(inferMediaType('https://example.test/image-service?id=123', 'image/unknown')).toBe('image/unknown');
        expect(inferMediaType('/workspace/demo.mp4', 'image/unknown')).toBe('video/mp4');
        expect(inferMediaType('https://example.test/audio.mp3?token=valid', 'image/unknown')).toBe('audio/mpeg');
        const html = renderWeb([{ url: 'https://example.test/image-service', mediaType: 'image/unknown' }]);
        expect(html).toContain('<img');
    });

    it('does not turn unknown data or executable schemes into clickable URLs', () => {
        const html = renderWeb([
            { url: 'javascript:alert(1)', mediaType: 'application/octet-stream', name: '不支持的链接' },
            { url: 'data:text/html,<h1>test</h1>', mediaType: 'text/html', name: 'HTML 文档' },
        ]);
        expect(html).toContain('不支持的链接');
        expect(html).toContain('HTML 文档');
        expect(html).not.toMatch(/<(?:a|img|video|audio|button)\b/);
    });

    it('does not probe unknown native content using an Image', () => {
        const html = renderToStaticMarkup(React.createElement(NativeMediaGallery, { media: [
            { url: 'https://github.com/example/project.git', mediaType: 'application/octet-stream' },
            { url: 'javascript:alert(1)', mediaType: 'application/octet-stream', name: '不支持的链接' },
        ] }));
        expect(html).toContain('role="link"');
        expect(html).toContain('https://github.com/example/project.git');
        expect(html).not.toContain('<img');
    });

    it.each(['javascript:alert(1)', 'data:text/html,test', 'blob:unknown', 'https://', '/local/file.git'])('rejects unsafe or unsupported fallback targets: %s', (reference) => {
        expect(mediaFallbackLink(reference)).toBeNull();
    });
});
