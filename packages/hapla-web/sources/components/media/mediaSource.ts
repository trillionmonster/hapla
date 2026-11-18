import { resolveSessionFilePath } from '@/utils/sessionFileLinks';
import { isDirectMediaUrl } from './directMediaUrl';
import { inferMediaType } from './mediaKind';
import { getMediaDisplayName } from './mediaDisplayName';

/** Classify before resolving paths. An HTTP upload/CDN URL is never a path on
 * the coding machine, even if it ends in a familiar file extension. */
export function resolveMediaSource(reference: string, options: {
    sessionId?: string;
    sessionRoot?: string | null;
    name?: string | null;
    declaredType?: string;
} = {}) {
    const url = reference.trim();
    const direct = isDirectMediaUrl(url);
    const localFile = !direct && options.sessionId ? resolveSessionFilePath(url, options.sessionRoot) : null;
    const mediaType = inferMediaType(url, options.declaredType);
    const workspaceVideo = localFile?.withinSessionRoot && options.sessionId && mediaType.startsWith('video/')
        ? { sessionId: options.sessionId, path: localFile.absolutePath } : undefined;
    return { url, direct, localFile, workspaceVideo, mediaType, name: getMediaDisplayName(url, options.name) };
}
