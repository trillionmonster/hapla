import { getMediaDisplayName } from '@/components/media/mediaDisplayName';

/** Let the browser handle the unchanged original URL. Cross-origin hosts may
 * open a viewer unless they provide Content-Disposition: attachment. A new
 * tab prevents that fallback from navigating away from the workspace. */
export function browserDownloadAttributes(uri: string, name?: string): { href: string; download: string; target: '_blank' | '_self'; rel: string } {
    if (!/^(?:https?:|blob:|data:)/i.test(uri) && !/^\/files\/(?!\/)/.test(uri)
        && !/^\/__hapla_workspace_stream\/[a-f0-9]{64}\//.test(uri)) throw new Error('不支持的下载地址');
    let attachment = false;
    try {
        const url = new URL(uri, typeof window === 'undefined' ? undefined : window.location.origin);
        attachment = url.protocol === 'https:' && url.hostname.endsWith('.r2.cloudflarestorage.com')
            && /^attachment(?:;|$)/i.test(url.searchParams.get('response-content-disposition') ?? '')
            && url.searchParams.get('response-content-type') === 'application/octet-stream';
        if (typeof window !== 'undefined' && url.origin === window.location.origin && url.pathname.startsWith('/files/') && url.searchParams.get('download') === '1') attachment = true;
    } catch { /* Relative or browser-local download. */ }
    // A signed attachment response starts a native download without replacing
    // the conversation. Same-frame navigation also avoids async popup blocking.
    return { href: uri, download: getMediaDisplayName(uri, name, '文件'), target: attachment ? '_self' : '_blank', rel: 'noopener noreferrer' };
}

export function handOffBrowserDownload(uri: string, name?: string): void {
    const attributes = browserDownloadAttributes(uri, name);
    const anchor = document.createElement('a');
    Object.assign(anchor, attributes);
    anchor.style.display = 'none';
    document.body.appendChild(anchor);
    try { anchor.click(); } finally { anchor.remove(); }
}
