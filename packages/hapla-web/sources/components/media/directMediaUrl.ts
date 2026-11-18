/**
 * URLs that the browser can load directly. Root-relative `/files/*` values are
 * server upload URLs, not absolute paths on the coding machine.
 */
export function isDirectMediaUrl(value: string): boolean {
    return /^(?:https?:|data:|blob:)/i.test(value)
        || /^\/files\/(?!\/)[^\s]+/.test(value);
}
