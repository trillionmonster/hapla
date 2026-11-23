#!/usr/bin/env node

const { createReadStream, existsSync, statSync } = require('node:fs');
const { createServer } = require('node:http');
const { extname, join, resolve, sep } = require('node:path');
const httpProxy = require('http-proxy');

const host = process.env.HAPLA_WEB_HOST || '127.0.0.1';
const port = Number.parseInt(process.env.HAPLA_WEB_PORT || '12345', 10);
const root = resolve(process.env.HAPLA_WEB_DIST || join(__dirname, '..', 'packages', 'hapla-web', 'dist'));
const apiTarget = process.env.HAPLA_API_URL || 'http://127.0.0.1:3006';

if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid HAPLA_WEB_PORT: ${process.env.HAPLA_WEB_PORT}`);
}
if (!existsSync(join(root, 'index.html'))) {
    throw new Error(`Hapla Web build not found at ${root}. Run pnpm web:build first.`);
}

const mimeTypes = new Map([
    ['.css', 'text/css; charset=utf-8'],
    ['.html', 'text/html; charset=utf-8'],
    ['.ico', 'image/x-icon'],
    ['.js', 'text/javascript; charset=utf-8'],
    ['.json', 'application/json; charset=utf-8'],
    ['.map', 'application/json; charset=utf-8'],
    ['.svg', 'image/svg+xml'],
    ['.txt', 'text/plain; charset=utf-8'],
    ['.wasm', 'application/wasm'],
    ['.webp', 'image/webp'],
    ['.xml', 'application/xml; charset=utf-8'],
]);

const apiProxy = httpProxy.createProxyServer({
    target: apiTarget,
    ws: true,
    xfwd: true,
});

function isApiRequest(rawUrl) {
    let pathname;
    try {
        pathname = new URL(rawUrl || '/', 'http://localhost').pathname;
    } catch {
        return false;
    }
    return /^\/v\d+(?:\/|$)/.test(pathname)
        || pathname.startsWith('/preview/')
        || pathname.startsWith('/files/')
        || pathname === '/health';
}

apiProxy.on('error', (error, request, response) => {
    console.error(`Hapla API proxy error for ${request.url}: ${error.message}`);
    if (response && 'writeHead' in response && !response.headersSent) {
        response.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify({ error: 'Hapla API is unavailable' }));
    } else if (response && 'destroy' in response) {
        response.destroy();
    }
});

function existingFile(candidate) {
    try {
        return statSync(candidate).isFile() ? candidate : null;
    } catch {
        return null;
    }
}

function resolveRequestPath(rawUrl) {
    let pathname;
    try {
        pathname = decodeURIComponent(new URL(rawUrl || '/', 'http://localhost').pathname);
    } catch {
        return { status: 400 };
    }

    if (pathname.includes('\0')) return { status: 400 };
    const relativePath = pathname.replace(/^\/+/, '');
    const candidate = resolve(root, relativePath || 'index.html');
    if (candidate !== root && !candidate.startsWith(`${root}${sep}`)) return { status: 403 };

    const file = existingFile(candidate)
        || existingFile(`${candidate}.html`)
        || existingFile(join(candidate, 'index.html'));
    if (file) return { file, pathname, status: 200 };

    const isAssetRequest = pathname.startsWith('/_expo/')
        || pathname.startsWith('/assets/')
        || pathname.startsWith('/.well-known/')
        || extname(pathname) !== '';
    return isAssetRequest
        ? { status: 404 }
        : { file: join(root, 'index.html'), pathname, status: 200 };
}

const server = createServer((request, response) => {
    // Root-relative resources and navigations retain their preview handle.
    // Referrer scoping keeps simultaneous preview tabs independent.
    try {
        const referrer = new URL(request.headers.referer || '');
        const match = /^\/preview\/([a-f0-9]{32})(?:\/|$)/.exec(referrer.pathname);
        if (match && referrer.host === request.headers.host && !(request.url || '').startsWith('/preview/')) {
            response.writeHead(307, { Location: `/preview/${match[1]}${request.url}`, 'Cache-Control': 'no-store' });
            response.end(); return;
        }
    } catch { /* No preview referrer. */ }
    if (isApiRequest(request.url)) {
        apiProxy.web(request, response);
        return;
    }

    if (request.method !== 'GET' && request.method !== 'HEAD') {
        response.writeHead(405, { Allow: 'GET, HEAD' });
        response.end();
        return;
    }

    const resolved = resolveRequestPath(request.url);
    if (!resolved.file) {
        response.writeHead(resolved.status, { 'Content-Type': 'text/plain; charset=utf-8' });
        response.end(resolved.status === 404 ? 'Not Found' : 'Bad Request');
        return;
    }

    const acceptsGzip = /(?:^|,)\s*gzip\s*(?:,|$)/i.test(request.headers['accept-encoding'] || '');
    const gzipFile = `${resolved.file}.gz`;
    const servedFile = acceptsGzip && existsSync(gzipFile) ? gzipFile : resolved.file;
    let stats;
    try { stats = statSync(servedFile); }
    catch {
        response.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8', 'Retry-After': '1' });
        response.end('Web assets are being updated. Please retry.');
        return;
    }
    const immutable = /^\/_expo\/static-[a-f0-9]{16}\//.test(resolved.pathname) || resolved.pathname.startsWith('/assets/');
    const isHtml = extname(resolved.file) === '.html';
    const headers = {
        'Cache-Control': immutable
            ? 'public, max-age=31536000, immutable'
            : isHtml
                ? 'no-store, no-cache, must-revalidate, max-age=0'
                : 'no-cache',
        'Content-Length': stats.size,
        'Content-Type': mimeTypes.get(extname(resolved.file)) || 'application/octet-stream',
        'Cross-Origin-Opener-Policy': 'same-origin-allow-popups',
        'Referrer-Policy': 'strict-origin-when-cross-origin',
        'X-Content-Type-Options': 'nosniff',
        'X-Frame-Options': 'SAMEORIGIN',
    };
    if (isHtml) {
        headers.Pragma = 'no-cache';
        headers.Expires = '0';
        headers['Clear-Site-Data'] = '"cache"';
    }
    if (servedFile === gzipFile) {
        headers['Content-Encoding'] = 'gzip';
        headers.Vary = 'Accept-Encoding';
    }

    response.writeHead(200, headers);
    if (request.method === 'HEAD') {
        response.end();
        return;
    }
    const stream = createReadStream(servedFile);
    stream.on('error', () => response.destroy());
    stream.pipe(response);
});

server.on('upgrade', (request, socket, head) => {
    if (!isApiRequest(request.url)) {
        socket.destroy();
        return;
    }
    apiProxy.ws(request, socket, head);
});

server.listen(port, host, () => {
    console.log(`Hapla Web serving ${root} at http://${host}:${port}; proxying API to ${apiTarget}`);
});

function shutdown(signal) {
    console.log(`Received ${signal}; stopping Hapla Web.`);
    apiProxy.close();
    server.close((error) => {
        process.exitCode = error ? 1 : 0;
    });
}

process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));
