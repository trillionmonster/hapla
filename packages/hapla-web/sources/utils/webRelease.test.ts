import { describe, expect, it, vi } from 'vitest';
import {
    fetchPublishedWebRelease,
    loadedWebRelease,
    onWebReleaseCheckRequested,
    removeWebRefreshMarker,
    requestWebReleaseCheck,
    webRefreshUrl,
    webReleaseChanged,
    webReleaseFromText,
} from './webRelease';

const OLD = 'static-1111111111111111';
const NEW = 'static-2222222222222222';

describe('web release detection', () => {
    it('reads the content-addressed release from assets and the published HTML', () => {
        expect(loadedWebRelease([
            'https://hapla.example/favicon.ico',
            `https://hapla.example/_expo/${OLD}/js/web/index.js`,
        ])).toBe(OLD);
        expect(webReleaseFromText(`<script src="/_expo/${NEW}/js/web/index.js"></script>`)).toBe(NEW);
    });

    it('only reports an update when both release identities are known and differ', () => {
        expect(webReleaseChanged(OLD, NEW)).toBe(true);
        expect(webReleaseChanged(OLD, OLD)).toBe(false);
        expect(webReleaseChanged(null, NEW)).toBe(false);
        expect(webReleaseChanged(OLD, null)).toBe(false);
    });

    it('fetches the stable same-origin entry without accepting a cached response', async () => {
        const fetcher = vi.fn(async () => new Response(
            `<link href="/_expo/${NEW}/css/theme.css">`,
            { status: 200 },
        ));
        await expect(fetchPublishedWebRelease(fetcher as typeof fetch, '/index.html')).resolves.toBe(NEW);
        expect(fetcher).toHaveBeenCalledWith('/index.html', expect.objectContaining({
            cache: 'no-store',
            credentials: 'same-origin',
            headers: expect.objectContaining({ 'Cache-Control': 'no-cache' }),
        }));
    });

    it('rejects failed entry responses instead of presenting a false update', async () => {
        const fetcher = vi.fn(async () => new Response('upstream unavailable', { status: 502 }));
        await expect(fetchPublishedWebRelease(fetcher as typeof fetch, '/index.html')).rejects.toThrow('(502)');
    });

    it('cache-busts a manual refresh while preserving and then removing route parameters', () => {
        const refreshed = webRefreshUrl(
            'http://203.0.113.10:12345/session/s1/file?path=REPORT.md#source',
            NEW,
        );
        const url = new URL(refreshed);
        expect(url.searchParams.get('path')).toBe('REPORT.md');
        expect(url.searchParams.get('__hapla_refresh')).toBe(NEW);
        expect(removeWebRefreshMarker(refreshed)).toBe('/session/s1/file?path=REPORT.md#source');
        expect(removeWebRefreshMarker('http://hapla.example/session/s1')).toBeNull();
    });

    it('routes reconnect and file retry checks through the root poller without reloading', () => {
        const listener = vi.fn();
        const unsubscribe = onWebReleaseCheckRequested(listener);
        requestWebReleaseCheck('socket-reconnected');
        requestWebReleaseCheck('file-preview-retry');
        expect(listener.mock.calls).toEqual([
            ['socket-reconnected'],
            ['file-preview-retry'],
        ]);
        unsubscribe();
        requestWebReleaseCheck('manual');
        expect(listener).toHaveBeenCalledTimes(2);
    });
});
