const DEFAULT_SERVER_URL = 'http://127.0.0.1:3005';

function isMixedContent(pageOrigin: string | undefined, candidate: string | undefined): boolean {
    if (!pageOrigin || !candidate) return false;
    try {
        return new URL(pageOrigin).protocol === 'https:' && new URL(candidate).protocol === 'http:';
    } catch {
        return false;
    }
}

/** Keep a secure proxied Web deployment from reusing an old HTTP/LAN endpoint. */
export function selectServerUrl(options: {
    stored?: string;
    configured?: string;
    browserOrigin?: string;
}): string {
    const { stored, configured, browserOrigin } = options;
    if (stored && !isMixedContent(browserOrigin, stored)) return stored;
    if (configured && !isMixedContent(browserOrigin, configured)) return configured;
    return browserOrigin || stored || configured || DEFAULT_SERVER_URL;
}

