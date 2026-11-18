/** Match the server's restricted object-storage preview route. Playback always
 * keeps the original URL; this route returns only facts and a small poster. */
export function supportsServerVideoPreview(uri: string): boolean {
    try {
        const url = new URL(uri);
        return url.protocol === 'https:' && (!url.port || url.port === '443') && !url.username && !url.password
            && /\.(?:r2\.cloudflarestorage\.com|r2\.dev|amazonaws\.com)$/i.test(url.hostname)
            && /\.(?:mp4|mov|m4v)$/i.test(url.pathname);
    } catch { return false; }
}

export async function loadServerVideoPreview(uri: string, signal: AbortSignal): Promise<unknown> {
    const { apiSocket } = await import('@/sync/apiSocket');
    if (signal.aborted) throw new DOMException('Cancelled', 'AbortError');
    try {
        const response = await apiSocket.request('/v1/media/video-preview', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url: uri }), cache: 'no-store', signal,
        });
        if (response.ok) return await response.json();
        // The card retries transient failures while visible. Returning the
        // reason also avoids poisoning the cache for 30 seconds after a 503.
        if (response.status === 503 || response.status === 429) {
            const seconds = Number(response.headers?.get('Retry-After'));
            return { status: 'unavailable', reason: 'preview_busy', retryable: true,
                retryAfterMs: seconds > 0 ? Math.min(5_000, Math.max(250, seconds * 1000)) : 1_000 };
        }
        return { status: 'unavailable', reason: 'invalid_response', retryable: response.status >= 500, retryAfterMs: 1_000 };
    } catch (error) {
        if (signal.aborted) throw error;
        return { status: 'unavailable', reason: 'network', retryable: true, retryAfterMs: 1_000 };
    }
}
