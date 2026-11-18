import type { FastifyRequest } from 'fastify';
import * as path from 'node:path';
import { auth } from '@/app/auth/auth';
import { MediaAccess } from '@/app/auth/mediaAccess';
import { db } from '@/storage/db';
import { getLocalFilesDir, getStoredFileContentType } from '@/storage/files';
import { getVideoPreview, VideoPreviewBusyError } from '@/storage/videoPreview';
import { getImagePreview, ImagePreviewBusyError, ImagePreviewError } from '@/storage/imagePreview';
import type { Fastify } from '../types';
import { serveFileRange } from '../utils/serveFileRange';
import { stat } from 'node:fs/promises';
import { CLOUD_FILE_THRESHOLD_BYTES } from '@hapla/wire';
import { localCloudFiles } from '@/storage/localCloudFiles';
import { cloudFiles } from '@/storage/cloudFileDelivery';
import { directFiles } from '@/storage/directFileDelivery';
import { usesLocalFileDelivery } from '../utils/localFileDelivery';

function secure(request: FastifyRequest): boolean {
    return request.protocol === 'https' || request.headers['x-forwarded-proto']?.toString().split(',')[0].trim() === 'https';
}

export function privateFilesRoutes(app: Fastify, access: MediaAccess) {
    app.post('/v1/account/media-access', { preHandler: app.authenticate }, async (request, reply) => {
        return reply.header('Cache-Control', 'no-store')
            .header('Set-Cookie', access.issueCookie(request.userId, secure(request)))
            .code(204).send();
    });
    app.delete('/v1/account/media-access', { preHandler: app.authenticate }, async (request, reply) => {
        return reply.header('Cache-Control', 'no-store')
            .header('Set-Cookie', access.clearCookie(secure(request)))
            .code(204).send();
    });

    app.get('/files/*', async (request, reply) => {
        // Do not cache authenticated responses across account switches, even
        // for immutable paths. In particular, range responses need this too.
        reply.header('Cache-Control', 'no-store').header('Vary', 'Cookie, Authorization');
        const authorization = request.headers.authorization;
        let accountId: string | null = null;
        if (authorization) {
            if (authorization.startsWith('Bearer ') && authorization.length < 16384) {
                try { accountId = (await auth.verifyToken(authorization.slice(7)))?.userId ?? null; } catch { /* Fail closed. */ }
            }
        } else {
            accountId = access.accountId(request.headers.cookie);
        }
        if (!accountId) return reply.code(401).send({ error: 'Account authorization required' });
        const filePath = (request.params as { '*': string })['*'];
        if (/^direct\/[a-f0-9]{64}$/.test(filePath)) {
            if (!usesLocalFileDelivery(request)) return reply.code(403).send({ error: '请通过局域网地址访问' });
            const file = await directFiles.file(accountId, filePath.slice(7));
            const download = (request.query as { download?: string }).download === '1';
            reply.header('Content-Security-Policy', 'sandbox').header('X-Content-Type-Options', 'nosniff');
            if (download) reply.header('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`);
            return serveFileRange({ request, reply, fullPath: file.path, contentType: download ? 'application/octet-stream' : file.contentType, cacheControl: 'no-store' });
        }
        const record = await db.uploadedFile.findUnique({ where: { accountId_path: { accountId, path: filePath } } });
        if (!record) return reply.code(404).send({ error: 'Not found' });
        const baseDir = path.resolve(getLocalFilesDir());
        const fullPath = path.resolve(baseDir, filePath);
        if (!fullPath.startsWith(baseDir + path.sep)) return reply.code(403).send({ error: 'Forbidden' });
        const contentType = getStoredFileContentType(filePath);
        if ((request.query as { preview?: string }).preview === 'image') {
            if (!contentType.startsWith('image/') || contentType === 'image/svg+xml') return reply.code(415).send({ error: '此文件不支持图片缩略预览' });
            try {
                const preview = await getImagePreview(fullPath);
                if (!preview) return reply.code(404).send({ error: 'Not found' });
                return reply.header('Content-Type', preview.contentType).header('X-Content-Type-Options', 'nosniff')
                    .header('Content-Security-Policy', "default-src 'none'; sandbox").send(preview.data);
            } catch (error) {
                if (error instanceof ImagePreviewBusyError) return reply.header('Retry-After', '2').code(503).send({ error: '图片预览繁忙，请稍后重试' });
                if (error instanceof ImagePreviewError) return reply.code(error.statusCode).send({ error: error.message });
                throw error;
            }
        }
        if ((request.query as { preview?: string }).preview === 'video') {
            if (!contentType.startsWith('video/')) return reply.code(415).send({ error: 'Video preview requires a video file' });
            try {
                const preview = await getVideoPreview(fullPath);
                if (!preview) return reply.code(404).send({ error: 'Not found' });
                return reply.send(preview);
            } catch (error) {
                if (error instanceof VideoPreviewBusyError) return reply.header('Retry-After', '2').code(503).send({ error: 'Video preview is busy' });
                throw error;
            }
        }
        const info = await stat(fullPath);
        const query = request.query as { delivery?: string; retry?: string; download?: string };
        if (info.size > CLOUD_FILE_THRESHOLD_BYTES && !usesLocalFileDelivery(request)) {
            let delivery = await localCloudFiles.prepare(accountId, fullPath, query.retry === '1');
            if (delivery.state === 'ready' && (delivery.expiresAt ?? 0) < Date.now() + 120_000) delivery = await cloudFiles.status(accountId, delivery.id);
            if (query.delivery === '1') return reply.send(delivery);
            if (delivery.state === 'ready') {
                const url = query.download === '1'
                    ? (await cloudFiles.resolve(accountId, delivery.url!, true, delivery.name)).url
                    : delivery.url!;
                return reply.redirect(url);
            }
            return reply.header('Retry-After', '2').code(503).send({ error: delivery.error || '文件正在准备 Cloudflare 地址，请重试' });
        }
        if (query.delivery === '1') return reply.send({ size: info.size, required: false });
        if (query.download === '1') reply.header('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(filePath))}`);
        return serveFileRange({
            request, reply, fullPath, contentType, cacheControl: 'no-store',
            maxOpenEndedRangeBytes: /^(?:audio|video)\//.test(contentType) ? 2 * 1024 * 1024 : undefined,
        });
    });
}
