import fastify, { type FastifyInstance } from 'fastify';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseByteRange, serveFileRange } from './serveFileRange';

let app: FastifyInstance | null = null;
let temporaryDirectory: string | null = null;

afterEach(async () => {
    await app?.close();
    if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true });
    app = null;
    temporaryDirectory = null;
});

describe('parseByteRange', () => {
    it('parses bounded, open-ended, and suffix ranges', () => {
        expect(parseByteRange('bytes=10-19', 100)).toEqual({ start: 10, end: 19 });
        expect(parseByteRange('bytes=90-', 100)).toEqual({ start: 90, end: 99 });
        expect(parseByteRange('bytes=-12', 100)).toEqual({ start: 88, end: 99 });
    });
    it('clamps values to the file size', () => {
        expect(parseByteRange('bytes=95-999', 100)).toEqual({ start: 95, end: 99 });
        expect(parseByteRange('bytes=-999', 100)).toEqual({ start: 0, end: 99 });
    });
    it('rejects malformed, multiple, reversed, and out-of-bounds ranges', () => {
        expect(parseByteRange('items=0-1', 100)).toBe('unsatisfiable');
        expect(parseByteRange('bytes=0-1,3-4', 100)).toBe('unsatisfiable');
        expect(parseByteRange('bytes=30-20', 100)).toBe('unsatisfiable');
        expect(parseByteRange('bytes=100-', 100)).toBe('unsatisfiable');
        expect(parseByteRange('bytes=-0', 100)).toBe('unsatisfiable');
    });
    it('returns null without a Range header', () => {
        expect(parseByteRange(undefined, 100)).toBeNull();
    });

    it('serves exact bytes with 200, 206, and 416 responses', async () => {
        temporaryDirectory = await mkdtemp(join(tmpdir(), 'hapla-range-'));
        const filePath = join(temporaryDirectory, 'sample.bin');
        await writeFile(filePath, Buffer.from('0123456789'));
        app = fastify();
        app.get('/sample', (request, reply) => serveFileRange({
            request,
            reply,
            fullPath: filePath,
            contentType: 'application/octet-stream',
            cacheControl: 'public, max-age=60',
        }));

        const whole = await app.inject({ method: 'GET', url: '/sample' });
        expect(whole.statusCode).toBe(200);
        expect(whole.headers['accept-ranges']).toBe('bytes');
        expect(whole.headers['content-length']).toBe('10');
        expect(whole.body).toBe('0123456789');

        const middle = await app.inject({ method: 'GET', url: '/sample', headers: { range: 'bytes=3-6' } });
        expect(middle.statusCode).toBe(206);
        expect(middle.headers['content-range']).toBe('bytes 3-6/10');
        expect(middle.headers['content-length']).toBe('4');
        expect(middle.body).toBe('3456');

        const invalid = await app.inject({ method: 'GET', url: '/sample', headers: { range: 'bytes=20-' } });
        expect(invalid.statusCode).toBe(416);
        expect(invalid.headers['content-range']).toBe('bytes */10');
    });

    it('caps open-ended media ranges while preserving explicit ranges and whole downloads', async () => {
        temporaryDirectory = await mkdtemp(join(tmpdir(), 'hapla-range-cap-'));
        const filePath = join(temporaryDirectory, 'sample.bin');
        await writeFile(filePath, Buffer.from('0123456789'));
        app = fastify();
        app.get('/sample', (request, reply) => serveFileRange({
            request,
            reply,
            fullPath: filePath,
            contentType: 'video/mp4',
            cacheControl: 'public, max-age=60',
            maxOpenEndedRangeBytes: 4,
        }));

        const openEnded = await app.inject({ method: 'GET', url: '/sample', headers: { range: 'bytes=2-' } });
        expect(openEnded.statusCode).toBe(206);
        expect(openEnded.headers['content-range']).toBe('bytes 2-5/10');
        expect(openEnded.headers['content-length']).toBe('4');
        expect(openEnded.body).toBe('2345');

        const explicit = await app.inject({ method: 'GET', url: '/sample', headers: { range: 'bytes=2-8' } });
        expect(explicit.headers['content-range']).toBe('bytes 2-8/10');
        expect(explicit.body).toBe('2345678');

        const whole = await app.inject({ method: 'GET', url: '/sample' });
        expect(whole.statusCode).toBe(200);
        expect(whole.body).toBe('0123456789');
    });
});
