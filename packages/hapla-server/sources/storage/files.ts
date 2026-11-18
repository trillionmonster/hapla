import * as fs from 'fs';
import * as path from 'path';

const dataDir = process.env.DATA_DIR || './data';
const localFilesDir = path.join(dataDir, 'files');

export async function loadFiles() {
    fs.mkdirSync(localFilesDir, { recursive: true });
}

export function getPublicUrl(filePath: string) {
    // Prefer a same-origin relative URL for browsers. PUBLIC_URL is only needed
    // by clients such as the CLI that do not have a browser origin.
    const baseUrl = process.env.PUBLIC_URL ?? '';
    return `${baseUrl}/files/${filePath}`;
}

export function getLocalFilesDir() {
    return localFilesDir;
}

export function getStoredFileContentType(filePath: string): string {
    const extension = path.extname(filePath).toLowerCase();
    return ({
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.webp': 'image/webp',
        '.gif': 'image/gif',
        '.mp4': 'video/mp4',
        '.webm': 'video/webm',
        '.mov': 'video/quicktime',
        '.m4v': 'video/x-m4v',
        '.ogv': 'video/ogg',
        '.mp3': 'audio/mpeg',
        '.wav': 'audio/wav',
        '.flac': 'audio/flac',
        '.aac': 'audio/aac',
        '.m4a': 'audio/mp4',
        '.ogg': 'audio/ogg',
        '.oga': 'audio/ogg',
        '.opus': 'audio/opus',
    } as Record<string, string>)[extension] || 'application/octet-stream';
}

export async function putLocalFile(filePath: string, data: Buffer) {
    const fullPath = path.join(localFilesDir, filePath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, data);
}

export type ImageRef = {
    width: number;
    height: number;
    thumbhash: string;
    path: string;
}
