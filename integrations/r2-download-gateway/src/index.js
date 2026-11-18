const FORWARD_REQUEST = ['range', 'if-range', 'if-match', 'if-none-match', 'if-modified-since', 'if-unmodified-since'];
const FORWARD_RESPONSE = ['content-type', 'content-length', 'content-range', 'content-disposition', 'accept-ranges', 'etag', 'last-modified'];

/** Only an existing GET capability for this exact private bucket is accepted.
 * R2 verifies the signature; this Worker has no bucket keys or read binding.
 * @param {string | null} raw
 * @param {Env} env
 */
function authorizedSource(raw, env) {
    if (!raw || raw.length > 8192) throw new Error('invalid_link');
    const origin = new URL(env.R2_ORIGIN);
    if (origin.protocol !== 'https:' || !origin.hostname.endsWith('.r2.cloudflarestorage.com') || origin.username || origin.password || origin.port || origin.pathname !== '/' || origin.search || origin.hash || !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(env.R2_BUCKET)) throw new Error('invalid_configuration');
    const source = new URL(raw);
    const prefix = `/${env.R2_BUCKET}/`;
    if (source.origin !== origin.origin || source.username || source.password || source.hash || !source.pathname.startsWith(prefix) || source.pathname.length === prefix.length) throw new Error('invalid_link');
    const query = source.searchParams;
    for (const name of ['X-Amz-Algorithm', 'X-Amz-Credential', 'X-Amz-Date', 'X-Amz-Expires', 'X-Amz-SignedHeaders', 'X-Amz-Signature']) {
        if (query.getAll(name).length !== 1) throw new Error('invalid_link');
    }
    if (query.get('X-Amz-Algorithm') !== 'AWS4-HMAC-SHA256' || query.get('X-Amz-SignedHeaders') !== 'host' || !query.get('X-Amz-Credential') || !/^[a-f0-9]{64}$/i.test(query.get('X-Amz-Signature') ?? '')) throw new Error('invalid_link');
    const date = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(query.get('X-Amz-Date') ?? '');
    const seconds = Number(query.get('X-Amz-Expires'));
    if (!date || !Number.isInteger(seconds) || seconds < 1 || seconds > 604800) throw new Error('invalid_link');
    const issued = Date.parse(`${date[1]}-${date[2]}-${date[3]}T${date[4]}:${date[5]}:${date[6]}Z`);
    if (!Number.isFinite(issued) || issued > Date.now() + 300_000) throw new Error('invalid_link');
    if (issued + seconds * 1000 <= Date.now()) throw new Error('link_expired');
    return source;
}

/** @param {Request} request @param {Env} env */
function responseHeaders(request, env) {
    const headers = new Headers({
        'Cache-Control': 'private, no-store, no-transform',
        'CDN-Cache-Control': 'no-store',
        'Cloudflare-CDN-Cache-Control': 'no-store',
        'Referrer-Policy': 'no-referrer',
        'X-Content-Type-Options': 'nosniff',
        'Vary': 'Origin',
    });
    const origin = request.headers.get('Origin');
    if (origin && env.ALLOWED_ORIGINS.split(',').map(value => value.trim()).includes(origin)) {
        headers.set('Access-Control-Allow-Origin', origin);
        headers.set('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
        headers.set('Access-Control-Allow-Headers', FORWARD_REQUEST.join(', '));
        headers.set('Access-Control-Expose-Headers', FORWARD_RESPONSE.join(', '));
    }
    return headers;
}

/** Dependency injection is limited to outbound fetch for deterministic tests.
 * @param {Request} request @param {Env} env @param {typeof fetch} upstreamFetch
 */
export async function handle(request, env, upstreamFetch = fetch) {
    const headers = responseHeaders(request, env);
    /** @param {number} status @param {string} error */
    const failure = (status, error) => {
        headers.delete('Content-Length');
        headers.delete('Content-Range');
        headers.delete('Content-Disposition');
        headers.set('Content-Type', 'application/json; charset=utf-8');
        return new Response(request.method === 'HEAD' ? null : JSON.stringify({ error }), { status, headers });
    };
    const url = new URL(request.url);
    if (url.pathname === '/health' && request.method === 'GET') {
        headers.set('Content-Type', 'application/json');
        return new Response('{"status":"ok","cache":false}', { headers });
    }
    if (url.pathname !== '/file') return failure(404, 'not_found');
    if (request.method === 'OPTIONS') return headers.has('Access-Control-Allow-Origin') ? new Response(null, { status: 204, headers }) : failure(403, 'origin_not_allowed');
    if (request.method !== 'GET' && request.method !== 'HEAD') {
        headers.set('Allow', 'GET, HEAD, OPTIONS');
        return failure(405, 'method_not_allowed');
    }
    let source;
    try {
        if (url.searchParams.getAll('url').length !== 1) throw new Error('invalid_link');
        source = authorizedSource(url.searchParams.get('url'), env);
    } catch (error) {
        const code = error instanceof Error ? error.message : 'invalid_link';
        return failure(code === 'link_expired' ? 410 : code === 'invalid_configuration' ? 503 : 400, ['link_expired', 'invalid_configuration'].includes(code) ? code : 'invalid_link');
    }
    const upstreamHeaders = new Headers();
    for (const name of FORWARD_REQUEST) {
        const value = request.headers.get(name);
        if (value) upstreamHeaders.set(name, value);
    }
    // The capability authorizes GET. A one-byte GET provides HEAD metadata
    // without attempting to reuse the GET signature with a different method.
    if (request.method === 'HEAD') upstreamHeaders.set('Range', 'bytes=0-0');
    let response;
    try {
        response = await upstreamFetch(source.toString(), {
            method: 'GET', headers: upstreamHeaders, redirect: 'manual',
            cache: 'no-store', signal: request.signal,
            cf: { cacheTtl: -1, cacheEverything: false },
        });
    } catch {
        return failure(502, 'upstream_unavailable');
    }
    // Never follow redirects or relay XML containing request/signature details.
    if (![200, 206, 304, 412, 416].includes(response.status)) {
        await response.body?.cancel();
        return failure([403, 404].includes(response.status) ? response.status : 502, response.status === 403 ? 'link_rejected' : response.status === 404 ? 'source_not_found' : 'upstream_unavailable');
    }
    for (const name of FORWARD_RESPONSE) {
        const value = response.headers.get(name);
        if (value) headers.set(name, value);
    }
    if ([304, 412, 416].includes(response.status)) {
        await response.body?.cancel();
        headers.delete('Content-Length');
        return new Response(null, { status: response.status, headers });
    }
    if (request.method === 'HEAD') {
        await response.body?.cancel();
        if (response.status === 206) {
            const match = /^bytes 0-0\/(\d+)$/.exec(headers.get('Content-Range') ?? '');
            if (!match) return failure(502, 'invalid_upstream_range');
            headers.set('Content-Length', match[1]);
        }
        headers.delete('Content-Range');
        return new Response(null, { status: 200, headers });
    }
    // This is the original response stream, not a fully buffered file or cache.
    return new Response(response.body, { status: response.status, headers });
}

/** @satisfies {ExportedHandler<Env>} */
export default {
    /** @param {Request} request @param {Env} env */
    fetch: (request, env) => handle(request, env),
};
