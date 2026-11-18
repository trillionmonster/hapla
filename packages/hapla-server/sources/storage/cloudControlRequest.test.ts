import { createServer, type RequestListener } from 'node:http';
import { Readable } from 'node:stream';
import { afterEach, expect, it } from 'vitest';
import { cloudControlRequest } from './cloudControlRequest';
const servers: ReturnType<typeof createServer>[] = [];
afterEach(async () => { for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } });
async function listen(handler: RequestListener) {
    const server = createServer(handler); servers.push(server);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    return 'http://127.0.0.1:' + (server.address() as { port: number }).port;
}
it('streams request data and preserves a bounded JSON response', async () => {
    let total = 0;
    const base = await listen((request, response) => { request.on('data', data => { total += data.length; }); request.on('end', () => { response.setHeader('Content-Type', 'application/json'); response.end('{"url":"ok"}'); }); });
    const result = await cloudControlRequest(base, { method: 'POST', body: Readable.from([Buffer.alloc(40001), Buffer.alloc(12345)]) as any });
    expect(await result.json()).toEqual({ url: 'ok' }); expect(total).toBe(52346);
});
it('cancels while waiting for headers instead of leaving the request pending', async () => {
    let started!: () => void; const seen = new Promise<void>(resolve => { started = resolve; });
    const base = await listen(() => started()); const abort = new AbortController();
    const promise = cloudControlRequest(base, { signal: abort.signal });
    await seen; abort.abort(); await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
});
it('rejects oversized control responses and never follows redirects', async () => {
    let calls = 0;
    const base = await listen((request, response) => { calls++; if (request.url === '/large') response.end(Buffer.alloc(100_000)); else { response.statusCode = 302; response.setHeader('Location', '/large'); response.end(); } });
    const redirected = await cloudControlRequest(base); expect(redirected.status).toBe(302); expect(calls).toBe(1);
    await expect(cloudControlRequest(base + '/large')).rejects.toThrow(); expect(calls).toBe(2);
});
