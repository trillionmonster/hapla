import { z } from 'zod';
import type { Readable } from 'node:stream';
import type { Fastify } from '../types';
import { directFiles } from '@/storage/directFileDelivery';
import { nasFileSource } from '@/storage/nasFileSource';
import { MAX_CLOUD_FILE_BYTES } from '@/storage/cloudFileDelivery';
import { usesLocalFileDelivery } from '../utils/localFileDelivery';

export function directFileRoutes(app: Fastify) {
    const clean = () => { void directFiles.cleanup().catch(() => undefined); };
    const timer = setInterval(clean, 60 * 60_000); timer.unref();
    app.addHook('onReady', async () => clean());
    app.addHook('onClose', async () => clearInterval(timer));
    app.get('/v1/files/delivery-mode', { preHandler: app.authenticate }, async (request, reply) => reply.header('Cache-Control', 'no-store').send({ direct: usesLocalFileDelivery(request) }));
    app.post('/v1/files/direct/resolve', { preHandler: app.authenticate, bodyLimit: 20 * 1024,
        schema: { body: z.object({ url: z.string().max(16384), downloadFilename: z.string().optional() }) } }, async (request, reply) => {
        if (!usesLocalFileDelivery(request)) return reply.code(403).send({ error: '请通过局域网地址访问' });
        return reply.header('Cache-Control', 'no-store').send(await directFiles.grantSource(request.userId, await nasFileSource.resolve(request.body.url, request.body.downloadFilename)));
    });
    app.post('/v1/files/direct/prepare', { preHandler: app.authenticate, bodyLimit: 4096,
        schema: { body: z.object({ sha256: z.string(), name: z.string(), size: z.number() }) } }, async (request, reply) => {
        return reply.header('Cache-Control', 'no-store').send(await directFiles.prepare(request.userId, request.body));
    });
    app.get('/v1/files/direct/:id', { preHandler: app.authenticate, schema: { params: z.object({ id: z.string() }) } }, async (request, reply) => reply.header('Cache-Control', 'no-store').send(await directFiles.status(request.userId, request.params.id)));
    app.register(async scope => {
        scope.addContentTypeParser('application/octet-stream', (_request, payload, done) => done(null, payload));
        scope.put('/v1/files/direct/:id/source', { onRequest: app.authenticate, bodyLimit: MAX_CLOUD_FILE_BYTES }, async (request, reply) => {
            const controller = new AbortController(); const cancel = () => controller.abort(); request.raw.once('aborted', cancel);
            try { await directFiles.upload(request.userId, (request.params as { id: string }).id, request.body as Readable, Number(request.headers['content-length']), controller.signal); return reply.code(204).send(); }
            finally { request.raw.off('aborted', cancel); }
        });
    });
}
