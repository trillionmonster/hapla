import { stat, readFile, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { basename, resolve, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { GENERATED_MEDIA_ROOT, getMediaTypeForPath } from '@/modules/common/mediaFiles';
import { mediaCandidateStillReady, mediaFileVersion, type TurnMediaCandidate } from '@/modules/common/turnMediaArtifacts';

export type GeneratedImageUploadAuth = {
    serverUrl: string;
    token: string;
};

export type UploadedGeneratedImage = {
    path: string;
    url: string;
    mediaType: string;
    size: number;
    digest: string;
    image?: {
        width: number;
        height: number;
        thumbhash: string;
    };
};
export type UploadedGeneratedMedia = UploadedGeneratedImage;

const MAX_GENERATED_IMAGE_BYTES = 25 * 1024 * 1024;
export const GENERATED_IMAGES_ROOT = GENERATED_MEDIA_ROOT;
function isWithinGeneratedImagesRoot(path: string): boolean {
    const resolvedPath = resolve(path);
    return resolvedPath === GENERATED_IMAGES_ROOT || resolvedPath.startsWith(GENERATED_IMAGES_ROOT + sep);
}

function getImageMediaType(path: string): string | null {
    const mediaType = getMediaTypeForPath(path);
    return mediaType?.startsWith('image/') ? mediaType : null;
}

export function getGeneratedMediaType(path: string): string | null {
    return getMediaTypeForPath(path);
}

function isWithin(root: string, path: string): boolean {
    return path === root || path.startsWith(root + sep);
}

async function resolveAllowedMediaPath(path: string, allowedRoots: string[]): Promise<string | null> {
    const resolvedPath = await realpath(resolve(path)).catch(() => null);
    if (!resolvedPath) return null;
    for (const candidateRoot of allowedRoots) {
        const root = await realpath(resolve(candidateRoot)).catch(() => null);
        if (root && isWithin(root, resolvedPath)) return resolvedPath;
    }
    return null;
}

async function stableFileData(path: string, maxBytes: number, signal?: AbortSignal) {
    const first = await stat(path).catch(() => null);
    if (!first?.isFile() || first.size <= 0 || first.size > maxBytes) return null;
    await delay(750, undefined, { signal });
    const second = await stat(path).catch(() => null);
    if (!second?.isFile() || mediaFileVersion(second) !== mediaFileVersion(first)) return null;
    const data = await readFile(path, { signal });
    const after = await stat(path).catch(() => null);
    if (!after?.isFile() || data.length !== second.size || data.length > maxBytes || mediaFileVersion(after) !== mediaFileVersion(second)) return null;
    return { info: after, data };
}

const uploadSignal = (signal?: AbortSignal) => signal
    ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000);

export function extractGeneratedMediaPaths(text: string): string[] {
    const paths = new Set<string>();
    const pathPattern = /(?:^|[\s("'`])((?:\/[^\n\r\t "'`)]+)\.(?:png|jpe?g|webp|gif|mp4|webm|mov|m4v|ogv|mp3|wav|flac|aac|m4a|ogg|oga|opus))(?:$|[\s)"'`,.!?:;])/gi;
    for (const match of text.matchAll(pathPattern)) {
        const candidate = match[1];
        if (candidate && isWithinGeneratedImagesRoot(candidate) && getGeneratedMediaType(candidate)) {
            paths.add(resolve(candidate));
        }
    }
    return Array.from(paths);
}

export function extractGeneratedImagePaths(text: string): string[] {
    const paths = new Set<string>();
    const pathPattern = /(?:^|[\s("'`])((?:\/[^\n\r\t "'`)]+)\.(?:png|jpe?g|webp|gif))(?:$|[\s)"'`,.!?:;])/gi;

    for (const match of text.matchAll(pathPattern)) {
        const candidate = match[1];
        if (candidate && isWithinGeneratedImagesRoot(candidate) && getImageMediaType(candidate)) {
            paths.add(resolve(candidate));
        }
    }

    return Array.from(paths);
}

async function uploadGeneratedImage(path: string, auth: GeneratedImageUploadAuth, allowedRoots = [GENERATED_IMAGES_ROOT], signal?: AbortSignal): Promise<UploadedGeneratedImage | null> {
    const allowedPath = await resolveAllowedMediaPath(path, allowedRoots);
    if (!allowedPath) return null;

    const mediaType = getImageMediaType(allowedPath);
    if (!mediaType) {
        return null;
    }

    const snapshot = await stableFileData(allowedPath, MAX_GENERATED_IMAGE_BYTES, signal);
    if (!snapshot) {
        return null;
    }
    const { info, data } = snapshot;
    if (!info.isFile() || info.size <= 0 || info.size > MAX_GENERATED_IMAGE_BYTES) {
        return null;
    }

    const response = await fetch(`${auth.serverUrl.replace(/\/+$/, '')}/v1/uploads/images`, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${auth.token}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            images: [{
                mediaType,
                data: data.toString('base64'),
            }],
        }),
        signal: uploadSignal(signal),
    });

    if (!response.ok) {
        throw new Error(`Failed to upload generated image: ${response.status}`);
    }

    const body = await response.json() as { images?: Array<{ url?: unknown; mediaType?: unknown; width?: unknown; height?: unknown; thumbhash?: unknown }> };
    const uploaded = body.images?.[0];
    if (!uploaded || typeof uploaded.url !== 'string') {
        throw new Error('Generated image upload response did not include a URL');
    }

    return {
        path: allowedPath,
        url: uploaded.url,
        mediaType: typeof uploaded.mediaType === 'string' ? uploaded.mediaType : mediaType,
        size: info.size,
        digest: createHash('sha256').update(data).digest('hex'),
        ...(typeof uploaded.width === 'number' && typeof uploaded.height === 'number' && typeof uploaded.thumbhash === 'string'
            ? { image: { width: uploaded.width, height: uploaded.height, thumbhash: uploaded.thumbhash } }
            : {}),
    };
}

export async function uploadGeneratedMedia(path: string, auth: GeneratedImageUploadAuth, allowedRoots = [GENERATED_IMAGES_ROOT], signal?: AbortSignal): Promise<UploadedGeneratedMedia | null> {
    const allowedPath = await resolveAllowedMediaPath(path, allowedRoots);
    const mediaType = allowedPath ? getGeneratedMediaType(allowedPath) : null;
    if (!mediaType || !allowedPath) return null;
    if (mediaType.startsWith('image/')) return uploadGeneratedImage(allowedPath, auth, allowedRoots, signal);

    const snapshot = await stableFileData(allowedPath, 60 * 1024 * 1024, signal);
    if (!snapshot) return null;
    const { info, data } = snapshot;
    const response = await fetch(`${auth.serverUrl.replace(/\/+$/, '')}/v1/uploads/media`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${auth.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ media: [{ mediaType, data: data.toString('base64') }] }),
        signal: uploadSignal(signal),
    });
    if (!response.ok) throw new Error(`Failed to upload generated media: ${response.status}`);
    const body = await response.json() as { media?: Array<{ url?: unknown; mediaType?: unknown }> };
    const uploaded = body.media?.[0];
    if (!uploaded || typeof uploaded.url !== 'string') {
        throw new Error('Generated media upload response did not include a URL');
    }
    return {
        path: allowedPath,
        url: uploaded.url,
        mediaType: typeof uploaded.mediaType === 'string' ? uploaded.mediaType : mediaType,
        size: info.size,
        digest: createHash('sha256').update(data).digest('hex'),
    };
}

/** Workspace video/audio stays on its owner machine until explicitly opened.
 * Image uploads and the provider's generated-media directory keep their
 * existing portable media URLs. No arbitrary process filenames are classified
 * as drafts or final deliverables here. */
export async function prepareGeneratedMediaArtifact(
    candidate: TurnMediaCandidate,
    auth: GeneratedImageUploadAuth,
    allowedRoots: string[],
    generatedRoot: string | null,
    signal?: AbortSignal,
): Promise<{ ref: string; name: string; size: number; mimeType: string; image?: UploadedGeneratedImage['image'] } | null> {
    const path = await resolveAllowedMediaPath(candidate.path, allowedRoots);
    if (!path || !await mediaCandidateStillReady(candidate, signal)) return null;
    const upload = candidate.mimeType.startsWith('image/') || Boolean(generatedRoot && isWithin(generatedRoot, path));
    const item = upload ? await uploadGeneratedMedia(path, auth, allowedRoots, signal) : null;
    if (upload && !item) return null;
    signal?.throwIfAborted();
    const current = await stat(path).catch(() => null);
    if (!current || mediaFileVersion(current) !== candidate.version) return null;
    return {
        ref: item?.url ?? path, name: basename(path), size: candidate.size, mimeType: candidate.mimeType,
        ...(item?.image ? { image: item.image } : {}),
    };
}

export async function uploadGeneratedMediaFiles(
    paths: string[],
    auth: GeneratedImageUploadAuth,
    allowedRoots: string[],
    options: { onUploaded?: (item: UploadedGeneratedMedia) => Promise<void> | void; signal?: AbortSignal; onError?: (error: unknown, path: string) => void } = {},
): Promise<UploadedGeneratedMedia[]> {
    const uploaded: UploadedGeneratedMedia[] = [];
    for (const path of paths) {
        options.signal?.throwIfAborted();
        try {
            const result = await uploadGeneratedMedia(path, auth, allowedRoots, options.signal);
            if (result) {
                await options.onUploaded?.(result);
                uploaded.push(result);
            }
        } catch (error) {
            if (!options.onError) throw error;
            options.onError(error, path);
        }
    }
    return uploaded;
}

export async function uploadGeneratedMediaMentionedInText(text: string, auth: GeneratedImageUploadAuth): Promise<UploadedGeneratedMedia[]> {
    const uploaded: UploadedGeneratedMedia[] = [];
    for (const path of extractGeneratedMediaPaths(text)) {
        const result = await uploadGeneratedMedia(path, auth);
        if (result) uploaded.push(result);
    }
    return uploaded;
}

export async function uploadGeneratedImagesMentionedInText(text: string, auth: GeneratedImageUploadAuth): Promise<UploadedGeneratedImage[]> {
    const uploaded: UploadedGeneratedImage[] = [];
    for (const path of extractGeneratedImagePaths(text)) {
        const result = await uploadGeneratedImage(path, auth);
        if (result) {
            uploaded.push(result);
        }
    }
    return uploaded;
}

export function generatedImagesMarkdown(images: Array<Pick<UploadedGeneratedImage, 'path' | 'url' | 'mediaType'>>): string | null {
    if (images.length === 0) {
        return null;
    }

    return images
        .map((image) => `![${basename(image.path)}](${image.url})`)
        .join('\n\n');
}

export function generatedMediaMarkdown(media: Array<Pick<UploadedGeneratedMedia, 'path' | 'url' | 'mediaType'>>): string | null {
    if (media.length === 0) return null;
    return media.map((item) => `![${basename(item.path)}](${item.url})`).join('\n\n');
}
