import { CLOUD_FILE_THRESHOLD_BYTES, type CloudFileDelivery, type CloudFileStage, type CloudFileTask } from '@hapla/wire';
import { apiSocket } from '@/sync/apiSocket';
import { storage } from '@/sync/storage';
import { sessionResources } from '@/sync/sessionResources';
import { resolveSessionFilePath } from './sessionFileLinks';
import { captureDownloadLifetime, registerDownloadResource } from './downloadManager';
import { getServerUrl } from '@/sync/serverConfig';
import { getMediaDownloadName } from '@/components/media/mediaDisplayName';
import { usesDirectFileDelivery } from './lanFileDelivery';

export { CLOUD_FILE_THRESHOLD_BYTES };
export type CloudProgress = { onProgress?: (fraction: number) => void; onStage?: (stage: CloudFileStage) => void };
export type CloudMediaAttachment = (media: HTMLMediaElement, onError?: (message: string) => void) => () => void;
export type CloudLinkLease = { url: string; downloadUrl: string; signal: AbortSignal; release: () => void; attach: CloudMediaAttachment };
export type CloudFileLease = CloudLinkLease & { size: number; name: string };
type CloudLink = { url: string; expiresAt: number };
type LifetimeOptions = CloudProgress & { sessionId?: string; download?: boolean; signal?: AbortSignal; forceRestore?: boolean; attachmentName?: string };
const cancelled = () => new DOMException('文件准备已取消', 'AbortError');
let preparing = 0;
const preparationQueue: Array<() => void> = [];
function preparationSlot(signal: AbortSignal): Promise<() => void> {
    return new Promise((resolve, reject) => {
        const abort = () => { const index = preparationQueue.indexOf(start); if (index >= 0) preparationQueue.splice(index, 1); reject(cancelled()); };
        const start = () => {
            signal.removeEventListener('abort', abort);
            if (signal.aborted) { reject(cancelled()); preparationQueue.shift()?.(); return; }
            preparing++; let released = false;
            resolve(() => { if (released) return; released = true; preparing--; preparationQueue.shift()?.(); });
        };
        if (signal.aborted) { reject(cancelled()); return; }
        if (preparing < 2) start();
        else { preparationQueue.push(start); signal.addEventListener('abort', abort, { once: true }); }
    });
}
export function cloudStageLabel(stage?: CloudFileStage): string {
    return stage === 'hashing' ? '正在校验文件' : stage === 'uploading-source' ? '正在上传文件'
        : stage === 'uploading-r2' ? '正在等待 Cloudflare 文件就绪' : stage === 'waiting-capacity' ? '正在排队准备文件'
        : stage === 'ready' ? '文件已就绪' : '正在确认文件状态';
}

function directLease(value: CloudFileDelivery, owner: ReturnType<typeof lifetime>, expectedSize?: number): CloudFileLease {
    const base = new URL(getServerUrl());
    if (value.state !== 'ready' || !Number.isSafeInteger(value.size) || value.size < 1 || (expectedSize !== undefined && value.size !== expectedSize)
        || !/^[a-f0-9]{64}$/.test(value.id) || !value.expiresAt || value.expiresAt < Date.now() + 30_000) throw new Error('本地文件版本无效');
    const urls = [value.url, value.downloadUrl].map(raw => {
        const url = new URL(raw!, base);
        if (!raw || url.origin !== base.origin || url.username || url.password || url.hash || url.pathname !== `/files/direct/${value.id}`) throw new Error('本地文件地址无效');
        return url.href;
    });
    owner.check();
    return { url: urls[0], downloadUrl: urls[1], size: value.size, name: value.name, signal: owner.signal, release: owner.release, attach: () => () => undefined };
}

export function validateCloudDelivery(value: CloudFileDelivery, expectedSize?: number): asserts value is CloudFileDelivery & { url: string; downloadUrl: string; expiresAt: number } {
    if (value.state !== 'ready' || !Number.isSafeInteger(value.size) || value.size <= CLOUD_FILE_THRESHOLD_BYTES
        || (expectedSize !== undefined && value.size !== expectedSize) || !value.expiresAt || value.expiresAt < Date.now() + 30_000
        || !/^[a-f0-9]{64}$/.test(value.id) || [value.url, value.downloadUrl, ...(value.headUrl ? [value.headUrl] : [])].some(raw => {
            try { const url = new URL(raw!); return url.protocol !== 'https:' || !!url.username || !!url.password || !url.hostname.endsWith('.r2.cloudflarestorage.com'); }
            catch { return true; }
        })) throw new Error('Cloudflare 文件地址或版本无效，请重试');
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
    if (signal.aborted) return Promise.reject(cancelled());
    return new Promise((resolve, reject) => {
        const abort = () => reject(cancelled()); signal.addEventListener('abort', abort, { once: true });
        promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
    });
}
async function delay(signal: AbortSignal, attempt = 3): Promise<void> {
    await new Promise<void>((resolve, reject) => {
        if (signal.aborted) { reject(cancelled()); return; }
        const abort = () => { clearTimeout(timer); reject(cancelled()); };
        const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, Math.min(1500, 250 * 2 ** Math.min(attempt, 3)));
        signal.addEventListener('abort', abort, { once: true });
    });
}

export async function cloudControl(path: string, signal: AbortSignal): Promise<CloudFileDelivery> {
    const response = await fileControlRequest(path, { signal, cache: 'no-store' }, signal);
    const value = await response.json();
    if (!response.ok) throw new Error(value.message || value.error || 'Cloudflare 文件准备失败，请重试');
    return value;
}

/** Only idempotent file control requests may be replayed. Keep the same task
 * and the same NAS preparation; never start another original upload on retry. */
async function retryFileControl<T>(work: () => Promise<T>, signal: AbortSignal, retryable: (error: unknown) => boolean): Promise<T> {
    for (let attempt = 0; ; attempt++) {
        if (signal.aborted) throw cancelled();
        try { return await abortable(work(), signal); }
        catch (error) {
            if (signal.aborted) throw cancelled();
            if (attempt >= 2 || !retryable(error)) throw error;
            await delay(signal, attempt + 1);
        }
    }
}

async function fileControlRequest(path: string, options: RequestInit, signal: AbortSignal): Promise<Response> {
    return retryFileControl(async () => {
        const response = await apiSocket.request(path, options);
        // A proxy/network interruption is recoverable; authorization and file
        // validation errors need to reach the user without being retried.
        if ([502, 503, 504].includes(response.status)) {
            const value = await response.json().catch(() => ({}));
            throw Object.assign(new Error(value.message || value.error || '文件服务暂时不可用，请重试'), { fileControlRetry: true });
        }
        return response;
    }, signal, error => error instanceof TypeError || Boolean((error as { fileControlRetry?: boolean } | null)?.fileControlRetry));
}

/** Signed URLs and original bytes are never persisted. The owner lifetime also
 * stops renewal before an account switch can issue requests as another user. */
function lifetime(options: LifetimeOptions) {
    const controller = new AbortController();
    const retained = options.download || !options.sessionId ? captureDownloadLifetime() : sessionResources.capture(options.sessionId);
    const cleanups = new Set<() => void>();
    let unregister: (() => void) | undefined;
    const release = () => {
        if (controller.signal.aborted) return;
        controller.abort(); unregister?.(); options.signal?.removeEventListener('abort', release);
        for (const cleanup of cleanups) cleanup(); cleanups.clear();
    };
    unregister = options.download || !options.sessionId ? registerDownloadResource(release) : sessionResources.register(options.sessionId, release);
    options.signal?.addEventListener('abort', release, { once: true });
    if (options.signal?.aborted || !retained()) release();
    return { signal: controller.signal, release, cleanups, check() { if (controller.signal.aborted || !retained()) { release(); throw cancelled(); } } };
}

function attachRenewingMedia(value: CloudLink, owner: ReturnType<typeof lifetime>, renew: () => Promise<CloudLink>): CloudMediaAttachment {
    let current = value;
    const attach: CloudMediaAttachment = (media, onError) => {
        let busy = false; let detached = false; let loaded: (() => void) | undefined;
        const refresh = async () => {
            if (busy || detached || owner.signal.aborted || (current.expiresAt ?? 0) > Date.now() + 120_000) return;
            busy = true;
            try {
                owner.check();
                const next = await renew();
                owner.check(); if (detached) return;
                const position = media.currentTime; const paused = media.paused; const rate = media.playbackRate;
                if (loaded) media.removeEventListener('loadedmetadata', loaded);
                loaded = () => { if (detached || owner.signal.aborted) return; media.currentTime = position; media.playbackRate = rate; if (!paused) void media.play().catch(() => undefined); };
                media.addEventListener('loadedmetadata', loaded, { once: true });
                current = next; media.src = next.url; media.load();
            } catch (error) { if (!detached && !owner.signal.aborted) onError?.(error instanceof Error ? error.message : '媒体地址续期失败，请重试'); }
            finally { busy = false; }
        };
        const timer = setInterval(() => { void refresh(); }, 30_000);
        media.addEventListener('play', refresh);
        const detach = () => { detached = true; clearInterval(timer); media.removeEventListener('play', refresh); if (loaded) media.removeEventListener('loadedmetadata', loaded); owner.cleanups.delete(detach); };
        owner.cleanups.add(detach); return detach;
    };
    return attach;
}

function lease(value: CloudFileDelivery, owner: ReturnType<typeof lifetime>): CloudFileLease {
    validateCloudDelivery(value); owner.check();
    const attach = attachRenewingMedia(value, owner, async () => {
        const deadline = Date.now() + 3_700_000;
        for (let poll = 0; ; poll++) {
            const next = await cloudControl(`/v1/files/cloud/${value.id}`, owner.signal);
            if (next.state === 'ready') { validateCloudDelivery(next, value.size); return next; }
            if (next.state !== 'preparing' || Date.now() > deadline) throw new Error(next.error || '文件地址恢复失败，请重试');
            await delay(owner.signal, poll);
        }
    });
    return { url: value.url, downloadUrl: value.downloadUrl, name: value.name, size: value.size, signal: owner.signal, release: owner.release, attach };
}

async function prepareFileLease(value: CloudFileDelivery, owner: ReturnType<typeof lifetime>, options: LifetimeOptions): Promise<CloudFileLease> {
    validateCloudDelivery(value); owner.check();
    if (!options.forceRestore && !options.attachmentName) return lease(value, owner);
    const restored = await acquireCloudFileLink(value.url, { ...options, signal: owner.signal, force: true });
    owner.check(); if (!restored) throw new Error('文件地址恢复失败，请重试');
    owner.cleanups.add(restored.release);
    return { ...restored, size: value.size, name: value.name, signal: owner.signal, release: owner.release };
}

/** Only small encrypted task messages use RPC. Never retry a large-file failure
 * through the old base64, Blob, service-worker or MSE transfer paths. */
export async function acquireCloudWorkspaceFile(options: LifetimeOptions & {
    machineId?: string; path: string; fileInfo: { size: number; modified: number; name: string };
}): Promise<CloudFileLease> {
    const owner = lifetime(options);
    const consumerId = Array.from(crypto.getRandomValues(new Uint8Array(16)), x => x.toString(16).padStart(2, '0')).join('');
    let rpc: ((method: string, args: unknown) => Promise<CloudFileTask>) | undefined;
    let jobId: string | undefined;
    let releasedTask = false;
    const releaseTask = () => { if (releasedTask || !jobId || !rpc) return; releasedTask = true; void rpc('file-cloud-release', { jobId, consumerId }).catch(() => undefined); };
    owner.cleanups.add(releaseTask);
    try {
        owner.check();
        const direct = await usesDirectFileDelivery(); owner.check();
        if (options.fileInfo.size <= CLOUD_FILE_THRESHOLD_BYTES) throw new Error('小文件不需要 Cloudflare 交付');
        options.onStage?.('preparing');
        const releaseSlot = await preparationSlot(owner.signal);
        if (owner.signal.aborted) { releaseSlot(); throw cancelled(); }
        owner.cleanups.add(releaseSlot); owner.check();
        const session = options.sessionId ? storage.getState().sessions[options.sessionId] : undefined;
        const root = session?.metadata?.path;
        const resolved = root ? resolveSessionFilePath(options.path, root) : undefined;
        if (options.sessionId && !resolved?.withinSessionRoot) throw new Error('文件不在当前会话工作区内');
        const machineId = options.machineId ?? session?.metadata?.machineId;
        const params = { path: resolved?.absolutePath ?? options.path, size: options.fileInfo.size, modified: options.fileInfo.modified, consumerId, sessionId: options.sessionId, workspaceRoot: root };
        const methodName = (method: string) => direct ? method.replace(/^file-cloud-/, 'file-direct-') : method;
        const sessionRPC = options.sessionId ? (method: string, args: unknown) => apiSocket.sessionRPC<CloudFileTask, unknown>(options.sessionId!, methodName(method), args, 20_000) : undefined;
        rpc = machineId ? (method, args) => apiSocket.machineRPC<CloudFileTask, unknown>(machineId, methodName(method), args, 20_000) : sessionRPC;
        if (!rpc) throw new Error('找不到此文件所属的工作台');
        const prepare = async () => {
            let result: CloudFileTask;
            try { result = await rpc!('file-cloud-prepare', params); }
            catch (error) {
                owner.check();
                if (!machineId || !sessionRPC || !(error instanceof Error) || !/RPC method not available|RPC target disconnected|Machine encryption not found/i.test(error.message)) throw error;
                rpc = sessionRPC; result = await rpc('file-cloud-prepare', params);
            }
            jobId = result.jobId;
            if (owner.signal.aborted) releaseTask();
            return result;
        };
        let result = await abortable(prepare(), owner.signal);
        const deadline = Date.now() + 3_700_000;
        let poll = 0;
        for (;;) {
            owner.check();
            if (!result.success || result.state === 'failed') throw new Error(result.error || 'Cloudflare 文件准备失败，请重试');
            options.onStage?.(result.stage ?? 'preparing'); options.onProgress?.(result.progress ?? 0);
            if (result.state === 'ready' && result.delivery) {
                if (direct) { const source = directLease(result.delivery, owner, options.fileInfo.size); releaseTask(); releaseSlot(); owner.cleanups.delete(releaseSlot); return source; }
                validateCloudDelivery(result.delivery, options.fileInfo.size); releaseTask(); releaseSlot(); owner.cleanups.delete(releaseSlot);
                return await prepareFileLease(result.delivery, owner, options);
            }
            if (!jobId) throw new Error('工作台返回了无效的文件准备任务');
            if (Date.now() > deadline) throw new Error('文件准备超时，请重试');
            await delay(owner.signal, poll++);
            result = await retryFileControl(() => rpc!('file-cloud-status', { jobId, consumerId }), owner.signal,
                error => error instanceof Error && /timed? ?out|timeout|socket not connected|target disconnected|network/i.test(error.message));
        }
    } catch (error) { owner.release(); throw error; }
}

/** The server already owns uploaded attachments; it prepares these without a
 * CLI. Polling an authenticated metadata endpoint never downloads the source. */
export async function acquireStoredCloudFile(path: string, options: LifetimeOptions = {}): Promise<CloudFileLease | null> {
    if (!path.startsWith('/files/') || path.startsWith('//') || path.includes('#')) throw new Error('附件地址无效');
    const owner = lifetime(options);
    try {
        const control = path.split('?')[0] + '?delivery=1';
        const deadline = Date.now() + 3_700_000;
        let first = true;
        let poll = 0;
        for (;;) {
            owner.check();
            const state = await cloudControl(control + (first ? '&retry=1' : ''), owner.signal); first = false;
            owner.check();
            if (state.size <= CLOUD_FILE_THRESHOLD_BYTES || (state as CloudFileDelivery & { required?: boolean }).required === false) { owner.release(); return null; }
            if (state.state === 'failed') throw new Error(state.error || 'Cloudflare 文件准备失败，请重试');
            options.onStage?.(state.stage); options.onProgress?.(state.progress);
            if (state.state === 'ready') return await prepareFileLease(state, owner, options);
            if (Date.now() > deadline) throw new Error('文件准备超时，请重试');
            await delay(owner.signal, poll++);
        }
    } catch (error) { owner.release(); throw error; }
}

export function isCloudFileLink(uri: string): boolean {
    try { const url = new URL(uri); return url.protocol === 'https:' && !url.username && !url.password && url.hostname.endsWith('.r2.cloudflarestorage.com'); }
    catch { return false; }
}

/** The signed URL is restored by the NAS service; browsers never contact the
 * private LAN endpoint or fetch original bytes to renew a link. */
export async function acquireCloudFileLink(uri: string, options: LifetimeOptions & { force?: boolean } = {}): Promise<CloudLinkLease | null> {
    if (!isCloudFileLink(uri)) return null;
    const owner = lifetime(options);
    const request = async (force = false): Promise<CloudLink> => {
        const response = await fileControlRequest('/v1/files/cloud/resolve', { method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url: uri, ...(force ? { force: true } : {}), ...(options.attachmentName ? { downloadFilename: options.attachmentName } : {}) }), signal: owner.signal, cache: 'no-store' }, owner.signal);
        owner.check();
        const value = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(value.message || (response.status === 404 ? '此链接没有可恢复的 NAS 原文件' : '文件链接恢复失败，请重试'));
        if (!isCloudFileLink(value.url) || !Number.isFinite(value.expiresAt) || value.expiresAt < Date.now() + 30_000) throw new Error('文件服务返回了无效或过期的地址');
        if (options.attachmentName) {
            const query = new URL(value.url).searchParams;
            if (!/^attachment(?:;|$)/i.test(query.get('response-content-disposition') ?? '') || query.get('response-content-type') !== 'application/octet-stream') throw new Error('未取得可保存的下载地址，请重试');
        }
        return value;
    };
    try {
        options.onStage?.('preparing');
        if (await usesDirectFileDelivery()) {
            owner.check();
            const response = await apiSocket.request('/v1/files/direct/resolve', { method: 'POST', signal: owner.signal, cache: 'no-store', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ url: uri, ...(options.attachmentName ? { downloadFilename: options.attachmentName } : {}) }) });
            const value = await response.json();
            if (!response.ok) throw new Error(value.message || value.error || 'NAS 原文件读取失败，请重试');
            const source = directLease(value, owner); options.onStage?.('ready'); options.onProgress?.(1); return source;
        }
        const value = await request(options.force);
        owner.check(); options.onStage?.('ready'); options.onProgress?.(1);
        return { url: value.url, downloadUrl: value.url, signal: owner.signal, release: owner.release,
            attach: attachRenewingMedia(value, owner, () => request(true)) };
    } catch (error) { owner.release(); throw error; }
}

export async function downloadCloudFileLink(uri: string, name: string): Promise<void> {
    const { runManagedDownload } = await import('./downloadManager');
    const { handOffBrowserDownload } = await import('./browserDownload');
    return runManagedDownload({ key: uri, name, work: async (signal, onProgress, stage, ready) => {
        const source = await acquireCloudFileLink(uri, { signal, onProgress, onStage: value => stage(cloudStageLabel(value)), download: true, force: true, attachmentName: getMediaDownloadName(uri, name) });
        try { if (signal.aborted) throw cancelled(); if (!source) throw new Error('下载地址无效'); handOffBrowserDownload(source.downloadUrl, name); ready(source.downloadUrl); }
        finally { source?.release(); }
    } });
}

export async function openCloudFileLink(uri: string): Promise<void> {
    // Reserve the tab synchronously within the user's click, before async
    // authorization. Never interpolate a filename or URL into HTML.
    const tab = window.open('about:blank', '_blank');
    if (!tab) throw new Error('浏览器阻止了新窗口，请允许后重试');
    tab.opener = null;
    tab.document.title = '正在打开视频';
    tab.document.body.textContent = '正在获取有效视频地址…';
    let source: CloudLinkLease | null = null;
    try {
        source = await acquireCloudFileLink(uri, { download: true });
        if (!tab.closed) tab.location.replace(source?.url ?? uri);
    } catch (error) { tab.close(); throw error; }
    finally { source?.release(); }
}

export function storedCloudPath(uri: string): string | null {
    try {
        const base = getServerUrl(); const url = new URL(uri, base);
        return url.origin === new URL(base).origin && url.pathname.startsWith('/files/') && !url.username && !url.password ? url.pathname : null;
    } catch { return null; }
}

/** Small authenticated previews are independent of original-file delivery.
 * Never change external signed links or LAN-only direct-file URLs. */
export function storedImagePreviewUrl(uri: string): string | null {
    const path = storedCloudPath(uri);
    if (!path?.startsWith('/files/public/users/') || !/\.(?:png|jpe?g|webp|gif)$/i.test(path)) return null;
    const url = new URL(path, getServerUrl());
    url.searchParams.set('preview', 'image');
    return url.href;
}

export async function downloadStoredFile(uri: string, name: string): Promise<void> {
    const path = storedCloudPath(uri); if (!path) throw new Error('附件地址无效');
    const { runManagedDownload } = await import('./downloadManager');
    const { handOffBrowserDownload } = await import('./browserDownload');
    return runManagedDownload({ key: path, name, work: async (signal, onProgress, stage, ready) => {
        const source = await acquireStoredCloudFile(path, { signal, onProgress, onStage: value => stage(cloudStageLabel(value)), download: true, attachmentName: getMediaDownloadName(uri, name) });
        try { if (signal.aborted) throw cancelled(); const url = source?.downloadUrl ?? getServerUrl() + path + '?download=1'; handOffBrowserDownload(url, name); ready(url); }
        finally { source?.release(); }
    } });
}

export async function readCloudFileRange(source: CloudFileLease, offset: number, length: number, signal: AbortSignal): Promise<Uint8Array> {
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length <= 0 || length > 512 * 1024 || offset + length > source.size) throw new Error('文件分段范围无效');
    const response = await fetch(source.url, { headers: { Range: `bytes=${offset}-${offset + length - 1}` }, signal,
        credentials: new URL(source.url).origin === new URL(getServerUrl()).origin ? 'include' : 'omit', cache: 'no-store' });
    if (response.status !== 206 || response.headers.get('Content-Range') !== `bytes ${offset}-${offset + length - 1}/${source.size}`) { await response.body?.cancel(); throw new Error('Cloudflare 文件分段响应无效，请重试'); }
    const reader = response.body?.getReader(); const bytes = new Uint8Array(length); let count = 0;
    try {
        if (!reader) throw new Error('文件分段内容为空');
        for (;;) { const part = await reader.read(); if (part.done) break; if (count + part.value.length > length) throw new Error('文件分段内容超出范围'); bytes.set(part.value, count); count += part.value.length; }
        if (count !== length) throw new Error('文件分段内容不完整');
        return bytes;
    } finally { await reader?.cancel().catch(() => undefined); }
}
