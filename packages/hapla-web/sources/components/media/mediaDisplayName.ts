/** Derive a label only. Never use this value as the request URL: signed query
 * parameters, their ordering and their escaping must remain untouched. */
function referenceName(value: string): string | undefined {
    if (/^(?:data|blob):/i.test(value)) return undefined;
    let pathname = value.split(/[?#]/, 1)[0];
    if (/^(?:https?|file):\/\//i.test(value)) {
        try { pathname = new URL(value).pathname; } catch { return undefined; }
    }
    const name = pathname.split(/[\\/]/).pop();
    if (!name) return undefined;
    try { return decodeURIComponent(name); } catch { return name; }
}

export function getMediaDisplayName(reference: string, suppliedName?: string | null, fallback = '媒体'): string {
    const name = suppliedName?.trim();
    if (name) {
        if (name === reference || /^(?:https?|file|data|blob):/i.test(name)
            || /^(?:\/|[A-Za-z]:[\\/])/.test(name)) return referenceName(name) ?? referenceName(reference) ?? fallback;
        // Some old producers passed basename(url), including its signed query.
        // Preserve human captions, while cleaning an actual filename label.
        if (/\.[a-z0-9]{1,16}[?#]/i.test(name)) return referenceName(name) ?? fallback;
        return name;
    }
    return referenceName(reference) ?? fallback;
}

/** Captions are not always filenames. Preserve the original extension so a
 * saved video remains recognizable to the phone's Files and Photos apps. */
export function getMediaDownloadName(reference: string, suppliedName?: string | null): string {
    let name = getMediaDisplayName(reference, suppliedName, '文件')
        .replace(/[<>:"/\\|?*\x00-\x1f\x7f]/g, '_').replace(/^\.+|[.\s]+$/g, '') || '文件';
    const extension = /\.[a-z0-9]{1,12}$/i.exec(referenceName(reference) ?? '')?.[0] ?? '';
    if (extension && !/\.[a-z0-9]{1,12}$/i.test(name)) name += extension;
    const suffix = /\.[a-z0-9]{1,12}$/i.exec(name)?.[0] ?? '';
    let stem = suffix ? name.slice(0, -suffix.length) : name;
    while (new TextEncoder().encode(stem + suffix).length > 480) stem = Array.from(stem).slice(0, -1).join('');
    return stem + suffix;
}
