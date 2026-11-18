/* Workspace bytes stay in the authenticated page's encrypted RPC channel.
 * No file contents, credentials, or grants are persisted in the service worker. */
const PREFIX = '/__hapla_workspace_stream/';
const CHUNK_BYTES = 256 * 1024;
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

function ask(client, payload) {
    return new Promise((resolve, reject) => {
        const channel = new MessageChannel();
        const timer = setTimeout(() => { channel.port1.close(); reject(new Error('Workspace connection timed out')); }, 15000);
        channel.port1.onmessage = ({ data }) => {
            clearTimeout(timer);
            channel.port1.close();
            data?.error ? reject(new Error(data.error)) : resolve(data);
        };
        client.postMessage({ type: 'hapla-workspace-read', ...payload }, [channel.port2]);
    });
}

async function findOwner(token) {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    return Promise.any(windows.map(async (client) => {
        const info = await ask(client, { token, action: 'info' });
        if (!info || !Number.isSafeInteger(info.size) || info.size < 0) throw new Error('File unavailable');
        return { client, info };
    }));
}

function rangeFor(header, size) {
    if (!header) return { start: 0, end: size - 1, partial: false };
    const match = /^bytes=(\d*)-(\d*)$/.exec(header);
    if (!match || (!match[1] && !match[2]) || size === 0) return null;
    const suffix = !match[1];
    const start = suffix ? Math.max(0, size - Number(match[2])) : Number(match[1]);
    const end = suffix || !match[2] ? size - 1 : Math.min(size - 1, Number(match[2]));
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= size || end < start) return null;
    // Bound an open-ended media request; the media engine asks for the next range as needed.
    return { start, end: !match[2] ? Math.min(end, start + 2 * 1024 * 1024 - 1) : end, partial: true };
}

async function serve(request, token) {
    if (!['GET', 'HEAD'].includes(request.method)) return new Response(null, { status: 405 });
    let owner;
    try { owner = await findOwner(token); }
    catch { return new Response('File preview expired. Reopen it from the workspace.', { status: 410 }); }
    const { client, info } = owner;
    const range = rangeFor(request.headers.get('range'), info.size);
    if (!range) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${info.size}` } });
    const contentType = /^(?:image\/(?:png|jpeg|gif|webp|avif|bmp|x-icon)|audio\/[a-z0-9.+-]+|video\/[a-z0-9.+-]+|application\/pdf)$/.test(info.mimeType)
        ? info.mimeType : 'application/octet-stream';
    const name = encodeURIComponent(String(info.name || 'file').replace(/[\r\n]/g, '_')).replace(/'/g, '%27');
    const headers = {
        'Content-Type': contentType,
        'Content-Length': String(Math.max(0, range.end - range.start + 1)),
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': info.download ? "default-src 'none'; sandbox allow-downloads" : "default-src 'none'; sandbox",
        'Content-Disposition': `${info.download ? 'attachment' : 'inline'}; filename*=UTF-8''${name}`,
    };
    if (range.partial) headers['Content-Range'] = `bytes ${range.start}-${range.end}/${info.size}`;
    let offset = range.start;
    let cancelled = false;
    const body = request.method === 'HEAD' ? null : new ReadableStream({
        async pull(controller) {
            if (cancelled || request.signal.aborted) { controller.close(); return; }
            if (offset > range.end) {
                if (info.download) await ask(client, { token, action: 'complete' });
                controller.close(); return;
            }
            try {
                const length = Math.min(CHUNK_BYTES, range.end - offset + 1);
                const result = await ask(client, { token, action: 'read', offset, length });
                if (cancelled) return;
                const bytes = result?.bytes;
                if (!(bytes instanceof ArrayBuffer) || bytes.byteLength === 0 || bytes.byteLength > length) throw new Error('Invalid workspace byte range');
                offset += bytes.byteLength;
                controller.enqueue(new Uint8Array(bytes));
            } catch (error) {
                if (info.download) await ask(client, { token, action: 'error', message: error.message }).catch(() => undefined);
                if (!cancelled) controller.error(error);
            }
        },
        cancel() {
            cancelled = true;
            if (info.download) return ask(client, { token, action: 'error', message: '下载已取消' }).catch(() => undefined);
        },
    }, { highWaterMark: 1 });
    return new Response(body, { status: range.partial ? 206 : 200, headers });
}

self.addEventListener('fetch', (event) => {
    const url = new URL(event.request.url);
    if (url.origin !== self.location.origin || !url.pathname.startsWith(PREFIX)) return;
    const token = url.pathname.slice(PREFIX.length).split('/')[0];
    if (!/^[a-f0-9]{64}$/.test(token)) { event.respondWith(new Response(null, { status: 404 })); return; }
    event.respondWith(serve(event.request, token));
});
