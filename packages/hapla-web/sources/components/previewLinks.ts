export function previewLink(handle: string, location: string, key?: string): string {
    if (!/^[a-f0-9]{32}$/.test(handle)) throw new Error('无效的代理入口');
    const url = new URL(`/preview/${handle}/`, location);
    if (key) url.hash = new URLSearchParams({ 'hapla-key': key }).toString();
    return url.toString();
}
