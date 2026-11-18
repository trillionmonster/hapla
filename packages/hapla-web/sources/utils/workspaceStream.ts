import { sessionFileDownloadChunk, sessionFileDownloadInfo, type SessionFileDownloadInfoResponse } from '@/sync/ops';
import { getFileMimeType } from './filePreview';
import { sessionResources } from '@/sync/sessionResources';
import { openWorkspacePreviewStore, type WorkspacePreviewStore } from './workspacePreviewStore';
import { captureDownloadLifetime, registerDownloadResource } from './downloadManager';
import { acquireCloudWorkspaceFile, CLOUD_FILE_THRESHOLD_BYTES, type CloudMediaAttachment, type CloudProgress } from './cloudFileDelivery';

const grants = new Map<string, {
    sessionId: string; path: string; size: number; modified: number; name: string;
    mimeType: string; download: boolean; signal?: AbortSignal;
    release: () => void; complete: () => void; fail: (message: string) => void; onProgress?: (progress: number) => void;
}>();
let ready: Promise<void> | null = null;
let listening = false;

export const TEMPORARY_PREVIEW_THRESHOLD_BYTES = 32 * 1024 * 1024;
const PREVIEW_CHUNK_BYTES = 256 * 1024;
const bufferedPreviews = new Map<string, { sessionId: string; download?: boolean; release: () => void }>();
const preparingPreviews = new Map<AbortController, { sessionId: string; download?: boolean; release: () => void }>();
type WorkspaceStreamOptions = CloudProgress & {
    sessionId: string; path: string; download?: boolean; signal?: AbortSignal;
    onProgress?: (progress: number) => void;
    preferStreaming?: boolean;
    expectedFile?: { modified: number; size: number };
    /** An already checked metadata response from the video open operation.
     * Every byte read still verifies its exact modified revision remotely. */
    fileInfo?: WorkspaceFileInfo;
    forceRestore?: boolean;
};
type WorkspaceFileInfo = Extract<SessionFileDownloadInfoResponse, { success: true }>;

/** HTTP-compatible previews. Only individual RPC chunks are decoded in the JS heap. */
async function createBlobPreview(options: WorkspaceStreamOptions, info: WorkspaceFileInfo, retained: () => boolean) {
    const controller = new AbortController();
    const chunks: Blob[] = [];
    let temporary: WorkspacePreviewStore | undefined;
    let url: string | undefined;
    let released = false;
    let unregister: (() => void) | undefined;
    const release = () => {
        if (released) return;
        released = true;
        if (url) { URL.revokeObjectURL(url); bufferedPreviews.delete(url); }
        controller.abort();
        temporary?.close();
        chunks.length = 0;
        preparingPreviews.delete(controller);
        options.signal?.removeEventListener('abort', release);
        unregister?.();
    };
    preparingPreviews.set(controller, { sessionId: options.sessionId, download: options.download, release });
    unregister = options.download ? registerDownloadResource(release) : sessionResources.register(options.sessionId, release);
    options.signal?.addEventListener('abort', release, { once: true });
    const checkCurrent = () => {
        if (controller.signal.aborted || options.signal?.aborted || !retained()) throw new DOMException('Cancelled', 'AbortError');
    };
    try {
        checkCurrent();
        options.onProgress?.(0);
        if (info.size > TEMPORARY_PREVIEW_THRESHOLD_BYTES) temporary = await openWorkspacePreviewStore(controller.signal);
        let offset = 0;
        const chunkSize = Math.min(PREVIEW_CHUNK_BYTES, info.chunkSize);
        if (!Number.isSafeInteger(chunkSize) || chunkSize <= 0) throw new Error('文件分段大小无效，请重试');
        while (offset < info.size) {
            checkCurrent();
            const length = Math.min(chunkSize, info.size - offset);
            const chunk = await sessionFileDownloadChunk(options.sessionId, options.path, offset, length, info.modified);
            checkCurrent();
            if (!chunk.success) throw new Error(chunk.error);
            const binary = atob(chunk.content);
            if (!Number.isSafeInteger(chunk.bytesRead) || chunk.bytesRead <= 0 || chunk.bytesRead > length || binary.length !== chunk.bytesRead) {
                throw new Error('文件分段内容不完整，请重试');
            }
            const blob = new Blob([Uint8Array.from(binary, (character) => character.charCodeAt(0)).buffer]);
            const stored = temporary ? await temporary.append(blob) : blob;
            checkCurrent();
            chunks.push(stored);
            offset += chunk.bytesRead;
            options.onProgress?.(offset / info.size);
        }
        checkCurrent();
        const mime = getFileMimeType(options.path) ?? 'application/octet-stream';
        // Match the streaming response's inert media MIME policy, including PDFs.
        const type = /^(?:image\/(?:png|jpeg|gif|webp|avif|bmp|x-icon)|audio\/[a-z0-9.+-]+|video\/[a-z0-9.+-]+|application\/pdf)$/.test(mime)
            ? mime : 'application/octet-stream';
        const blob = new Blob(chunks, { type });
        url = URL.createObjectURL(blob);
        chunks.length = 0;
        preparingPreviews.delete(controller);
        bufferedPreviews.set(url, { sessionId: options.sessionId, download: options.download, release });
        options.onProgress?.(1);
        return { url, blob, size: info.size, name: info.name, release, done: Promise.resolve() };
    } catch (problem) { release(); throw problem; }
}

async function ensureWorker(): Promise<void> {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator) || !globalThis.isSecureContext) {
        throw new Error('此浏览器未启用流式文件连接');
    }
    if (!listening) {
        listening = true;
        navigator.serviceWorker.addEventListener('message', async (event) => {
            if (event.data?.type !== 'hapla-workspace-read' || !event.ports[0]) return;
            const port = event.ports[0];
            const grant = grants.get(event.data.token);
            try {
                if (!grant || grant.signal?.aborted) throw new Error('File preview expired');
                if (event.data.action === 'info') {
                    port.postMessage({ size: grant.size, name: grant.name, mimeType: grant.mimeType, download: grant.download });
                } else if (event.data.action === 'complete') {
                    grant.complete();
                    port.postMessage({ ok: true });
                } else if (event.data.action === 'error') {
                    grant.fail(String(event.data.message || '下载失败'));
                    port.postMessage({ ok: true });
                } else {
                    const { offset, length } = event.data;
                    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length <= 0 || length > 256 * 1024 || offset + length > grant.size) {
                        throw new Error('Invalid workspace byte range');
                    }
                    const chunk = await sessionFileDownloadChunk(grant.sessionId, grant.path, offset, length, grant.modified);
                    if (!chunk.success) throw new Error(chunk.error);
                    if (grant.signal?.aborted || !grants.has(event.data.token)) throw new Error('File preview expired');
                    const binary = atob(chunk.content);
                    if (binary.length !== chunk.bytesRead) throw new Error('Invalid workspace byte count');
                    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
                    port.postMessage({ bytes: bytes.buffer }, [bytes.buffer]);
                    grant.onProgress?.(grant.size ? (offset + chunk.bytesRead) / grant.size : 1);
                }
            } catch (error) {
                port.postMessage({ error: error instanceof Error ? error.message : 'File request failed' });
            } finally { port.close(); }
        });
    }
    if (!ready) ready = (async () => {
        await navigator.serviceWorker.register('/workspace-stream-sw.js', { scope: '/' });
        await workerReady();
        if (!navigator.serviceWorker.controller) {
            await new Promise<void>((resolve, reject) => {
                const done = () => { clearTimeout(timer); navigator.serviceWorker.removeEventListener('controllerchange', done); resolve(); };
                const timer = setTimeout(() => { navigator.serviceWorker.removeEventListener('controllerchange', done); reject(new Error('文件流连接未就绪，请重试')); }, 15000);
                navigator.serviceWorker.addEventListener('controllerchange', done);
            });
        }
    })().catch((error) => { ready = null; throw error; });
    return ready;
}

async function workerReady(): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        await Promise.race([navigator.serviceWorker.ready, new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error('文件流连接超时')), 15000);
        })]);
    } finally { clearTimeout(timer); }
}

/** HTTPS can stream remote ranges; HTTP stages revocable Blobs of any supported size. */
export async function createWorkspaceStream(options: WorkspaceStreamOptions): Promise<{ url: string; blob?: Blob; size: number; name: string; release: () => void; done: Promise<void>; attach?: CloudMediaAttachment }> {
    if (options.signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
    const retained = options.download ? captureDownloadLifetime() : sessionResources.capture(options.sessionId);
    const info = options.fileInfo ?? await sessionFileDownloadInfo(options.sessionId, options.path);
    if (options.signal?.aborted || !retained()) throw new DOMException('Cancelled', 'AbortError');
    if (!info.success) throw new Error(info.error);
    if (!Number.isSafeInteger(info.size) || info.size < 0) throw new Error('文件大小无效，请重试');
    if (options.expectedFile && (info.modified !== options.expectedFile.modified || info.size !== options.expectedFile.size)) throw new Error('视频在读取期间发生变化，请重新打开');
    if (info.size > CLOUD_FILE_THRESHOLD_BYTES) {
        const source = await acquireCloudWorkspaceFile({ ...options, fileInfo: info });
        return { ...source, url: options.download ? source.downloadUrl : source.url, done: Promise.resolve() };
    }
    if (!options.download && !options.preferStreaming && info.size <= TEMPORARY_PREVIEW_THRESHOLD_BYTES) return createBlobPreview(options, info, retained);
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator) || !globalThis.isSecureContext) {
        return createBlobPreview(options, info, retained);
    }
    try { await ensureWorker(); }
    catch { return createBlobPreview(options, info, retained); }
    if (options.signal?.aborted || !retained()) throw new DOMException('Cancelled', 'AbortError');
    const token = Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) => byte.toString(16).padStart(2, '0')).join('');
    let resolveDone!: () => void;
    let rejectDone!: (error: Error) => void;
    let unregister: (() => void) | undefined;
    const done = new Promise<void>((resolve, reject) => { resolveDone = resolve; rejectDone = reject; });
    void done.catch(() => undefined);
    const release = () => { grants.delete(token); options.signal?.removeEventListener('abort', release); unregister?.(); resolveDone(); };
    grants.set(token, { ...options, ...info, mimeType: getFileMimeType(options.path) ?? 'application/octet-stream', download: options.download === true,
        release, complete: () => { if (options.download) release(); },
        fail: (message) => { if (options.download) { rejectDone(new Error(message)); release(); } },
    });
    unregister = options.download ? registerDownloadResource(release) : sessionResources.register(options.sessionId, release);
    options.signal?.addEventListener('abort', release, { once: true });
    return { url: `/__hapla_workspace_stream/${token}/${encodeURIComponent(info.name)}`, size: info.size, name: info.name, release, done };
}

export function releaseSessionWorkspaceStreams(sessionId: string): void {
    for (const grant of grants.values()) if (grant.sessionId === sessionId && !grant.download) grant.release();
    for (const preview of preparingPreviews.values()) if (preview.sessionId === sessionId && !preview.download) preview.release();
    for (const preview of bufferedPreviews.values()) if (preview.sessionId === sessionId && !preview.download) preview.release();
}
