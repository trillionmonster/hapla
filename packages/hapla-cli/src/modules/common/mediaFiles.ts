import { homedir } from 'node:os';
import { extname, resolve } from 'node:path';

export const GENERATED_MEDIA_ROOT = resolve(homedir(), '.codex', 'generated_images');

const MEDIA_MIME_BY_EXTENSION = new Map<string, string>([
    ['.png', 'image/png'], ['.jpg', 'image/jpeg'], ['.jpeg', 'image/jpeg'],
    ['.webp', 'image/webp'], ['.gif', 'image/gif'],
    ['.mp4', 'video/mp4'], ['.webm', 'video/webm'], ['.mov', 'video/quicktime'],
    ['.m4v', 'video/x-m4v'], ['.ogv', 'video/ogg'],
    ['.mp3', 'audio/mpeg'], ['.wav', 'audio/wav'], ['.flac', 'audio/flac'],
    ['.aac', 'audio/aac'], ['.m4a', 'audio/mp4'], ['.ogg', 'audio/ogg'],
    ['.oga', 'audio/ogg'], ['.opus', 'audio/opus'],
]);

export function getMediaTypeForPath(path: string): string | null {
    return MEDIA_MIME_BY_EXTENSION.get(extname(path).toLowerCase()) ?? null;
}
