import { db } from "@/storage/db";
import { getLocalFilesDir, getPublicUrl, getStoredFileContentType, putLocalFile } from "@/storage/files";
import { processImage } from "@/storage/processImage";
import { randomKey } from "@/utils/randomKey";
import * as path from "path";
import { z } from "zod";
import { type Fastify } from "../types";
import { serveFileRange } from '../utils/serveFileRange';

const uploadImageBodySchema = z.object({
    images: z.array(z.object({
        mediaType: z.string().min(1),
        data: z.string().min(1),
    })).min(1).max(10),
});

const uploadMediaBodySchema = z.object({
    media: z.array(z.object({
        mediaType: z.enum([
            'video/mp4', 'video/webm', 'video/quicktime', 'video/x-m4v', 'video/ogg',
            'audio/mpeg', 'audio/wav', 'audio/flac', 'audio/aac', 'audio/mp4', 'audio/ogg', 'audio/opus',
        ]),
        data: z.string().min(1),
    })).min(1).max(5),
});

const MEDIA_EXTENSION_BY_MIME: Record<string, string> = {
    'video/mp4': 'mp4',
    'video/webm': 'webm',
    'video/quicktime': 'mov',
    'video/x-m4v': 'm4v',
    'video/ogg': 'ogv',
    'audio/mpeg': 'mp3',
    'audio/wav': 'wav',
    'audio/flac': 'flac',
    'audio/aac': 'aac',
    'audio/mp4': 'm4a',
    'audio/ogg': 'ogg',
    'audio/opus': 'opus',
};

function decodeBase64Image(data: string) {
    const buffer = Buffer.from(data, 'base64');
    if (buffer.length === 0) {
        throw new Error('Empty image payload');
    }
    return buffer;
}

export function uploadsRoutes(app: Fastify) {
    app.post('/v1/uploads/images', {
        preHandler: app.authenticate,
        schema: {
            body: uploadImageBodySchema,
        },
    }, async (request, reply) => {
        const userId = request.userId;
        const { images } = request.body;

        try {
            const uploaded = [] as Array<{
                url: string;
                path: string;
                mediaType: string;
                width: number;
                height: number;
                thumbhash: string;
            }>;

            for (const image of images) {
                const src = decodeBase64Image(image.data);
                const processed = await processImage(src);
                const key = randomKey('chat');
                const extension = processed.format === 'png' ? 'png' : 'jpg';
                const filePath = `public/users/${userId}/chat-images/${key}.${extension}`;

                await putLocalFile(filePath, src);

                await db.uploadedFile.create({
                    data: {
                        accountId: userId,
                        path: filePath,
                        width: processed.width,
                        height: processed.height,
                        thumbhash: processed.thumbhash,
                    },
                });

                uploaded.push({
                    url: getPublicUrl(filePath),
                    path: filePath,
                    mediaType: image.mediaType,
                    width: processed.width,
                    height: processed.height,
                    thumbhash: processed.thumbhash,
                });
            }

            return reply.send({ images: uploaded });
        } catch (error) {
            request.log.error({ error }, 'Failed to upload chat images');
            return reply.code(400).send({ error: 'Failed to upload images' });
        }
    });

    app.post('/v1/uploads/media', {
        preHandler: app.authenticate,
        schema: { body: uploadMediaBodySchema },
    }, async (request, reply) => {
        const userId = request.userId;
        const { media } = request.body;
        try {
            const uploaded = [] as Array<{ url: string; path: string; mediaType: string }>;
            for (const item of media) {
                const data = Buffer.from(item.data, 'base64');
                if (data.length === 0 || data.length > 60 * 1024 * 1024) {
                    throw new Error('Media payload must be between 1 byte and 60 MiB');
                }
                const extension = MEDIA_EXTENSION_BY_MIME[item.mediaType];
                const filePath = `public/users/${userId}/chat-media/${randomKey('media')}.${extension}`;
                await putLocalFile(filePath, data);
                await db.uploadedFile.create({ data: { accountId: userId, path: filePath } });
                uploaded.push({ url: getPublicUrl(filePath), path: filePath, mediaType: item.mediaType });
            }
            return reply.send({ media: uploaded });
        } catch (error) {
            request.log.error({ error }, 'Failed to upload chat media');
            return reply.code(400).send({ error: 'Failed to upload media' });
        }
    });

    // Authenticated read endpoint. Used by hapla-cli to fetch a user's own
    // uploaded image bytes without depending on the public PUBLIC_URL being
    // reachable from the CLI host.
    app.get('/v1/uploads/files/*', {
        preHandler: app.authenticate,
    }, async (request, reply) => {
        reply.header('Cache-Control', 'no-store').header('Vary', 'Authorization');
        const userId = request.userId;
        const filePath = (request.params as { '*'?: string })['*'];
        if (!filePath) {
            return reply.code(400).send({ error: 'Missing file path' });
        }

        const record = await db.uploadedFile.findUnique({
            where: { accountId_path: { accountId: userId, path: filePath } },
        });
        if (!record) {
            return reply.code(404).send({ error: 'Not found' });
        }

        const baseDir = path.resolve(getLocalFilesDir());
        const fullPath = path.resolve(baseDir, filePath);
        if (!fullPath.startsWith(baseDir + path.sep)) {
            return reply.code(403).send({ error: 'Forbidden' });
        }
        const contentType = getStoredFileContentType(filePath);
        return serveFileRange({
            request,
            reply,
            fullPath,
            contentType,
            cacheControl: 'no-store',
            maxOpenEndedRangeBytes: /^(?:audio|video)\//.test(contentType) ? 2 * 1024 * 1024 : undefined,
        });
    });
}
