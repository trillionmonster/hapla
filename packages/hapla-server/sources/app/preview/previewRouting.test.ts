import { describe, expect, it } from 'vitest';
import { validatePreviewTarget } from '@hapla/wire';
import { runInNewContext } from 'node:vm';
import { previewHtmlBridge, previewRequestHeaders, previewResponseHeaders, previewTargetUrl } from './previewRouting';

describe('stable authenticated preview routing', () => {
    it('preserves targets, query strings and base paths without accepting another origin from a suffix', () => {
        expect(previewTargetUrl('http://127.0.0.1:5173/base/', 'assets/a.js?v=1&x=%2F')).toBe('http://127.0.0.1:5173/base/assets/a.js?v=1&x=%2F');
        expect(new URL(previewTargetUrl('http://127.0.0.1:5173/', '//other.invalid/a')).origin).toBe('http://127.0.0.1:5173');
        expect(() => validatePreviewTarget('file:///etc/passwd')).toThrow();
        expect(() => validatePreviewTarget('http://user:pass@local.test/')).toThrow();
        expect(previewTargetUrl('http://127.0.0.1:5173/base/', 'base/assets/a.js')).toBe('http://127.0.0.1:5173/base/assets/a.js');
        expect(previewTargetUrl('http://127.0.0.1:5173/base/?theme=dark', 'api?v=2')).toBe('http://127.0.0.1:5173/base/api?theme=dark&v=2');
        expect(previewTargetUrl('http://127.0.0.1:5173/base/?theme=dark', '?theme=light')).toBe('http://127.0.0.1:5173/base/?theme=light');
    });
    it('keeps account credentials and hop-specific headers out of the upstream service', () => {
        expect(previewRequestHeaders({ authorization: 'Bearer private', cookie: 'hapla_preview_auth=private; app=ok; hapla_site_access=private', connection: 'keep-alive, X-Hop', 'x-hop': 'private', 'sec-websocket-key': 'browser-key', accept: 'text/html' })).toEqual({ cookie: ' app=ok', accept: 'text/html' });
        const headers = previewResponseHeaders({ location: '/login', 'set-cookie': 'app=ok; Domain=localhost; Path=/; HttpOnly' }, 'abc', 'http://localhost:5173/');
        expect(headers.location).toBe('/preview/abc/login');
        expect(headers['set-cookie']).toEqual(['app=ok; HttpOnly; Path=/preview/abc/']);
        expect(headers['cache-control']).toBe('private, no-store');
        expect(previewRequestHeaders({ authorization: 'Basic service-auth', cookie: 'hapla_preview_grant=private; app=ok' }, true)).toEqual({ authorization: 'Basic service-auth', cookie: ' app=ok' });
    });
    it('derives WebSocket and fetch addresses from the actual browser origin', () => {
        const runtime = previewHtmlBridge('/preview/abc/', 'http://localhost:5173/');
        const requests: string[] = [];
        class Socket { constructor(url: string) { requests.push(url); } }
        class Xhr { open() {} }
        const window = { fetch: (url: string) => { requests.push(url); }, WebSocket: Socket };
        const history = { pushState() {}, replaceState() {} };
        runInNewContext(runtime.slice(8, -9), { window, URL, Request, XMLHttpRequest: Xhr, location: new URL('https://actual-browser.example:9443/preview/abc/'), history });
        window.fetch('/api?q=1'); new window.WebSocket('ws://localhost:5173/hmr');
        expect(requests).toEqual(['https://actual-browser.example:9443/preview/abc/api?q=1', 'wss://actual-browser.example:9443/preview/abc/hmr']);
    });
});
