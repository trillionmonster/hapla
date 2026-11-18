import { describe, expect, it } from 'vitest';
import { resolveMediaSource } from './mediaSource';
import { getMediaDisplayName } from './mediaDisplayName';
import { parseMarkdown } from '../markdown/parseMarkdown';

const signed = 'https://cdn.example.test/render/final%20cut.MP4?X-Amz-Credential=FAKE%2F20260914%2Fregion&X-Amz-Signature=not-a-secret&part=1+2&part=%2b#t=1.25';
const options = { sessionId: 'session', sessionRoot: '/root/work' };

describe('signed media source classification', () => {
    it('retains every URL byte for requests while deriving a short display name', () => {
        const source = resolveMediaSource(signed, options);
        expect(source.url).toBe(signed);
        expect(source.mediaType).toBe('video/mp4');
        expect(source.direct).toBe(true);
        expect(source.localFile).toBeNull();
        expect(source.workspaceVideo).toBeUndefined();
        expect(source.name).toBe('final cut.MP4');
    });

    it.each([signed, `![](${signed})`, `![最终成片](<${signed}>)`])('keeps a signed Markdown media destination out of workspace RPC: %s', markdown => {
        const blocks = parseMarkdown(markdown);
        expect(blocks).toHaveLength(1);
        const block = blocks[0];if (block.type !== 'image') throw new Error('Expected one media block');
        const source = resolveMediaSource(block.url, { ...options, name: block.alt, declaredType: 'image/unknown' });
        expect(source.url).toBe(signed);expect(source.workspaceVideo).toBeUndefined();expect(source.localFile).toBeNull();
        expect(source.name).not.toContain('X-Amz');
    });

    it('keeps server upload URLs direct and local videos rooted in the session', () => {
        expect(resolveMediaSource('/files/public/users/u/chat-media/clip.mp4', options)).toMatchObject({ direct: true, localFile: null, workspaceVideo: undefined });
        expect(resolveMediaSource('./clips/final.mp4', options).workspaceVideo).toEqual({ sessionId: 'session', path: '/root/work/clips/final.mp4' });
        expect(resolveMediaSource('file:///root/work/clips/final.mp4', options).workspaceVideo).toEqual({ sessionId: 'session', path: '/root/work/clips/final.mp4' });
        expect(resolveMediaSource('../outside.mp4', options).workspaceVideo).toBeUndefined();
    });

    it('keeps Windows file paths local and preserves their target', () => {
        expect(resolveMediaSource('C:\\work\\final.mp4', { sessionId: 'windows', sessionRoot: 'C:\\work' }).workspaceVideo)
            .toEqual({ sessionId: 'windows', path: 'C:/work/final.mp4' });
    });

    it.each(['https://github.com/example/repository.git', 'https://github.com/example/photo.png', 'git@github.com:example/repository.git'])('does not invent a media preview for a repository link: %s', url => {
        expect(parseMarkdown(url).some(block => block.type === 'image')).toBe(false);
        expect(resolveMediaSource(url, options).workspaceVideo).toBeUndefined();
    });
});

describe('media display names', () => {
    it.each([undefined, signed, signed.split('/').pop()])('removes signed query/fragment data from filename-like names', name => {
        expect(getMediaDisplayName(signed, name)).toBe('final cut.MP4');
    });
    it('preserves descriptive captions and uses a safe fallback for embedded data', () => {
        expect(getMediaDisplayName(signed, '最终成片 · 第一版')).toBe('最终成片 · 第一版');
        expect(getMediaDisplayName(signed, 'Ready? Please review')).toBe('Ready? Please review');
        expect(getMediaDisplayName('data:video/mp4;base64,AAA=', undefined, '视频')).toBe('视频');
        expect(getMediaDisplayName('https://example.test/download?X-Amz-Signature=FAKE')).toBe('download');
    });
});
