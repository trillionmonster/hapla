export type FilePreviewKind = 'image' | 'video' | 'audio' | 'pdf' | 'binary' | 'text';

const MIME_TYPES: Record<string, string> = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    avif: 'image/avif',
    bmp: 'image/bmp',
    svg: 'image/svg+xml',
    ico: 'image/x-icon',
    mp4: 'video/mp4',
    webm: 'video/webm',
    mov: 'video/quicktime',
    m4v: 'video/x-m4v',
    ogv: 'video/ogg',
    mp3: 'audio/mpeg',
    wav: 'audio/wav',
    flac: 'audio/flac',
    aac: 'audio/aac',
    m4a: 'audio/mp4',
    ogg: 'audio/ogg',
    pdf: 'application/pdf',
};

export function getFileExtension(path: string): string {
    const fileName = path.split(/[\\/]/).pop() || '';
    const dot = fileName.lastIndexOf('.');
    return dot > 0 ? fileName.slice(dot + 1).toLowerCase() : '';
}

export function getFileMimeType(path: string): string | null {
    return MIME_TYPES[getFileExtension(path)] ?? null;
}

export function getFilePreviewKind(path: string): FilePreviewKind {
    const mimeType = getFileMimeType(path);
    if (mimeType?.startsWith('image/')) return 'image';
    if (mimeType?.startsWith('video/')) return 'video';
    if (mimeType?.startsWith('audio/')) return 'audio';
    if (mimeType === 'application/pdf') return 'pdf';

    const binaryExtensions = new Set([
        'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx',
        'zip', 'tar', 'gz', 'rar', '7z',
        'bin', 'dat', 'wasm', 'class', 'o', 'so', 'dll', 'exe', 'dmg', 'deb', 'rpm',
        'woff', 'woff2', 'ttf', 'otf',
        'db', 'sqlite', 'sqlite3',
    ]);
    return binaryExtensions.has(getFileExtension(path)) ? 'binary' : 'text';
}
