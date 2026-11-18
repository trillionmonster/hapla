import { z } from 'zod';
import type { Readable } from 'node:stream';
import type { Fastify } from '../types';
import { cloudFiles, MAX_CLOUD_FILE_BYTES } from '@/storage/cloudFileDelivery';

export function cloudFileRoutes(app: Fastify) {
    app.post('/v1/files/cloud/resolve', { preHandler: app.authenticate, bodyLimit: 20 * 1024,
        schema: { body: z.object({ url: z.string().max(16_384), force: z.boolean().optional(), downloadFilename: z.string().min(1).max(512).optional() }) } }, async (request, reply) => {
        return reply.header('Cache-Control', 'no-store').send(await cloudFiles.resolve(request.userId, request.body.url, request.body.force, request.body.downloadFilename));
    });
    app.post('/v1/files/cloud/prepare', { preHandler: app.authenticate, bodyLimit: 4096,
        schema: { body: z.object({ sha256: z.string(), name: z.string(), size: z.number() }) } }, async (request, reply) => {
        return reply.header('Cache-Control', 'no-store').send(await cloudFiles.prepare(request.userId, request.body));
    });
    app.get('/v1/files/cloud/:id', { preHandler: app.authenticate, schema: { params: z.object({ id: z.string() }) } }, async (request, reply) => {
        return reply.header('Cache-Control', 'no-store').send(await cloudFiles.status(request.userId, request.params.id));
    });
    // A route-local streaming parser avoids the JSON/base64 upload path and
    // keeps the original body out of Fastify's memory buffers.
    app.register(async scope => {
        scope.addContentTypeParser('application/octet-stream', (_request, payload, done) => done(null, payload));
        scope.put('/v1/files/cloud/:id/source', { onRequest: app.authenticate, bodyLimit: MAX_CLOUD_FILE_BYTES }, async (request, reply) => {
            const signal = new AbortController();
            const cancel = () => signal.abort(); request.raw.once('aborted', cancel);
            try {
                await cloudFiles.upload(request.userId, (request.params as { id: string }).id, request.body as Readable, Number(request.headers['content-length']), signal.signal);
                return reply.header('Cache-Control', 'no-store').code(204).send();
            } finally { request.raw.removeListener('aborted', cancel); }
        });
    });
}
