import {
    machineFileDownloadChunk,
    machineFileDownloadInfo,
    machineFileUploadAbort,
    machineFileUploadBegin,
    machineFileUploadChunk,
    machineFileUploadFinish,
    sessionFileDownloadChunk,
    sessionFileDownloadInfo,
    sessionFileUploadAbort,
    sessionFileUploadBegin,
    sessionFileUploadChunk,
    sessionFileUploadFinish,
} from '@/sync/ops';
import { openWorkspacePreviewStore, type WorkspacePreviewStore } from './workspacePreviewStore';
import { registerDownloadResource, runManagedDownload } from './downloadManager';
import { handOffBrowserDownload } from './browserDownload';
import { getMediaDownloadName } from '@/components/media/mediaDisplayName';
import { acquireCloudWorkspaceFile, CLOUD_FILE_THRESHOLD_BYTES, cloudStageLabel, type CloudProgress } from './cloudFileDelivery';

type WorkspaceRpcTarget =
    | { sessionId: string; machineId?: never }
    | { machineId: string; sessionId?: never };

function downloadInfo(target: WorkspaceRpcTarget, path: string) {
    return target.machineId
        ? machineFileDownloadInfo(target.machineId, path)
        : sessionFileDownloadInfo(target.sessionId!, path);
}

function downloadChunk(target: WorkspaceRpcTarget, path: string, offset: number, length: number, expectedModified?: number) {
    return target.machineId
        ? machineFileDownloadChunk(target.machineId, path, offset, length, expectedModified)
        : sessionFileDownloadChunk(target.sessionId!, path, offset, length, expectedModified);
}

export const MAX_WORKSPACE_TRANSFER_BYTES = 512 * 1024 * 1024;
const NATIVE_STREAMING_SAVE_THRESHOLD_BYTES = 32 * 1024 * 1024;

function retainDownloadObjectUrl(url: string, release: () => void, signal: AbortSignal | undefined, lifetime: number): void {
    let disposed = false;
    let timer: number | undefined;
    let unregister: (() => void) | undefined;
    const dispose = () => {
        if (disposed) return;
        disposed = true; clearTimeout(timer); unregister?.();
        signal?.removeEventListener('abort', dispose);
        URL.revokeObjectURL(url); release();
    };
    if (signal?.aborted) { dispose(); return; }
    unregister = registerDownloadResource(dispose);
    signal?.addEventListener('abort', dispose, { once: true });
    timer = window.setTimeout(dispose, lifetime);
}

export class FileTransferConflictError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'FileTransferConflictError';
    }
}

export function formatFileSize(bytes: number): string {
    if (!Number.isFinite(bytes) || bytes < 0) return '';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KiB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MiB`;
    return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GiB`;
}

export function bytesToBase64(bytes: Uint8Array): string {
    let binary = '';
    const stride = 32 * 1024;
    for (let offset = 0; offset < bytes.length; offset += stride) {
        binary += String.fromCharCode(...bytes.subarray(offset, Math.min(bytes.length, offset + stride)));
    }
    return btoa(binary);
}

export function base64ToBytes(base64: string): Uint8Array {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
        bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
}

export async function uploadWorkspaceFile(options: WorkspaceRpcTarget & {
    destinationPath: string;
    file: File;
    overwrite: boolean;
    onProgress?: (progress: number) => void;
}): Promise<void> {
    const { destinationPath, file, overwrite, onProgress } = options;
    if (file.size > MAX_WORKSPACE_TRANSFER_BYTES) {
        throw new Error(`文件超过 ${formatFileSize(MAX_WORKSPACE_TRANSFER_BYTES)} 上限`);
    }

    const begin = options.machineId
        ? await machineFileUploadBegin(options.machineId, destinationPath, file.size, overwrite)
        : await sessionFileUploadBegin(options.sessionId!, destinationPath, file.size, overwrite);
    if (!begin.success) {
        if (begin.conflict) throw new FileTransferConflictError(begin.error);
        throw new Error(begin.error);
    }

    let finished = false;
    try {
        let offset = 0;
        onProgress?.(file.size === 0 ? 0.5 : 0);
        while (offset < file.size) {
            const end = Math.min(file.size, offset + begin.chunkSize);
            const bytes = new Uint8Array(await file.slice(offset, end).arrayBuffer());
            const result = options.machineId
                ? await machineFileUploadChunk(options.machineId, begin.uploadId, offset, bytesToBase64(bytes))
                : await sessionFileUploadChunk(options.sessionId!, begin.uploadId, offset, bytesToBase64(bytes));
            if (!result.success) throw new Error(result.error);
            offset = result.received;
            onProgress?.(file.size === 0 ? 0.5 : offset / file.size);
        }
        const result = options.machineId
            ? await machineFileUploadFinish(options.machineId, begin.uploadId)
            : await sessionFileUploadFinish(options.sessionId!, begin.uploadId);
        if (!result.success) {
            if (result.conflict) throw new FileTransferConflictError(result.error);
            throw new Error(result.error);
        }
        finished = true;
        onProgress?.(1);
    } finally {
        if (!finished) {
            await (options.machineId
                ? machineFileUploadAbort(options.machineId, begin.uploadId)
                : sessionFileUploadAbort(options.sessionId!, begin.uploadId)).catch(() => undefined);
        }
    }
}

export async function fetchWorkspaceFile(options: WorkspaceRpcTarget & {
    path: string;
    onProgress?: (progress: number) => void;
    signal?: AbortSignal;
}): Promise<{ blob: Blob; name: string; size: number; release: () => void }> {
    if (options.signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
    const info = await downloadInfo(options, options.path);
    if (!info.success) throw new Error(info.error);
    if (!Number.isSafeInteger(info.size) || info.size < 0 || !Number.isSafeInteger(info.chunkSize) || info.chunkSize <= 0) throw new Error('文件传输信息无效，请重试');
    if (info.size > CLOUD_FILE_THRESHOLD_BYTES) throw new Error('大文件需要通过 Cloudflare 交付地址读取');
    const controller = new AbortController();
    const chunks: Blob[] = [];
    let temporary: WorkspacePreviewStore | undefined;
    const release = () => { controller.abort(); temporary?.close(); chunks.length = 0; options.signal?.removeEventListener('abort', release); };
    options.signal?.addEventListener('abort', release, { once: true });
    const checkCurrent = () => { if (controller.signal.aborted || options.signal?.aborted) throw new DOMException('Cancelled', 'AbortError'); };
    try {
        checkCurrent();
        if (info.size > NATIVE_STREAMING_SAVE_THRESHOLD_BYTES) temporary = await openWorkspacePreviewStore(controller.signal);
        let offset = 0;
        options.onProgress?.(info.size === 0 ? 0.5 : 0);
        while (offset < info.size) {
            checkCurrent();
            const chunk = await downloadChunk(
                options,
                options.path,
                offset,
                Math.min(256 * 1024, info.chunkSize, info.size - offset),
                info.modified,
            );
            checkCurrent();
            if (!chunk.success) throw new Error(chunk.error);
            const bytes = base64ToBytes(chunk.content);
            if (chunk.bytesRead <= 0 || chunk.bytesRead !== bytes.length || chunk.bytesRead > Math.min(256 * 1024, info.chunkSize, info.size - offset)) throw new Error('文件下载分段内容不完整');
            const blob = new Blob([Uint8Array.from(bytes).buffer]);
            const stored = temporary ? await temporary.append(blob) : blob;
            checkCurrent();
            chunks.push(stored);
            offset += chunk.bytesRead;
            options.onProgress?.(offset / info.size);
        }
        options.onProgress?.(1);
        return { blob: new Blob(chunks), name: info.name, size: info.size, release };
    } catch (problem) { release(); throw problem; }
    finally { chunks.length = 0; }
}

type WorkspaceDownloadOptions = WorkspaceRpcTarget & CloudProgress & {
    path: string;
    onProgress?: (progress: number) => void;
    signal?: AbortSignal;
};

export function downloadWorkspaceFile(options: WorkspaceDownloadOptions): Promise<void> {
    return runManagedDownload({
        key: JSON.stringify([options.sessionId ?? null, options.machineId ?? null, options.path]),
        name: options.path.split(/[\\/]/).pop() || '工作区文件',
        signal: options.signal,
        work: (signal, progress, stage, ready) => performWorkspaceDownload({ ...options, signal, onHandoff: ready, onStage: value => { stage(cloudStageLabel(value)); options.onStage?.(value); }, onProgress: value => { progress(value); options.onProgress?.(value); } }),
    });
}

async function performWorkspaceDownload(options: WorkspaceDownloadOptions & { onHandoff?: (url: string) => void }): Promise<void> {
    if (typeof document === 'undefined' || typeof URL === 'undefined') {
        throw new Error('当前平台暂不支持浏览器下载');
    }
    const checkCurrent = () => { if (options.signal?.aborted) throw new DOMException('下载已取消', 'AbortError'); };
    checkCurrent();
    const info = await downloadInfo(options, options.path);
    checkCurrent();
    if (!info.success) throw new Error(info.error);
    if (info.size > CLOUD_FILE_THRESHOLD_BYTES) {
        const source = await acquireCloudWorkspaceFile({ ...options, forceRestore: true, fileInfo: info, download: true, attachmentName: getMediaDownloadName(options.path, info.name) });
        try { checkCurrent(); handOffBrowserDownload(source.downloadUrl, source.name); options.onHandoff?.(source.downloadUrl); options.onProgress?.(1); }
        finally { source.release(); }
        return;
    }
    // The stream abstraction selects remote Range or HTTP-compatible temporary
    // Blobs. Download navigations differ, even though both expose the same file.
    if (info.size > NATIVE_STREAMING_SAVE_THRESHOLD_BYTES && options.sessionId) {
        const { createWorkspaceStream } = await import('./workspaceStream');
        const stream = await createWorkspaceStream({ sessionId: options.sessionId, path: options.path, download: true, onProgress: options.onProgress, signal: options.signal, fileInfo: info });
        if (stream.url.startsWith('blob:')) {
            try { checkCurrent(); handOffBrowserDownload(stream.url, stream.name); }
            catch (problem) { stream.release(); throw problem; }
            window.setTimeout(stream.release, 60_000);
            return;
        }
        // A download-attribute navigation can bypass the controlling worker in
        // Chromium. A child navigation reaches its fetch handler; the response
        // Content-Disposition starts the download without leaving this page.
        const frame = document.createElement('iframe');
        frame.hidden = true;
        frame.title = '文件下载';
        frame.src = stream.url;
        document.body.appendChild(frame);
        try { checkCurrent(); await stream.done; checkCurrent(); }
        finally { frame.remove(); stream.release(); }
        return;
    }
    const savePicker = (window as any).showSaveFilePicker as undefined | ((options: { suggestedName: string }) => Promise<{ createWritable: () => Promise<{ write: (data: Uint8Array) => Promise<void>; close: () => Promise<void>; abort?: () => Promise<void> }> }>);
    if (savePicker) {
        // Small artifacts should download immediately like ordinary web files.
        // Keep the streaming native picker for large files so the browser does
        // not need to hold hundreds of MiB in one in-memory Blob.
        if (info.size <= NATIVE_STREAMING_SAVE_THRESHOLD_BYTES) {
            const file = await fetchWorkspaceFile(options);
            const url = URL.createObjectURL(file.blob);
            try {
                checkCurrent(); handOffBrowserDownload(url, file.name);
            } finally {
                retainDownloadObjectUrl(url, file.release, options.signal, 30_000);
            }
            return;
        }
        const handle = await savePicker({ suggestedName: info.name });
        const writable = await handle.createWritable();
        let completed = false;
        try {
            let offset = 0;
            options.onProgress?.(info.size === 0 ? 0.5 : 0);
            while (offset < info.size) {
                if (options.signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
                const chunk = await downloadChunk(options, options.path, offset, Math.min(info.chunkSize, info.size - offset), info.modified);
                if (options.signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
                if (!chunk.success) throw new Error(chunk.error);
                if (chunk.bytesRead <= 0) throw new Error('文件下载在完成前意外中断');
                await writable.write(base64ToBytes(chunk.content));
                offset += chunk.bytesRead;
                options.onProgress?.(offset / info.size);
            }
            await writable.close();
            completed = true;
            options.onProgress?.(1);
        } finally {
            if (!completed) await writable.abort?.().catch(() => undefined);
        }
        return;
    }
    const file = await fetchWorkspaceFile(options);
    const url = URL.createObjectURL(file.blob);
    try {
        checkCurrent(); handOffBrowserDownload(url, file.name);
    } finally {
        retainDownloadObjectUrl(url, file.release, options.signal, 60_000);
    }
}
