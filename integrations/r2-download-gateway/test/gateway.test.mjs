import assert from 'node:assert/strict';
import test from 'node:test';
import { handle } from '../src/index.js';

const env = {
    R2_ORIGIN: 'https://test-account.r2.cloudflarestorage.com',
    R2_BUCKET: 'private-files',
    ALLOWED_ORIGINS: 'http://localhost:12345',
};
function signed(overrides = {}) {
    const url = new URL(env.R2_ORIGIN + '/private-files/saved/video.mp4');
    const date = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
    url.search = new URLSearchParams({ 'X-Amz-Algorithm': 'AWS4-HMAC-SHA256', 'X-Amz-Credential': 'test/auto/s3/aws4_request', 'X-Amz-Date': date, 'X-Amz-Expires': '3600', 'X-Amz-SignedHeaders': 'host', 'X-Amz-Signature': 'a'.repeat(64), ...overrides }).toString();
    return url;
}
function request(source = signed(), options = {}) {
    return new Request('https://download.example/file?url=' + encodeURIComponent(source), options);
}
const mustNotFetch = () => { throw new Error('unexpected network access'); };

test('rejects unsigned, expired, duplicate and out-of-bucket links before fetching', async () => {
    const outside = [
        'http://127.0.0.1/private-files/private',
        signed().toString().replace('test-account.', 'other-account.'),
        signed().toString().replace('/private-files/', '/another-bucket/'),
        signed().toString().replace('/saved/video.mp4', '/'),
        signed().toString().replace('https://', 'https://attacker@'),
        signed().toString() + '#fragment',
        signed().toString() + '&X-Amz-Expires=3600',
        env.R2_ORIGIN + '/private-files/video.mp4',
    ];
    for (const source of outside) assert.equal((await handle(request(source), env, mustNotFetch)).status, 400);
    assert.equal((await handle(request(signed({'X-Amz-Date':'20200101T000000Z'})), env, mustNotFetch)).status, 410);
});

test('forwards Range/If-Range, strips cookies and streams immediately without buffering', async () => {
    let controller;
    const stream = new ReadableStream({ start(value) { controller = value; } });
    let options;
    const response = await handle(request(signed(), { headers: { Range: 'bytes=100-199', 'If-Range': '"etag"', Cookie: 'private', Authorization: 'Bearer private' } }), env, async (_url, init) => {
        options = init;
        return new Response(stream, { status: 206, headers: { 'Content-Range': 'bytes 100-199/1000', 'Content-Length': '100', 'Content-Type': 'application/octet-stream', 'Content-Disposition': 'attachment; filename="video.mp4"', 'Set-Cookie': 'secret', 'Cache-Control': 'public,max-age=99999' } });
    });
    assert.equal(response.status, 206);
    assert.equal(options.headers.get('Range'), 'bytes=100-199');
    assert.equal(options.headers.get('If-Range'), '"etag"');
    assert.equal(options.headers.get('Cookie'), null);
    assert.equal(options.headers.get('Authorization'), null);
    assert.equal(options.redirect, 'manual');
    assert.equal(options.cache, 'no-store');
    assert.equal(options.cf.cacheTtl, -1);
    assert.equal(response.headers.get('Content-Range'), 'bytes 100-199/1000');
    assert.equal(response.headers.get('Content-Disposition'), 'attachment; filename="video.mp4"');
    assert.equal(response.headers.get('Set-Cookie'), null);
    assert.match(response.headers.get('Cache-Control'), /no-store/);
    const reader = response.body.getReader();
    controller.enqueue(new Uint8Array([1, 2, 3]));
    assert.deepEqual((await reader.read()).value, new Uint8Array([1, 2, 3]));
    controller.close();
    assert.equal((await reader.read()).done, true);
});

test('downstream cancellation releases the upstream stream and uses the request signal', async () => {
    let cancelled = false;
    const controller = new AbortController();
    const req = request(signed(), { signal: controller.signal });
    const response = await handle(req, env, async (_url, options) => {
        assert.equal(options.signal, req.signal);
        return new Response(new ReadableStream({ cancel() { cancelled = true; } }));
    });
    await response.body.cancel();
    assert.equal(cancelled, true);
});

test('HEAD uses a signed GET of one byte, cancels it and returns total size', async () => {
    let cancelled = false;
    const response = await handle(request(signed(), { method: 'HEAD' }), env, async (_url, options) => {
        assert.equal(options.method, 'GET');
        assert.equal(options.headers.get('Range'), 'bytes=0-0');
        return new Response(new ReadableStream({ cancel() { cancelled = true; } }), { status: 206, headers: { 'Content-Length': '1', 'Content-Range': 'bytes 0-0/14979174' } });
    });
    assert.equal(cancelled, true);
    assert.equal(response.status, 200);
    assert.equal(response.body, null);
    assert.equal(response.headers.get('Content-Length'), '14979174');
    assert.equal(response.headers.get('Content-Range'), null);
});

test('HEAD rejects malformed upstream range without stale response length', async () => {
    const response = await handle(request(signed(), { method: 'HEAD' }), env, async () => new Response('x', { status: 206, headers: { 'Content-Length': '1', 'Content-Range': 'invalid' } }));
    assert.equal(response.status, 502);
    assert.equal(response.headers.get('Content-Length'), null);
});

test('expired/tampered capabilities and redirects never bypass R2 authorization', async () => {
    for (const status of [302, 403, 404, 500]) {
        let cancelled = false;
        const response = await handle(request(), env, async () => new Response(new ReadableStream({ cancel() { cancelled = true; } }), { status, headers: { Location: 'http://127.0.0.1/secret', 'Content-Type': 'application/xml' } }));
        assert.equal(response.status, [403, 404].includes(status) ? status : 502);
        assert.equal(cancelled, true);
        assert.equal(response.headers.get('Location'), null);
        assert.match(response.headers.get('Content-Type'), /application\/json/);
    }
});

test('unsatisfiable range preserves 416 and object size without buffering error XML', async () => {
    const response = await handle(request(), env, async () => new Response('<error>private request</error>', { status: 416, headers: { 'Content-Range':'bytes */1000', 'Content-Length':'29' } }));
    assert.equal(response.status, 416);
    assert.equal(response.headers.get('Content-Range'), 'bytes */1000');
    assert.equal(response.headers.get('Content-Length'), null);
    assert.equal(await response.text(), '');
});

test('CORS is restricted to configured Hapla origins without credentials', async () => {
    const allowed = await handle(request(signed(), { method:'OPTIONS', headers: { Origin:'http://localhost:12345' } }), env, mustNotFetch);
    assert.equal(allowed.status, 204);
    assert.equal(allowed.headers.get('Access-Control-Allow-Origin'), 'http://localhost:12345');
    assert.equal(allowed.headers.get('Access-Control-Allow-Credentials'), null);
    assert.equal((await handle(request(signed(), { method:'OPTIONS', headers: { Origin:'https://another.example' } }), env, mustNotFetch)).status, 403);
    assert.equal((await handle(request(signed(), { method:'POST' }), env, mustNotFetch)).status, 405);
});
