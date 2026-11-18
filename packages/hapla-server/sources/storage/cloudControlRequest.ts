import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { Readable } from 'node:stream';

/** Stream request bodies and bound control responses. Native HTTP avoids
 * fetch's independent header timeout truncating the NAS one-hour wait. */
export const cloudControlRequest: typeof fetch = async (input, options = {}) => {
    const url = new URL(String(input));
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Invalid cache endpoint');
    return new Promise<Response>((resolve, reject) => {
        const body = options.body;
        const headers = Object.fromEntries(new Headers(options.headers).entries());
        const req = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, {
            method: options.method ?? 'GET', headers, signal: options.signal ?? undefined,
        }, response => {
            const chunks: Buffer[] = []; let size = 0;
            response.on('data', (chunk: Buffer) => {
                size += chunk.length;
                if (size > 64 * 1024) { response.destroy(new Error('Control response too large')); return; }
                chunks.push(chunk);
            });
            response.on('error', reject);
            response.on('aborted', () => reject(new Error('Control response interrupted')));
            response.on('end', () => {
                const status = response.statusCode ?? 502;
                const resultHeaders = new Headers();
                for (const [key, value] of Object.entries(response.headers)) if (value !== undefined) resultHeaders.set(key, Array.isArray(value) ? value.join(', ') : value);
                resolve(new Response([204, 205, 304].includes(status) ? null : Buffer.concat(chunks), { status, headers: resultHeaders }));
            });
        });
        req.on('error', reject);
        if (body instanceof Readable) {
            const failure = (error: Error) => req.destroy(error);
            body.on('error', failure);
            req.on('close', () => { body.removeListener('error', failure); body.unpipe(req); if (!body.readableEnded) body.destroy(); });
            body.pipe(req);
        } else if (body === undefined || body === null || typeof body === 'string') req.end(body ?? undefined);
        else req.destroy(new Error('Unsupported cache request body'));
    });
};
