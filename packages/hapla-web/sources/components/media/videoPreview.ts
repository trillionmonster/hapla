import { supportsServerVideoPreview } from './serverVideoPreview';

export type VideoPreview = {
    status: 'ready' | 'unavailable';
    posterStatus?: 'ready' | 'unavailable';
    reason?: VideoPreviewReason;
    retryable?: boolean;
    retryAfterMs?: number;
    durationSeconds?: number;
    width?: number;
    height?: number;
    aspectRatio?: string;
    sizeBytes?: number;
    posterDataUrl?: string;
};

const previewReasons = ['preview_busy', 'source_expired', 'source_denied', 'source_not_found', 'source_busy', 'network', 'timeout',
    'range_unsupported', 'source_changed', 'invalid_response', 'budget_exceeded', 'decoder_unavailable', 'frame_too_large', 'cancelled'] as const;
export type VideoPreviewReason = typeof previewReasons[number];

export type WorkspaceVideo = { sessionId: string; path: string };
type Source = { uri: string; workspaceVideo?: WorkspaceVideo; previewRevision?: string };
const previews = new Map<string, VideoPreview>();
const unavailableUntil = new Map<string, number>();
const unfinishedPreviews = new Set<string>();
const pending = new Map<string, Promise<VideoPreview>>();
const controllers = new Set<AbortController>();
const sourceControllers = new Map<string, AbortController>();
const subscribers = new Map<string, Set<() => void>>();
let generation = 0;
let rpcModule: Promise<typeof import('@/sync/ops')> | undefined;

export function videoPreviewKey(source: Source): string {
    const sourceKey = source.workspaceVideo ? JSON.stringify(source.workspaceVideo) : source.uri;
    return source.previewRevision ? JSON.stringify([sourceKey, source.previewRevision]) : sourceKey;
}

/** Only small posters/metadata live here. Video bodies never enter this cache. */
export function rememberVideoPreview(source: Source, value: VideoPreview): void {
    const key = videoPreviewKey(source);
    previews.delete(key);
    previews.set(key, value);
    if (value.retryable && !value.posterDataUrl) unavailableUntil.set(key, Date.now() + (value.retryAfterMs ?? 1_000));
    else if (value.status === 'unavailable') unavailableUntil.set(key, Date.now() + 30_000);
    else unavailableUntil.delete(key);
    while (previews.size > 64) { const oldest = previews.keys().next().value!; previews.delete(oldest); unavailableUntil.delete(oldest); unfinishedPreviews.delete(oldest); }
    subscribers.get(key)?.forEach(listener => listener());
}

export function subscribeVideoPreview(source: Source, listener: () => void): () => void {
    const key = videoPreviewKey(source);
    const listeners = subscribers.get(key) ?? new Set();
    listeners.add(listener); subscribers.set(key, listeners);
    return () => {
        listeners.delete(listener);
        if (!listeners.size) { subscribers.delete(key); sourceControllers.get(key)?.abort(); }
    };
}

export function peekVideoPreview(source: Source): VideoPreview | undefined {
    return previews.get(videoPreviewKey(source));
}

export function clearVideoPreviewCache(): void {
    generation++;
    previews.clear();
    unavailableUntil.clear();
    unfinishedPreviews.clear();
    pending.clear();
    controllers.forEach(controller => controller.abort());
    controllers.clear();
    sourceControllers.clear();
    subscribers.forEach(listeners => listeners.forEach(listener => listener()));
}

// Only our own upload route implements this API. Never append our preview
// parameters or forward credentials to another host's signed URL.
export function videoPreviewEndpoint(uri: string, origin: string): string | null {
    try {
        const url = new URL(uri, origin);
        if (url.origin !== new URL(origin).origin || !url.pathname.startsWith('/files/')) return null;
        url.searchParams.set('preview', 'video');
        return url.href;
    } catch { return null; }
}

function normalizePreview(value: unknown): VideoPreview {
    if (!value || typeof value !== 'object') return { status: 'unavailable' };
    const input = value as Record<string, unknown>;
    const number = (key: string) => typeof input[key] === 'number' && Number.isFinite(input[key]) && (input[key] as number) >= 0 ? input[key] as number : undefined;
    return {
        status: input.status === 'ready' ? 'ready' : 'unavailable',
        posterStatus: input.posterStatus === 'ready' || input.posterStatus === 'unavailable' ? input.posterStatus : undefined,
        reason: previewReasons.includes(input.reason as VideoPreviewReason) ? input.reason as VideoPreviewReason : undefined,
        retryable: typeof input.retryable === 'boolean' ? input.retryable : undefined,
        retryAfterMs: number('retryAfterMs') === undefined ? undefined : Math.min(5_000, Math.max(250, number('retryAfterMs')!)),
        durationSeconds: number('durationSeconds'), width: number('width'), height: number('height'), sizeBytes: number('sizeBytes'),
        aspectRatio: typeof input.aspectRatio === 'string' && /^\d+(?:\.\d+)?:\d+(?:\.\d+)?$/.test(input.aspectRatio) ? input.aspectRatio : undefined,
        posterDataUrl: typeof input.posterDataUrl === 'string' && input.posterDataUrl.length <= 190_000 && /^data:image\/(?:jpeg|webp|png);base64,[a-zA-Z0-9+/=]+$/.test(input.posterDataUrl) ? input.posterDataUrl : undefined,
    };
}

function mergePreview(source: Source, next: VideoPreview): VideoPreview {
    const previous = peekVideoPreview(source);
    const defined = Object.fromEntries(Object.entries(next).filter(([, value]) => value !== undefined));
    const result = { ...previous, ...defined, status: previous?.status === 'ready' || next.status === 'ready' ? 'ready' as const : 'unavailable' as const };
    if (next.posterDataUrl) {
        result.posterStatus = 'ready';
        delete result.reason; delete result.retryable; delete result.retryAfterMs;
    }
    return result;
}

let running = 0;
const waiters: Array<() => void> = [];
async function limited<T>(operation: () => Promise<T>): Promise<T> {
    if (running >= 2 && waiters.length >= 32) throw new Error('Video preview queue is full');
    if (running >= 2) await new Promise<void>(resolve => waiters.push(resolve));
    else running++;
    try { return await operation(); }
    finally { const next = waiters.shift(); if (next) next(); else running--; }
}

export async function loadVideoPreview(source: Source, retry = false): Promise<VideoPreview> {
    const key = videoPreviewKey(source);
    const cached = previews.get(key);
    const expires = unavailableUntil.get(key);
    if (cached && !retry && !unfinishedPreviews.has(key) && (expires !== undefined ? expires > Date.now() : cached.status === 'ready')) return cached;
    const existing = pending.get(key);
    if (existing && !sourceControllers.get(key)?.signal.aborted) return existing;
    const version = generation;
    const controller = new AbortController();
    controllers.add(controller);
    sourceControllers.set(key, controller);
    const operation = limited(async () => {
        if (version !== generation || controller.signal.aborted) return { status: 'unavailable' } as VideoPreview;
        const timeout = setTimeout(() => controller.abort(), source.workspaceVideo ? 20_000 : 30_000);
        let stopWaiting: (() => void) | undefined;
        let external = false;
        try {
            let value: unknown;
            if (source.workspaceVideo) {
                const { sessionVideoPreview } = await (rpcModule ??= import('@/sync/ops'));
                const cancelled = new Promise<never>((_, reject) => {
                    const abort = () => reject(new DOMException('Cancelled', 'AbortError'));
                    if (controller.signal.aborted) abort();
                    else controller.signal.addEventListener('abort', abort, { once: true });
                    stopWaiting = () => controller.signal.removeEventListener('abort', abort);
                });
                value = await Promise.race([sessionVideoPreview(source.workspaceVideo.sessionId, source.workspaceVideo.path), cancelled]);
            } else {
                const endpoint = typeof window === 'undefined' ? null : videoPreviewEndpoint(source.uri, window.location.origin);
                if (endpoint) {
                    const response = await fetch(endpoint, { credentials: 'same-origin', cache: 'no-store', signal: controller.signal });
                    if (!response.ok) throw new Error('Video preview unavailable');
                    value = await response.json();
                } else if (typeof document !== 'undefined' && supportsServerVideoPreview(source.uri)) {
                    external = true;
                    const { loadServerVideoPreview } = await import('./serverVideoPreview');
                    const { usesDirectFileDelivery } = await import('@/utils/lanFileDelivery');
                    const { acquireCloudFileLink } = await import('@/utils/cloudFileDelivery');
                    const direct = await usesDirectFileDelivery();
                    // NAS resolves the original object key locally, including
                    // expired signatures. Do not renew or fetch R2 for a poster.
                    const renewed = direct ? null : await acquireCloudFileLink(source.uri, { signal: controller.signal, force: retry });
                    try { value = await loadServerVideoPreview(renewed?.url ?? source.uri, controller.signal); }
                    finally { renewed?.release(); }
                } else if (typeof document !== 'undefined') {
                    external = true;
                    const { loadExternalVideoPreview } = await import('./externalVideoPreview');
                    value = await loadExternalVideoPreview(source.uri, controller.signal, partial => {
                        if (generation === version && !controller.signal.aborted) {
                            unfinishedPreviews.add(key);
                            rememberVideoPreview(source, mergePreview(source, normalizePreview(partial)));
                        }
                    });
                } else value = { status: 'unavailable' };
            }
            const result = external ? mergePreview(source, normalizePreview(value)) : normalizePreview(value);
            if (generation === version && !controller.signal.aborted) {
                unfinishedPreviews.delete(key);
                rememberVideoPreview(source, result);
            }
            return result;
        } catch {
            const value = peekVideoPreview(source) ?? { status: 'unavailable' } as VideoPreview;
            if (generation === version && !controller.signal.aborted) rememberVideoPreview(source, value);
            return value;
        }
        finally { stopWaiting?.(); clearTimeout(timeout); controllers.delete(controller); }
    });
    pending.set(key, operation);
    try { return await operation; }
    catch { return { status: 'unavailable' }; }
    finally {
        controllers.delete(controller);
        if (sourceControllers.get(key) === controller) sourceControllers.delete(key);
        if (pending.get(key) === operation) pending.delete(key);
    }
}

export function videoPreviewNotice(preview?: VideoPreview): string {
    switch (preview?.reason) {
        case 'source_expired': return '链接已过期，请更新链接';
        case 'source_denied': return '链接已失效或访问被拒绝';
        case 'source_not_found': return '视频已删除或链接无效';
        case 'preview_busy': case 'source_busy': return '预览服务繁忙，稍后重试';
        case 'network': return '网络连接中断，稍后重试';
        case 'timeout': return '读取超时，可重试预览';
        default: return '预览信息暂不可用';
    }
}

export function formatVideoDuration(seconds?: number): string {
    if (seconds === undefined || !Number.isFinite(seconds) || seconds < 0) return '时长未知';
    const total = Math.round(seconds);
    const hours = Math.floor(total / 3600), minutes = Math.floor(total / 60) % 60, remainder = total % 60;
    return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}` : `${Math.floor(total / 60)}:${String(remainder).padStart(2, '0')}`;
}

export function videoAspectRatio(width?: number, height?: number): string | undefined {
    if (!width || !height || !Number.isSafeInteger(width) || !Number.isSafeInteger(height)) return undefined;
    let a = width, b = height;
    while (b) [a, b] = [b, a % b];
    return `${width / a}:${height / a}`;
}

export function formatVideoSize(bytes?: number): string {
    if (bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return '原文件大小未知';
    const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
    const index = Math.min(units.length - 1, Math.max(0, Math.floor(Math.log2(bytes || 1) / 10)));
    return `原文件 ${index ? (bytes / 1024 ** index).toFixed(1) : bytes} ${units[index]}`;
}
