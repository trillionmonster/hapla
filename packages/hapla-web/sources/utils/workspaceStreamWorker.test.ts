import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { MessageChannel } from 'node:worker_threads';
import { describe, expect, it } from 'vitest';
const source = readFileSync(new URL('../../public/workspace-stream-sw.js', import.meta.url), 'utf8');
const token = 'a'.repeat(64);

function worker(size: number, download = false) {
    const handlers: Record<string, (event: any) => void> = {};
    const reads: Array<{ offset: number; length: number }> = [];
    const actions: string[] = [];
    let available = true;
    const client = { postMessage(data: any, ports: any[]) {
        const port = ports[0]; actions.push(data.action);
        if (!available) { port.postMessage({ error: 'expired' }); port.close(); return; }
        if (data.action === 'info') port.postMessage({ size, name: '中文\r\n.pdf', mimeType: 'application/pdf', download });
        else if (data.action === 'read') {
            reads.push({ offset: data.offset, length: data.length });
            const bytes = Uint8Array.from({ length: data.length }, (_, i) => (data.offset + i) % 251).buffer;
            port.postMessage({ bytes }, [bytes]);
        } else port.postMessage({ ok: true });
        port.close();
    } };
    runInNewContext(source, { self: { location: { origin: 'https://workspace.test' }, addEventListener: (name: string, handler: any) => { handlers[name] = handler; }, clients: { matchAll: async () => [client] } }, URL, Request, Response, ReadableStream, MessageChannel, ArrayBuffer, Uint8Array, setTimeout, clearTimeout });
    return { reads, actions, expire: () => { available = false; }, fetch: (range?: string, method = 'GET') => {
        let response: Promise<Response>;
        handlers.fetch({ request: new Request(`https://workspace.test/__hapla_workspace_stream/${token}/file.pdf`, { method, headers: range ? { Range: range } : undefined }), respondWith: (value: Promise<Response>) => { response = value; } });
        return response!;
    } };
}

describe('workspace service worker streaming', () => {
    it('streams exact bounded ranges with safe response headers', async () => {
        const fixture = worker(4 * 1024 * 1024);
        const response = await fixture.fetch('bytes=900000-1600000');
        expect(response.status).toBe(206);
        expect(response.headers.get('content-range')).toBe('bytes 900000-1600000/4194304');
        const bytes = new Uint8Array(await response.arrayBuffer());
        expect(bytes.length).toBe(700001);
        expect(bytes.every((byte, i) => byte === (900000 + i) % 251)).toBe(true);
        expect(fixture.reads.every(read => read.length <= 256 * 1024)).toBe(true);
        expect(response.headers.get('content-security-policy')).toContain('sandbox');
        expect(response.headers.get('content-disposition')).not.toMatch(/[\r\n]/);
    });
    it('bounds open ranges, supports suffix and HEAD, and rejects invalid ranges', async () => {
        const fixture = worker(10 * 1024 * 1024);
        const open = await fixture.fetch('bytes=0-');
        expect(open.headers.get('content-length')).toBe(String(2 * 1024 * 1024));
        await open.body?.cancel();
        const suffix = await fixture.fetch('bytes=-10');
        expect(suffix.headers.get('content-range')).toBe('bytes 10485750-10485759/10485760');
        await suffix.arrayBuffer();
        const before = fixture.reads.length;
        expect((await fixture.fetch(undefined, 'HEAD')).body).toBeNull();
        expect(fixture.reads).toHaveLength(before);
        for (const range of ['bytes=-0', 'bytes=20-10', 'bytes=99999999-', 'bytes=0-2,5-8']) expect((await fixture.fetch(range)).status).toBe(416);
    });
    it('rechecks capability ownership and handles zero byte downloads', async () => {
        const fixture = worker(0, true);
        const response = await fixture.fetch();
        expect((await response.arrayBuffer()).byteLength).toBe(0);
        expect(fixture.actions).toContain('complete');
        fixture.expire();
        expect((await fixture.fetch()).status).toBe(410);
    });
});
