import { getExternalVideoPreview, ExternalVideoPreviewError } from '@/storage/externalVideoPreview';
import type { Fastify } from '../types';
import { usesLocalFileDelivery } from '../utils/localFileDelivery';
import { nasFileSource } from '@/storage/nasFileSource';
import { getVideoPreview } from '@/storage/videoPreview';
import { join } from 'node:path';

export function externalVideoPreviewRoutes(app: Fastify) {
    app.post('/v1/media/video-preview', { preHandler: app.authenticate, bodyLimit: 20 * 1024 }, async (request, reply) => {
        reply.header('Cache-Control', 'no-store').header('Vary', 'Authorization');
        const body = request.body as { url?: unknown } | null;
        if (!body || typeof body.url !== 'string') return reply.code(400).send({ error: 'A video URL is required' });
        const controller = new AbortController();
        const cancel = () => { if (!reply.raw.writableEnded) controller.abort(); };
        request.raw.once('aborted', cancel);
        reply.raw.once('close', cancel);
        try {
            if (usesLocalFileDelivery(request) && new URL(body.url).hostname.endsWith('.r2.cloudflarestorage.com')) {
                const source = await nasFileSource.resolve(body.url);
                return reply.send(await getVideoPreview(source.path, { name: source.name, cacheDirectory: join(process.env.DATA_DIR || './data', 'nas-video-previews') }));
            }
            return reply.send(await getExternalVideoPreview(request.userId, body.url, controller.signal));
        }
        catch (error) {
            const status = error instanceof ExternalVideoPreviewError ? error.statusCode : 502;
            if (error instanceof ExternalVideoPreviewError && error.retryAfterMs) reply.header('Retry-After', String(Math.ceil(error.retryAfterMs / 1000)));
            return reply.code(status).send(error instanceof ExternalVideoPreviewError
                ? { error: error.message, reason: error.reason, retryable: error.retryable, ...(error.retryAfterMs ? { retryAfterMs: error.retryAfterMs } : {}) }
                : { error: 'Video preview unavailable', reason: 'network', retryable: true, retryAfterMs: 1000 });
        } finally { request.raw.off('aborted', cancel); reply.raw.off('close', cancel); }
    });
}
