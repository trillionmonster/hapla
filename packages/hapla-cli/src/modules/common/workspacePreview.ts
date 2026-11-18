import { readFile, realpath, stat } from 'node:fs/promises';
import { dirname, resolve, relative, sep } from 'node:path';
import { validatePath } from './pathSecurity';

const MAX_PREVIEW_BYTES = 4 * 1024 * 1024;
const MAX_PREVIEW_RESOURCES = 80;
const MIME: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', svg: 'image/svg+xml', webp: 'image/webp', gif: 'image/gif', woff2: 'font/woff2', woff: 'font/woff', ttf: 'font/ttf', ico: 'image/x-icon' };

export function localPreviewUrl(value: string): URL {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || url.username || url.password) throw new Error('开发服务器预览仅接受 localhost 或回环地址');
    return url;
}

async function replaceAsync(source: string, expression: RegExp, replacement: (match: RegExpExecArray) => Promise<string>): Promise<string> {
    const matches = [...source.matchAll(expression)];
    let result = ''; let position = 0;
    for (const match of matches) {
        result += source.slice(position, match.index) + await replacement(match); position = match.index! + match[0].length;
        if (Buffer.byteLength(result) > MAX_PREVIEW_BYTES * 2) throw new Error('网页打包后超过预览限制');
    }
    result += source.slice(position);
    if (Buffer.byteLength(result) > MAX_PREVIEW_BYTES * 2) throw new Error('网页打包后超过预览限制');
    return result;
}

/** Build an explicit, bounded preview snapshot. All file reads follow real paths
 * within this workspace; HTTP resources stay on the chosen loopback origin. */
export async function createWorkspacePreview(workingDirectory: string, target: string): Promise<{ html: string; resources: number }> {
    if (typeof target !== 'string' || !target.trim() || target.length > 4096) throw new Error('请输入 HTML 文件路径或开发服务器地址');
    const root = await realpath(workingDirectory);
    const http = /^https?:\/\//i.test(target);
    const initial = http ? localPreviewUrl(target).toString() : resolve(workingDirectory, target);
    if (!http && !/\.html?$/i.test(target)) throw new Error('请选择 .html 或 .htm 文件');
    let bytes = 0; let resources = 0;
    const loaded = new Map<string, Promise<Buffer>>();
    const moduleCache = new Map<string, string>();
    const deadline = AbortSignal.timeout(20_000);
    const locate = (value: string, from: string) => {
        if (/^(?:data:|blob:|#)/i.test(value)) return null;
        if (http) { const next = new URL(value, from); return next.origin === new URL(initial).origin ? next.toString() : null; }
        if (/^(?:[a-z]+:|\/\/)/i.test(value)) return null;
        return resolve(value.startsWith('/') ? root : dirname(from), value.replace(/^\//, '').split(/[?#]/)[0]);
    };
    const load = (location: string): Promise<Buffer> => {
        const existing = loaded.get(location); if (existing) return existing;
        if (++resources > MAX_PREVIEW_RESOURCES) throw new Error('网页资源较多，请使用浏览器打开开发服务器');
        const pending = (async () => {
            let body: Buffer;
            if (http) {
                const response = await fetch(location, { redirect: 'manual', signal: AbortSignal.any([deadline, AbortSignal.timeout(10_000)]) });
                if (!response.ok) { await response.body?.cancel(); throw new Error(`网页资源无法读取 (${response.status})`); }
                const chunks: Buffer[] = [];
                if (!response.body) throw new Error('网页资源为空');
                for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
                    bytes += chunk.byteLength;
                    if (bytes > MAX_PREVIEW_BYTES) throw new Error('网页超过 4 MiB 预览限制');
                    chunks.push(Buffer.from(chunk));
                }
                body = Buffer.concat(chunks);
            } else {
                const validation = validatePath(location, root); if (!validation.valid) throw new Error('网页资源超出当前工作区');
                const path = await realpath(location);
                const inside = relative(root, path); if (inside.startsWith(`..${sep}`) || inside === '..' || inside.startsWith(sep)) throw new Error('网页资源链接超出当前工作区');
                const info = await stat(path); if (!info.isFile() || bytes + info.size > MAX_PREVIEW_BYTES) throw new Error('网页超过 4 MiB 预览限制');
                body = await readFile(path); bytes += body.length;
                if (bytes > MAX_PREVIEW_BYTES) throw new Error('网页超过 4 MiB 预览限制');
            }
            return body;
        })();
        loaded.set(location, pending); return pending;
    };
    const dataResource = async (value: string, from: string): Promise<string> => {
        const location = locate(value, from); if (!location) return value;
        const extension = location.split(/[?#]/)[0].split('.').pop()?.toLowerCase() ?? '';
        return `data:${MIME[extension] || 'application/octet-stream'};base64,${(await load(location)).toString('base64')}`;
    };
    const css = async (source: string, from: string, depth = 0): Promise<string> => {
        if (depth > 8) throw new Error('样式表引用层级过深');
        let result = await replaceAsync(source, /@import\s+(?:url\(\s*)?["']([^"']+)["']\s*\)?\s*([^;]*);/gi, async match => {
            const location = locate(match[1], from); if (!location) return match[0];
            const content = await css((await load(location)).toString('utf8'), location, depth + 1);
            return match[2].trim() ? `@media ${match[2]}{${content}}` : content;
        });
        result = await replaceAsync(result, /url\(\s*["']?([^"')]+)["']?\s*\)/gi, async match => `url("${await dataResource(match[1].trim(), from)}")`);
        return result;
    };
    const rewriteImports = async (source: string, from: string, ancestors: Set<string>): Promise<string> => replaceAsync(source, /((?:\bimport\s*(?:[^'";]{0,400}?\s+from\s*)?|\bexport\s+[^'";]{0,400}?\s+from\s*|\bimport\s*\(\s*)['"])([^'"]+)(['"])/g, async match => {
        if (!/^(?:\.|\/|https?:)/.test(match[2])) return match[0];
        const imported = locate(match[2], from); if (!imported) return match[0];
        return `${match[1]}${await script(imported, ancestors)}${match[3]}`;
    });
    const script = async (location: string, ancestors = new Set<string>()): Promise<string> => {
        const existing = moduleCache.get(location); if (existing) return existing;
        if (ancestors.has(location)) throw new Error('网页包含循环模块引用，请在浏览器打开开发服务器');
        const nextAncestors = new Set(ancestors).add(location);
        const source = await rewriteImports((await load(location)).toString('utf8'), location, nextAncestors);
        const url = `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
        moduleCache.set(location, url); return url;
    };
    let html = (await load(initial)).toString('utf8');
    html = html.replace(/<base\b[^>]*>/gi, '');
    html = await replaceAsync(html, /<script\b([^>]*?)\bsrc\s*=\s*(["'])(.*?)\2([^>]*)>\s*<\/script\s*>/gi, async match => {
        const location = locate(match[3], initial); if (!location) return match[0];
        return `<script${match[1]}src="${await script(location)}"${match[4].replace(/\s+(?:integrity|crossorigin)\s*=\s*(["']).*?\1/gi, '')}></script>`;
    });
    html = await replaceAsync(html, /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi, async match => {
        if (/\bsrc\s*=/i.test(match[1]) || !/\btype\s*=\s*['"]module['"]/i.test(match[1])) return match[0];
        return `<script${match[1]}>${await rewriteImports(match[2], initial, new Set())}</script>`;
    });
    html = await replaceAsync(html, /<style\b([^>]*)>([\s\S]*?)<\/style\s*>/gi, async match => `<style${match[1]}>${(await css(match[2], initial)).replace(/<\/style/gi, '<\\/style')}</style>`);
    html = await replaceAsync(html, /<link\b([^>]*?)>/gi, async match => {
        if (!/\brel\s*=\s*["']stylesheet["']/i.test(match[1])) return match[0];
        const href = match[1].match(/\bhref\s*=\s*(["'])(.*?)\1/i)?.[2];
        const location = href ? locate(href, initial) : null; if (!location) return match[0];
        return `<style>${(await css((await load(location)).toString('utf8'), location)).replace(/<\/style/gi, '<\\/style')}</style>`;
    });
    html = await replaceAsync(html, /(<(?:img|source|video)\b[^>]*?\b(?:src|poster)\s*=\s*)(["'])(.*?)\2/gi, async match => `${match[1]}${match[2]}${await dataResource(match[3], initial)}${match[2]}`);
    const policy = "default-src 'none'; script-src 'unsafe-inline' data: blob: https: http:; style-src 'unsafe-inline' data: https: http:; img-src data: blob: https: http:; font-src data: https: http:; media-src data: blob: https: http:; connect-src https: http: wss: ws:; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'";
    const head = `<meta http-equiv="Content-Security-Policy" content="${policy}"><meta name="referrer" content="no-referrer">`;
    html = /<head\b[^>]*>/i.test(html) ? html.replace(/<head\b[^>]*>/i, match => match + head) : `<!doctype html><html><head>${head}</head><body>${html}</body></html>`;
    if (Buffer.byteLength(html) > MAX_PREVIEW_BYTES * 2) throw new Error('网页打包后超过预览限制');
    return { html, resources };
}
