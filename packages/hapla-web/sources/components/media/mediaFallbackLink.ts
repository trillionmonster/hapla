/** Unknown content stays a link; never execute an unrecognized URI scheme. */
export function mediaFallbackLink(value: string): string | null {
    const reference = value.trim();
    if (!/^https?:\/\//i.test(reference)) return null;
    try {
        const url = new URL(reference);
        return url.protocol === 'http:' || url.protocol === 'https:' ? reference : null;
    } catch {
        return null;
    }
}
