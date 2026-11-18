import { afterEach, describe, expect, it, vi } from 'vitest';
import { browserDownloadAttributes, handOffBrowserDownload } from './browserDownload';
afterEach(() => vi.unstubAllGlobals());
describe('browser-owned external downloads', () => {
    it('uses same-frame navigation for signed R2 attachments to avoid mobile popup blocking', () => {
        const uri = 'https://test.r2.cloudflarestorage.com/video.mp4?response-content-disposition=attachment%3B%20filename%3Dvideo.mp4&response-content-type=application%2Foctet-stream&X-Amz-Signature=unchanged';
        expect(browserDownloadAttributes(uri)).toMatchObject({ href: uri, target: '_self' });
        expect(browserDownloadAttributes(uri.replace('attachment', 'inline')).target).toBe('_blank');
    });
    it('hands the exact signed URL to a new browser context without fetching or changing query parameters', () => {
        const uri = 'https://bucket.r2.dev/final.mp4?X-Amz-Signature=FAKE%2fExact&x=1+2&x=%2b#t=1';
        const anchor = { style: {}, click: vi.fn(), remove: vi.fn() }; const fetch = vi.fn();
        vi.stubGlobal('fetch', fetch);
        vi.stubGlobal('document', { createElement: () => anchor, body: { appendChild: vi.fn() } });
        handOffBrowserDownload(uri);
        expect(anchor).toMatchObject({ href: uri, download: 'final.mp4', target: '_blank', rel: 'noopener noreferrer' });
        expect(anchor.click).toHaveBeenCalledTimes(1); expect(anchor.remove).toHaveBeenCalledTimes(1); expect(fetch).not.toHaveBeenCalled();
    });
    it('supports owned uploads and temporary blobs but rejects executable or arbitrary local references', () => {
        expect(browserDownloadAttributes('/files/private/final.mp4').target).toBe('_blank');
        expect(browserDownloadAttributes('blob:http://hapla.test/id', 'image.png').download).toBe('image.png');
        for (const uri of ['javascript:alert(1)', 'file:///private/key', '/home/private/key', '//evil.test/file']) expect(() => browserDownloadAttributes(uri)).toThrow();
    });
});
