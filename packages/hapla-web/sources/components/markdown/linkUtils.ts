const HTTP_URL_PATTERN = /^https?:\/\//i;

export function isHttpMarkdownLink(url: string): boolean {
    return HTTP_URL_PATTERN.test(url.trim());
}

/** CommonMark angle brackets delimit a destination; they are not URL bytes. */
export function unwrapMarkdownLinkTarget(value: string): string {
    const target = value.trim();
    return target.startsWith('<') && target.endsWith('>') ? target.slice(1, -1) : target;
}

const UNSAFE_SCHEME_PATTERN = /^(?:javascript|data|vbscript):/i;
const OTHER_SCHEME_PATTERN = /^[a-z][a-z0-9+.-]*:/i;

export function isPotentialWorkspaceMarkdownLink(url: string): boolean {
    const value = url.trim();
    if (!value || value.startsWith('#') || UNSAFE_SCHEME_PATTERN.test(value)) return false;
    if (value.startsWith('//') || /^[^/@\s]+@[^/\s]+:/.test(value)) return false;
    return !OTHER_SCHEME_PATTERN.test(value) || /^file:\/\//i.test(value) || /^[a-z]:[\\/]/i.test(value);
}
