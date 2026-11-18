const RELEASE_PATTERN = /\/_expo\/(static-[a-f0-9]{16})\//;
export const WEB_REFRESH_QUERY = '__hapla_refresh';

export type WebReleaseCheckReason =
    | 'file-preview-retry'
    | 'focus'
    | 'initial'
    | 'interval'
    | 'manual'
    | 'online'
    | 'socket-reconnected'
    | 'visible';

type WebReleaseCheckListener = (reason: WebReleaseCheckReason) => void;
const webReleaseCheckListeners = new Set<WebReleaseCheckListener>();

/**
 * Ask the single root release poller to check now. Callers only publish a
 * signal: they never reload the page, so a reconnect or retry cannot discard
 * an editor draft.
 */
export function requestWebReleaseCheck(reason: WebReleaseCheckReason): void {
    for (const listener of webReleaseCheckListeners) listener(reason);
}

export function onWebReleaseCheckRequested(listener: WebReleaseCheckListener): () => void {
    webReleaseCheckListeners.add(listener);
    return () => webReleaseCheckListeners.delete(listener);
}

export function webReleaseFromText(value: string): string | null {
    return RELEASE_PATTERN.exec(value)?.[1] ?? null;
}

export function loadedWebRelease(assetUrls: Iterable<string>): string | null {
    for (const url of assetUrls) {
        const release = webReleaseFromText(url);
        if (release) return release;
    }
    return null;
}

export async function fetchPublishedWebRelease(
    fetcher: typeof fetch,
    indexUrl: string,
    signal?: AbortSignal,
): Promise<string | null> {
    const response = await fetcher(indexUrl, {
        method: 'GET',
        cache: 'no-store',
        credentials: 'same-origin',
        headers: {
            'Cache-Control': 'no-cache',
            Pragma: 'no-cache',
        },
        signal,
    });
    if (!response.ok) throw new Error(`Web release check failed (${response.status})`);
    return webReleaseFromText(await response.text());
}

export function webReleaseChanged(loaded: string | null, published: string | null): boolean {
    return loaded !== null && published !== null && loaded !== published;
}

export function webRefreshUrl(currentUrl: string, release: string | null, nonce = Date.now()): string {
    const url = new URL(currentUrl);
    url.searchParams.set(WEB_REFRESH_QUERY, release ?? String(nonce));
    return url.toString();
}

export function removeWebRefreshMarker(currentUrl: string): string | null {
    const url = new URL(currentUrl);
    if (!url.searchParams.has(WEB_REFRESH_QUERY)) return null;
    url.searchParams.delete(WEB_REFRESH_QUERY);
    return `${url.pathname}${url.search}${url.hash}`;
}
