import { lstat, realpath, stat } from 'node:fs/promises';
import { basename, extname, resolve, sep } from 'node:path';
import { getMediaTypeForPath } from './mediaFiles';

export type GeneratedFileArtifact = {
    ref: string;
    name: string;
    size: number;
    mimeType?: string;
};

const MAX_ARTIFACT_BYTES = 512 * 1024 * 1024;
const MARKDOWN_LINK = /!?(?:\[[^\]]*\])\(\s*(?:<([^>]+)>|([^\s)]+))(?:\s+["'][^"']*["'])?\s*\)/g;
const STANDALONE_WORKSPACE_PATH = /^\s*((?:\.{1,2}\/|\/)[^\r\n]+?)\s*$/gm;
const MIME_BY_EXTENSION: Record<string, string> = {
    '.txt': 'text/plain', '.md': 'text/markdown', '.json': 'application/json', '.csv': 'text/csv',
    '.html': 'text/html', '.htm': 'text/html', '.svg': 'image/svg+xml', '.css': 'text/css', '.js': 'text/javascript', '.ts': 'text/typescript',
    '.pdf': 'application/pdf', '.zip': 'application/zip', '.gz': 'application/gzip', '.tar': 'application/x-tar',
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
    '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime',
};

function isWithin(root: string, path: string): boolean {
    return path === root || path.startsWith(root + sep);
}

function decodeLinkTarget(value: string): string | null {
    if (/^(?:https?|data|javascript):/i.test(value) || value.startsWith('#')) return null;
    let path = value.replace(/^file:\/\//i, '');
    try { path = decodeURIComponent(path); } catch { /* Preserve undecodable filesystem paths. */ }
    const lineSuffix = path.match(/^(.*):(\d+)(?::\d+)?$/);
    return lineSuffix?.[1] ?? path;
}

export function extractWorkspaceArtifactCandidates(text: string): string[] {
    const candidates = new Set<string>();
    for (const match of text.matchAll(MARKDOWN_LINK)) {
        const candidate = decodeLinkTarget(match[1] ?? match[2] ?? '');
        if (candidate) candidates.add(candidate);
    }
    // media-play intentionally asks agents to print each generated path on its
    // own line. Recognize that contract for files too, so media over the inline
    // limit can degrade to a downloadable artifact without forcing the model to
    // use a second, unrelated Markdown-link convention.
    for (const match of text.matchAll(STANDALONE_WORKSPACE_PATH)) {
        const candidate = decodeLinkTarget(match[1] ?? '');
        if (candidate) candidates.add(candidate);
    }
    return [...candidates];
}

export async function discoverWorkspaceFileArtifacts(text: string, workingDirectory: string, options: { includeMedia?: boolean } = {}): Promise<GeneratedFileArtifact[]> {
    const root = await realpath(resolve(workingDirectory));
    const artifacts: GeneratedFileArtifact[] = [];
    for (const candidate of extractWorkspaceArtifactCandidates(text)) {
        try {
            const lexicalPath = resolve(root, candidate);
            if (!isWithin(root, lexicalPath)) continue;
            // Media links already render in their source message. Automatic
            // media discovery owns separate generated-media collections.
            if (options.includeMedia === false && getMediaTypeForPath(lexicalPath)) continue;
            const linkInfo = await lstat(lexicalPath);
            if (linkInfo.isSymbolicLink() || !linkInfo.isFile()) continue;
            const resolvedPath = await realpath(lexicalPath);
            if (!isWithin(root, resolvedPath)) continue;
            const info = await stat(resolvedPath);
            if (info.size > MAX_ARTIFACT_BYTES) continue;
            artifacts.push({
                ref: resolvedPath,
                name: basename(resolvedPath),
                size: info.size,
                mimeType: MIME_BY_EXTENSION[extname(resolvedPath).toLowerCase()],
            });
        } catch {
            // Agent output can contain stale or illustrative links; only real files become artifacts.
        }
    }
    return artifacts;
}
