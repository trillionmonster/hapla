import { describe, expect, it } from 'vitest';
import { previewLink } from './previewLinks';
describe('proxy links use the browser entry point', () => {
    it('retains HTTPS and a second forwarding port, without the manager pathname', () => {
        expect(previewLink('a'.repeat(32), 'https://example.test:8843/previews?x=1')).toBe('https://example.test:8843/preview/' + 'a'.repeat(32) + '/');
    });
    it('places the key in a fragment rather than the HTTP path or query', () => {
        const url = new URL(previewLink('b'.repeat(32), 'http://localhost:22345/new', 'private-key'));
        expect(url.search).toBe(''); expect(url.pathname).not.toContain('private-key');
        expect(new URLSearchParams(url.hash.slice(1)).get('hapla-key')).toBe('private-key');
    });
});
