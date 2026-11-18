export const MAX_RENDERED_DOCUMENT_BYTES = 512 * 1024;
export const FILE_PAGE_BYTES = 128 * 1024;

export function encodeFileRoutePath(path: string): string {
    return btoa(Array.from(new TextEncoder().encode(path), (byte) => String.fromCharCode(byte)).join(''));
}
export function decodeFileRoutePath(encoded: string): string {
    try {
        const binary = atob(encoded);
        const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
        try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
        catch { return binary; } // Older URLs used Latin-1 btoa.
    } catch { return encoded; }
}

/** Static file previews have no script execution, external resources, forms, or navigations. */
export function isolatedFileDocument(source: string, svg = false): string {
    if (new TextEncoder().encode(source).byteLength > MAX_RENDERED_DOCUMENT_BYTES) throw new Error('文档较大，请使用分段源码预览');
    // Template contents are inert: parsing cannot fetch an attacker image or
    // iframe before its URL has been removed and the preview CSP is installed.
    const template = document.createElement('template');
    template.innerHTML = source;
    if (svg && !template.content.querySelector('svg')) throw new Error('SVG 格式无效，请查看源码');
    for (const element of [...template.content.querySelectorAll('*')]) {
        const tag = element.localName.toLowerCase();
        if (['script', 'noscript', 'template', 'iframe', 'object', 'embed', 'applet', 'base', 'meta', 'link', 'foreignobject', 'animate', 'animatetransform', 'animatemotion', 'set'].includes(tag)) {
            element.remove();
            continue;
        }
        for (const attribute of [...element.attributes]) {
            const name = attribute.name.toLowerCase();
            const value = attribute.value.trim();
            if (name.startsWith('on') || ['srcdoc', 'action', 'formaction', 'target', 'ping', 'srcset', 'download'].includes(name)
                || (['href', 'xlink:href', 'src', 'poster', 'background'].includes(name) && !value.startsWith('#') && !/^data:image\/(?:png|jpeg|gif|webp);base64,/i.test(value))) {
                element.removeAttribute(attribute.name);
            }
        }
    }
    const content = svg ? template.content.querySelector('svg')!.outerHTML : template.innerHTML;
    const policy = "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data:; media-src 'none'; font-src data:; connect-src 'none'; frame-src 'none'; object-src 'none'; form-action 'none'; base-uri 'none'";
    // The policy is the first parsed element; attacker-supplied metadata cannot precede or relax it.
    return `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${policy}"><meta name="referrer" content="no-referrer"><style>html{color-scheme:light;background:#fff;color:#181818}body{margin:16px;overflow-wrap:anywhere}img,svg{max-width:100%;height:auto}</style></head><body>${content}</body></html>`;
}

/** Read three lookahead bytes so a UTF-8 character crossing a page boundary appears exactly once. */
export function decodeUtf8FilePage(bytes: Uint8Array, pageBytes: number): string {
    let start = 0;
    while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start++;
    let end = Math.min(pageBytes, bytes.length);
    while (end < bytes.length && (bytes[end] & 0xc0) === 0x80) end++;
    return new TextDecoder().decode(bytes.subarray(start, end));
}

export function fileSourceRows(source: string): Array<{ line: number; continued: boolean; text: string }> {
    return source.split('\n').flatMap((line, index) => {
        const parts: Array<{ line: number; continued: boolean; text: string }> = [];
        // A minified line remains readable without creating a single enormous text layout.
        for (let start = 0; start < Math.max(1, line.length);) {
            let end = Math.min(line.length, start + 1024);
            if (end < line.length && /[\uD800-\uDBFF]/.test(line[end - 1])) end--;
            parts.push({ line: index + 1, continued: start > 0, text: line.slice(start, end) });
            start = end || 1;
        }
        return parts;
    });
}
