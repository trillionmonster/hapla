export type MediaKind = 'image' | 'video' | 'audio' | 'unknown';

const EXTENSION_MIME: Record<string, string> = {
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
    avif: 'image/avif', bmp: 'image/bmp', svg: 'image/svg+xml', ico: 'image/x-icon',
    mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', m4v: 'video/x-m4v', ogv: 'video/ogg',
    mp3: 'audio/mpeg', wav: 'audio/wav', flac: 'audio/flac', aac: 'audio/aac', m4a: 'audio/mp4',
    ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/opus',
};

export function inferMediaType(value: string, declaredType?: string): string {
    const reference = value.trim();
    if (/^[^/@\s]+@[^/\s]+:/.test(reference)) return 'application/octet-stream';
    if (/^[a-z][a-z0-9+.-]*:/i.test(reference)
        && !/^(?:https?|file|data|blob):/i.test(reference) && !/^[a-z]:[\\/]/i.test(reference)) return 'application/octet-stream';
    const declared = declaredType?.split(';', 1)[0].trim().toLowerCase();
    if (declared && !declared.endsWith('/unknown') && declared !== 'application/octet-stream') return declared;
    const dataType = reference.match(/^data:([^;,]+)/i)?.[1];
    if (dataType) return dataType.toLowerCase();
    if (/^blob:/i.test(reference)) return declared ?? 'application/octet-stream';
    // Only the final path segment can carry an extension. A dotted hostname,
    // query parameter or fragment says nothing about the resource's format.
    let pathname = reference.split(/[?#]/, 1)[0];
    if (/^(?:https?|file):\/\//i.test(reference)) {
        try { pathname = new URL(reference).pathname; }
        catch { return declared ?? 'application/octet-stream'; }
    }
    let basename = pathname.split(/[\\/]/).pop() ?? '';
    try { basename = decodeURIComponent(basename); } catch { /* Use the literal path. */ }
    const extension = basename.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? '';
    return EXTENSION_MIME[extension] ?? declared ?? 'application/octet-stream';
}

export function getMediaKind(value: string, declaredType?: string): MediaKind {
    const mime = inferMediaType(value, declaredType);
    if (mime.startsWith('image/')) return 'image';
    if (mime.startsWith('video/')) return 'video';
    if (mime.startsWith('audio/')) return 'audio';
    return 'unknown';
}

export function isMediaReference(value: string): boolean {
    const reference = value.trim();
    if (!reference) return false;
    if (/^data:/i.test(reference)) return getMediaKind(reference) !== 'unknown';

    // Markdown wrappers are not file paths, even if a URL query hides the
    // closing delimiter from extension detection. The Markdown parser owns
    // extracting their destinations before media classification.
    if (/^!?\[[\s\S]*\]\(/.test(reference) || reference.startsWith('<') || reference.startsWith('`')) return false;

    // A bare media reference occupies the whole line. Reject prose that merely
    // ends in a media-looking extension (for example "show me demo.mp4"). Paths
    // containing spaces remain available through normal Markdown image syntax.
    if (/\s/.test(reference)) return false;
    if (reference.startsWith('//')) return false;
    if (/^https?:\/\//i.test(reference)) {
        try {
            const url = new URL(reference);
            // Repository and blob pages are HTML, even when a repository or
            // source filename ends in .png. Only raw/download routes are media
            // candidates on GitHub; raw.githubusercontent.com remains ordinary
            // extension-based content. Explicit Markdown images can still use
            // extensionless URLs without guessing for every pasted web link.
            if (['github.com', 'www.github.com'].includes(url.hostname.toLowerCase())
                && !/^\/[^/]+\/[^/]+\/(?:raw\/|releases\/download\/)/.test(url.pathname)
                && !url.pathname.startsWith('/user-attachments/')) return false;
            if (url.hostname.toLowerCase() === 'gist.github.com') return false;
            return getMediaKind(reference) !== 'unknown';
        } catch {
            return false;
        }
    }
    // Git clone references and other URI schemes are not workspace media paths.
    if (/^[^/@\s]+@[^/\s]+:/.test(reference)) return false;
    if (/^[a-z][a-z0-9+.-]*:/i.test(reference)
        && !/^file:\/\//i.test(reference) && !/^[a-z]:[\\/]/i.test(reference)) return false;
    return getMediaKind(reference) !== 'unknown';
}
