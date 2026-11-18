import { describe, expect, it } from 'vitest';
import { isHttpMarkdownLink, isPotentialWorkspaceMarkdownLink, unwrapMarkdownLinkTarget } from './linkUtils';

describe('isHttpMarkdownLink', () => {
    it('unwraps Markdown destination brackets without changing signed query bytes', () => {
        const signed = 'https://cdn.example.test/clip.mp4?X-Amz-Signature=FAKE&x=%2f+1#t=2';
        expect(unwrapMarkdownLinkTarget(`<${signed}>`)).toBe(signed);
        expect(unwrapMarkdownLinkTarget(signed)).toBe(signed);
    });

    it('allows supported local links but rejects protocol-relative and clone targets', () => {
        expect(isPotentialWorkspaceMarkdownLink('C:\\work\\clip.mp4')).toBe(true);
        expect(isPotentialWorkspaceMarkdownLink('file:///work/clip.mp4')).toBe(true);
        expect(isPotentialWorkspaceMarkdownLink('./clip.mp4')).toBe(true);
        expect(isPotentialWorkspaceMarkdownLink('//cdn.example.test/clip.mp4')).toBe(false);
        expect(isPotentialWorkspaceMarkdownLink('git@github.com:example/repo.git')).toBe(false);
        expect(isPotentialWorkspaceMarkdownLink('https://github.com/example/repo.git')).toBe(false);
    });
    it('accepts http and https links', () => {
        expect(isHttpMarkdownLink('http://example.com')).toBe(true);
        expect(isHttpMarkdownLink('https://example.com/docs')).toBe(true);
        expect(isHttpMarkdownLink(' HTTPS://example.com/docs ')).toBe(true);
    });

    it('rejects non-http schemes and path-like targets', () => {
        expect(isHttpMarkdownLink('mailto:test@example.com')).toBe(false);
        expect(isHttpMarkdownLink('data:text/plain,hello')).toBe(false);
        expect(isHttpMarkdownLink('/Users/me/project/file.ts')).toBe(false);
        expect(isHttpMarkdownLink('packages/hapla-web/index.tsx')).toBe(false);
    });
});
