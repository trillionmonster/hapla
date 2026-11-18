import { lstat, readdir, realpath, stat } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { GENERATED_MEDIA_ROOT, getMediaTypeForPath } from './mediaFiles';
import { parseVideoProbe, runVideoPreviewProcess } from './workspaceVideoPreview';

const IGNORED_DIRECTORIES = new Set([
    '.git', '.hg', '.svn', '.cache', '.expo', '.next', '.nuxt', '.turbo',
    '.runtime', '.hapla', '.happy', '.codex',
    'node_modules', 'dist', 'build', 'coverage', 'target', 'vendor',
]);
const MAX_SCAN_ENTRIES = 20_000;
const MAX_SCAN_DEPTH = 8;
const STABILITY_DELAY_MS = 750;

export type TurnMediaBaseline = {
    roots: string[];
    fingerprints: Map<string, string>;
};

export type TurnMediaArtifactOptions = {
    workspaceRoot: string;
    threadId?: string | null;
    generatedMediaRoot?: string;
    modifiedBefore?: number;
};

function isWithin(root: string, path: string): boolean {
    return path === root || path.startsWith(root + sep);
}

export function mediaFileVersion(info: { size: number; mtimeMs: number; ctimeMs: number; ino: number | bigint; dev: number | bigint }): string {
    return `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
}

async function resolveRoots(options: TurnMediaArtifactOptions): Promise<string[]> {
    const candidates = [resolve(options.workspaceRoot)];
    if (options.threadId && /^[a-zA-Z0-9_-]{1,160}$/.test(options.threadId)) {
        candidates.push(resolve(options.generatedMediaRoot ?? GENERATED_MEDIA_ROOT, options.threadId));
    }
    const roots = new Set<string>();
    for (const candidate of candidates) {
        const root = await realpath(candidate).catch(() => null);
        if (root) roots.add(root);
    }
    return [...roots];
}

async function scanMediaFiles(roots: string[]): Promise<Map<string, string>> {
    const found = new Map<string, string>();
    let visitedEntries = 0;

    const visit = async (root: string, directory: string, depth: number): Promise<void> => {
        if (depth > MAX_SCAN_DEPTH || visitedEntries >= MAX_SCAN_ENTRIES) return;
        const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
        entries.sort((left, right) => left.name.localeCompare(right.name));
        for (const entry of entries) {
            if (visitedEntries >= MAX_SCAN_ENTRIES) return;
            visitedEntries += 1;
            const path = resolve(directory, entry.name);
            if (entry.isDirectory()) {
                if (!IGNORED_DIRECTORIES.has(entry.name)) await visit(root, path, depth + 1);
                continue;
            }
            if (!entry.isFile() || !getMediaTypeForPath(path)) continue;
            const info = await stat(path).catch(() => null);
            if (info?.isFile() && info.size > 0) found.set(path, mediaFileVersion(info));
        }
    };

    for (const root of roots) await visit(root, root, 0);
    return found;
}

async function regularFileInfo(path: string, roots: string[]) {
    const firstLink = await lstat(path).catch(() => null);
    if (!firstLink?.isFile() || firstLink.isSymbolicLink()) return null;
    const real = await realpath(path).catch(() => null);
    if (!real || !roots.some((root) => isWithin(root, real))) return null;
    const first = await stat(real).catch(() => null);
    return first?.isFile() && first.size > 0 ? first : null;
}

export type TurnMediaCandidate = { path: string; version: string; size: number; mimeType: string };
export type TurnMediaScan = { candidates: TurnMediaCandidate[]; pending: boolean };

export async function mediaCandidateStillReady(candidate: TurnMediaCandidate, signal?: AbortSignal): Promise<boolean> {
    signal?.throwIfAborted();
    const first = await lstat(candidate.path).catch(() => null);
    if (!first?.isFile() || mediaFileVersion(first) !== candidate.version) return false;
    if (candidate.mimeType.startsWith('video/')) {
        try {
            // Require readable dimensions and duration, not just a quiet size.
            // This excludes unfinished ordinary MP4 containers. Fragmented media
            // can still be readable while a background writer is paused, so this
            // is deliberately not presented as proof of producer completion.
            const probe = await runVideoPreviewProcess('ffprobe', [
                '-v', 'error', '-max_alloc', '134217728',
                '-protocol_whitelist', 'file,pipe',
                '-format_whitelist', 'mov,matroska,webm,avi,ogg,flv,mpeg,mpegvideo,mpegts,asf',
                '-probesize', '8388608', '-analyzeduration', '5000000',
                '-select_streams', 'v:0', '-show_entries',
                'stream=width,height,duration:format=duration', '-of', 'json', '-i', candidate.path,
            ], 6_000);
            if (!(parseVideoProbe(probe).durationSeconds! > 0)) return false;
        } catch { return false; }
    }
    signal?.throwIfAborted();
    const after = await lstat(candidate.path).catch(() => null);
    return Boolean(after?.isFile() && mediaFileVersion(after) === candidate.version);
}

/** One quiet window for the whole scan, rather than a delay per file. This is
 * a candidate check, not proof that a paused/background producer has exited. */
export async function discoverTurnMediaCandidates(
    baseline: TurnMediaBaseline,
    options: TurnMediaArtifactOptions,
    hints: string[] = [],
    signal?: AbortSignal,
): Promise<TurnMediaScan> {
    signal?.throwIfAborted();
    const roots = [...new Set([...baseline.roots, ...await resolveRoots(options)])];
    const current = await scanMediaFiles(roots);
    const changed = new Set([...current.entries()].filter(([path, version]) => baseline.fingerprints.get(path) !== version).map(([path]) => path));
    for (const hint of hints) if (getMediaTypeForPath(hint)) changed.add(resolve(hint));
    const first = new Map<string, Awaited<ReturnType<typeof regularFileInfo>>>();
    for (const path of changed) {
        signal?.throwIfAborted();
        first.set(path, await regularFileInfo(path, roots));
    }
    if (first.size) await delay(STABILITY_DELAY_MS, undefined, { signal });
    const candidates: TurnMediaCandidate[] = [];
    let pending = false;
    for (const [path, before] of first) {
        signal?.throwIfAborted();
        const after = await regularFileInfo(path, roots);
        // Delayed scans must not attach a later step's writes to this earlier
        // completion. Explicit provider paths already identify their source.
        if (!hints.includes(path) && options.modifiedBefore !== undefined && after && after.mtimeMs > options.modifiedBefore) continue;
        if (!before || !after || mediaFileVersion(before) !== mediaFileVersion(after)) {
            pending = true;
            continue;
        }
        candidates.push({ path, version: mediaFileVersion(after), size: after.size, mimeType: getMediaTypeForPath(path)! });
    }
    return { candidates, pending };
}

export async function captureTurnMediaBaseline(options: TurnMediaArtifactOptions): Promise<TurnMediaBaseline> {
    const roots = await resolveRoots(options);
    return { roots, fingerprints: await scanMediaFiles(roots) };
}

export async function discoverNewTurnMedia(
    baseline: TurnMediaBaseline,
    options: TurnMediaArtifactOptions,
): Promise<string[]> {
    return (await discoverTurnMediaCandidates(baseline, options)).candidates.map(candidate => candidate.path);
}
