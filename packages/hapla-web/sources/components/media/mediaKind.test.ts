import { describe, expect, it } from 'vitest';
import { getMediaKind, inferMediaType, isMediaReference } from './mediaKind';

describe('mediaKind', () => {
    it.each([
        ['photo.avif?size=2', 'image/avif', 'image'],
        ['clip.MOV', 'video/quicktime', 'video'],
        ['voice.opus#t=1', 'audio/opus', 'audio'],
        ['data:audio/ogg;base64,AAA=', 'audio/ogg', 'audio'],
    ])('classifies %s', (reference, mime, kind) => {
        expect(inferMediaType(reference)).toBe(mime);
        expect(getMediaKind(reference)).toBe(kind);
        expect(isMediaReference(reference)).toBe(true);
    });

    it('uses a trustworthy declared MIME type for extensionless URLs', () => {
        expect(getMediaKind('https://example.test/download', 'audio/mpeg')).toBe('audio');
        expect(getMediaKind('https://example.test/download', 'Image/PNG; charset=binary')).toBe('image');
        expect(getMediaKind('https://example.test/page.png', 'text/html')).toBe('unknown');
        expect(getMediaKind('https://example.test/photo.png', 'application/octet-stream')).toBe('image');
        expect(getMediaKind('https://example.test/photo', 'image/unknown')).toBe('image');
    });

    it('does not treat natural-language prose as a local media path', () => {
        expect(isMediaReference('请帮我展示一下 demo.mp4')).toBe(false);
        expect(isMediaReference('show the generated file ./demo.png')).toBe(false);
        expect(isMediaReference('./demo.png')).toBe(true);
        expect(isMediaReference('https://example.test/demo.mp4')).toBe(true);
        expect(isMediaReference('https://picsum.photos/seed/hapla/640/360')).toBe(false);
        expect(isMediaReference('https://example.test/article')).toBe(false);
        expect(isMediaReference('./README')).toBe(false);
    });

    it.each([
        '[点击视频](https://account.r2.dev/movie.mp4?signature=unchanged)',
        '![封面](https://example.test/image.png?token=unchanged)',
        '<https://example.test/movie.mp4?token=unchanged>',
        '`https://example.test/movie.mp4?token=unchanged`',
    ])('does not classify Markdown syntax as a bare workspace media reference: %s', reference => {
        expect(isMediaReference(reference)).toBe(false);
    });

    it.each([
        'https://github.com/owner/repo',
        'https://github.com/owner/repo.git',
        'https://github.com/owner/repo.name',
        'https://github.com/owner/repo.png',
        'https://github.com/owner/repo/blob/main/image.png',
        'https://github.com/owner/repo/blob/main/image.png?raw=true',
        'https://gist.github.com/owner/example.svg',
        'https://example.svg',
        'https://example.svg/',
        'https://example.test?file=image.png',
        'https://example.test/article#image.png',
        'https://example.test/file.git',
        'https://example.test/file.html',
        'https://example.test/archive.zip',
        'https://example.test/media.png/overview',
        'https://example.test/media.png/',
        'data:text/html,<img>',
        'data:application/pdf;base64,AAA=',
        'git@github.com:owner/repo.png',
        'ssh://git@github.com/owner/repo.png',
        'javascript:alert.png',
        '//cdn.example.test/image.png',
    ])('does not auto-preview a website, repository or non-media URI: %s', reference => {
        expect(isMediaReference(reference)).toBe(false);
    });

    it.each([
        'https://cdn.example.test/PHOTO.PNG?signature=abc#preview',
        'https://cdn.example.test/photo%2Epng?signature=abc',
        'https://raw.githubusercontent.com/owner/repo/main/photo.png',
        'https://github.com/owner/repo/raw/main/photo.png',
        'https://github.com/owner/repo/releases/download/v1/clip.mp4',
        '/files/public/users/owner/chat-images/photo.png',
        'file:///workspace/photo.png',
        'C:\\workspace\\photo.png',
    ])('preserves direct media, signed URLs and workspace references: %s', reference => {
        expect(isMediaReference(reference)).toBe(true);
    });

    it('does not infer a file format from the hostname, query or fragment', () => {
        for (const reference of ['https://example.svg', 'https://example.test?file=photo.png', 'https://example.test/article#photo.png', 'javascript:alert.png', 'ssh://git@github.com/owner/photo.png', 'git@github.com:owner/photo.png', 'blob:https://example.test/photo.png']) {
            expect(inferMediaType(reference)).toBe('application/octet-stream');
        }
    });
});
