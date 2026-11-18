import { createHash, randomUUID, type Hash } from 'node:crypto';
import {
    lstat,
    link,
    open,
    realpath,
    rename,
    stat,
    unlink,
    type FileHandle,
} from 'node:fs/promises';
import { basename, dirname, resolve, sep } from 'node:path';

export const FILE_TRANSFER_CHUNK_BYTES = 512 * 1024;
const configuredTransferBytes = Number(process.env.HAPLA_MAX_TRANSFER_BYTES);
export const MAX_TRANSFER_BYTES = Number.isSafeInteger(configuredTransferBytes) && configuredTransferBytes > 0
    ? Math.min(configuredTransferBytes, 8 * 1024 * 1024 * 1024) : 512 * 1024 * 1024;
const MAX_DOWNLOAD_BYTES = 8 * 1024 * 1024 * 1024;

type UploadState = {
    handle: FileHandle;
    tempPath: string;
    targetPath: string;
    declaredSize: number;
    received: number;
    overwrite: boolean;
    expectedHash?: string;
    hash: Hash;
    touchedAt: number;
    busy: boolean;
};

export type FileTransferResult = { success: true } | { success: false; error: string };

function isWithin(root: string, target: string): boolean {
    return target === root || target.startsWith(root + sep);
}

function validByteCount(value: unknown, max: number): value is number {
    return Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= max;
}

/**
 * Chunked, session-scoped workspace transfer manager.
 *
 * Files are never staged outside the workspace. Uploads use a hidden temporary
 * file in the destination directory and are atomically renamed only after the
 * declared byte count has been received.
 */
export class FileTransferManager {
    private readonly uploads = new Map<string, UploadState>();
    private readonly completed = new Map<string, { path: string; size: number; sha256: string }>();
    private readonly expiryTimer: ReturnType<typeof setInterval>;
    private rootRealPathPromise: Promise<string> | null = null;

    constructor(private readonly workingDirectory: string) {
        this.expiryTimer = setInterval(() => {
            for (const [id, upload] of this.uploads) {
                if (!upload.busy && Date.now() - upload.touchedAt > 15 * 60_000) void this.abortUpload(id);
            }
        }, 60_000);
        this.expiryTimer.unref();
    }

    async dispose(): Promise<void> {
        clearInterval(this.expiryTimer);
        await Promise.all([...this.uploads.keys()].map((id) => this.abortUpload(id)));
        this.completed.clear();
    }

    uploadStatus(uploadId: string) {
        const done = this.completed.get(uploadId);
        if (done) return { success: true as const, received: done.size, size: done.size, sha256: done.sha256, complete: true };
        const upload = this.uploads.get(uploadId);
        if (!upload) return { success: false as const, error: 'Upload session was not found' };
        upload.touchedAt = Date.now();
        return { success: true as const, received: upload.received, size: upload.declaredSize, sha256: upload.expectedHash, complete: false };
    }

    private rootRealPath(): Promise<string> {
        if (!this.rootRealPathPromise) {
            this.rootRealPathPromise = realpath(resolve(this.workingDirectory));
        }
        return this.rootRealPathPromise;
    }

    private async resolveReadableFile(requestedPath: string): Promise<string> {
        if (typeof requestedPath !== 'string' || requestedPath.length === 0 || requestedPath.length > 4096) {
            throw new Error('A valid workspace file path is required');
        }
        const root = await this.rootRealPath();
        const lexicalPath = resolve(root, requestedPath);
        if (!isWithin(root, lexicalPath)) {
            throw new Error('Access denied: path is outside the workspace');
        }

        const info = await lstat(lexicalPath);
        if (info.isSymbolicLink()) {
            throw new Error('Symbolic links cannot be transferred');
        }
        if (!info.isFile()) {
            throw new Error('The selected path is not a regular file');
        }

        const resolvedPath = await realpath(lexicalPath);
        if (!isWithin(root, resolvedPath)) {
            throw new Error('Access denied: resolved path is outside the workspace');
        }
        return resolvedPath;
    }

    private async resolveWritableFile(requestedPath: string): Promise<{ targetPath: string; exists: boolean }> {
        if (typeof requestedPath !== 'string' || requestedPath.length === 0 || requestedPath.length > 4096) {
            throw new Error('A valid destination path is required');
        }
        const root = await this.rootRealPath();
        const targetPath = resolve(root, requestedPath);
        if (!isWithin(root, targetPath) || targetPath === root) {
            throw new Error('Access denied: destination is outside the workspace');
        }
        if (basename(targetPath).startsWith('.hapla-upload-')) {
            throw new Error('That filename is reserved for transfer staging');
        }

        const parentRealPath = await realpath(dirname(targetPath));
        if (!isWithin(root, parentRealPath)) {
            throw new Error('Access denied: destination directory is outside the workspace');
        }

        try {
            const info = await lstat(targetPath);
            if (info.isSymbolicLink()) {
                throw new Error('Symbolic links cannot be overwritten');
            }
            if (!info.isFile()) {
                throw new Error('The destination already exists and is not a regular file');
            }
            return { targetPath, exists: true };
        } catch (error) {
            const nodeError = error as NodeJS.ErrnoException;
            if (nodeError.code === 'ENOENT') {
                return { targetPath, exists: false };
            }
            throw error;
        }
    }

    async downloadInfo(path: string) {
        try {
            const resolvedPath = await this.resolveReadableFile(path);
            const info = await stat(resolvedPath);
            if (info.size > MAX_DOWNLOAD_BYTES) {
                return { success: false as const, error: 'File exceeds the 8 GiB download limit' };
            }
            return {
                success: true as const,
                name: basename(resolvedPath),
                size: info.size,
                modified: info.mtimeMs,
                chunkSize: FILE_TRANSFER_CHUNK_BYTES,
            };
        } catch (error) {
            return { success: false as const, error: error instanceof Error ? error.message : 'Unable to inspect file' };
        }
    }

    /** A bounded background exporter owns this handle until hash/upload ends. */
    async openCloudSnapshot(path: string, expectedSize: number, expectedModified: number) {
        const resolvedPath = await this.resolveReadableFile(path);
        const handle = await open(resolvedPath, 'r');
        try {
            const info = await handle.stat();
            if (!info.isFile() || info.size > MAX_DOWNLOAD_BYTES || info.size !== expectedSize || info.mtimeMs !== expectedModified) {
                throw new Error('文件已经变化，请重新打开');
            }
            return { handle, path: resolvedPath, name: basename(resolvedPath), size: info.size, modified: info.mtimeMs, ctime: info.ctimeMs, inode: info.ino };
        } catch (error) { await handle.close(); throw error; }
    }

    async downloadChunk(path: string, offset: number, length: number, expectedModified?: number) {
        try {
            if (!validByteCount(offset, MAX_TRANSFER_BYTES)
                || !Number.isSafeInteger(length)
                || length <= 0
                || length > FILE_TRANSFER_CHUNK_BYTES) {
                return { success: false as const, error: 'Invalid download byte range' };
            }
            const resolvedPath = await this.resolveReadableFile(path);
            const info = await stat(resolvedPath);
            if (expectedModified !== undefined && info.mtimeMs !== expectedModified) return { success: false as const, error: 'File changed during transfer; reopen it to read a consistent version' };
            if (offset > info.size) {
                return { success: false as const, error: 'Download offset exceeds file size' };
            }
            const bytesToRead = Math.min(length, info.size - offset);
            if (bytesToRead === 0) {
                return { success: true as const, content: '', bytesRead: 0, eof: true };
            }
            const handle = await open(resolvedPath, 'r');
            try {
                const buffer = Buffer.allocUnsafe(bytesToRead);
                const { bytesRead } = await handle.read(buffer, 0, bytesToRead, offset);
                return {
                    success: true as const,
                    content: buffer.subarray(0, bytesRead).toString('base64'),
                    bytesRead,
                    eof: offset + bytesRead >= info.size,
                };
            } finally {
                await handle.close();
            }
        } catch (error) {
            return { success: false as const, error: error instanceof Error ? error.message : 'Unable to read file' };
        }
    }

    async beginUpload(path: string, size: number, overwrite: boolean, expectedHash?: string) {
        try {
            if (!validByteCount(size, MAX_TRANSFER_BYTES)) {
                return { success: false as const, error: `File must be at most ${MAX_TRANSFER_BYTES / 1024 / 1024} MiB` };
            }
            if (this.uploads.size >= 8) return { success: false as const, error: 'Too many active uploads; finish or cancel one first' };
            if (expectedHash !== undefined && !/^[a-f0-9]{64}$/.test(expectedHash)) return { success: false as const, error: 'Invalid SHA-256 digest' };
            const target = await this.resolveWritableFile(path);
            if (target.exists && !overwrite) {
                return { success: false as const, conflict: true as const, error: 'A file with this name already exists' };
            }

            const uploadId = randomUUID();
            const tempPath = resolve(dirname(target.targetPath), `.hapla-upload-${uploadId}.part`);
            const handle = await open(tempPath, 'wx+', 0o600);
            this.uploads.set(uploadId, {
                handle,
                tempPath,
                targetPath: target.targetPath,
                declaredSize: size,
                received: 0,
                overwrite, expectedHash, hash: createHash('sha256'), touchedAt: Date.now(), busy: false,
            });
            return { success: true as const, uploadId, chunkSize: FILE_TRANSFER_CHUNK_BYTES };
        } catch (error) {
            return { success: false as const, error: error instanceof Error ? error.message : 'Unable to start upload' };
        }
    }

    async uploadChunk(uploadId: string, offset: number, content: string) {
        const upload = this.uploads.get(uploadId);
        if (!upload) {
            return { success: false as const, error: 'Upload session was not found' };
        }
        if (upload.busy) return { success: false as const, error: 'Upload operation is still in progress; retry' };
        upload.busy = true;
        try {
            upload.touchedAt = Date.now();
            if (!validByteCount(offset, MAX_TRANSFER_BYTES) || offset > upload.received) {
                return { success: false as const, error: `Unexpected upload offset; expected ${upload.received}` };
            }
            if (typeof content !== 'string' || content.length > Math.ceil(FILE_TRANSFER_CHUNK_BYTES * 4 / 3) + 8) {
                return { success: false as const, error: 'Upload chunk is invalid or too large' };
            }
            if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(content)) return { success: false as const, error: 'Invalid Base64 upload content' };
            const bytes = Buffer.from(content, 'base64');
            if (offset < upload.received) {
                if (offset + bytes.length > upload.received) return { success: false as const, error: 'Upload chunk overlaps unconfirmed bytes' };
                const prior = Buffer.alloc(bytes.length);
                const { bytesRead } = await upload.handle.read(prior, 0, prior.length, offset);
                if (bytesRead !== bytes.length || !prior.equals(bytes)) return { success: false as const, error: 'Retried upload chunk does not match received bytes' };
                return { success: true as const, received: upload.received };
            }
            if (bytes.length > FILE_TRANSFER_CHUNK_BYTES || upload.received + bytes.length > upload.declaredSize) {
                return { success: false as const, error: 'Upload chunk exceeds the declared file size' };
            }
            if (bytes.length === 0 && upload.declaredSize !== 0) {
                return { success: false as const, error: 'Upload chunk is empty' };
            }
            let written = 0;
            while (written < bytes.length) {
                const { bytesWritten } = await upload.handle.write(bytes, written, bytes.length - written, upload.received + written);
                if (!bytesWritten) throw new Error('Unable to write upload bytes');
                written += bytesWritten;
            }
            upload.hash.update(bytes);
            upload.received += bytes.length;
            return { success: true as const, received: upload.received };
        } catch (error) {
            await this.abortUpload(uploadId);
            return { success: false as const, error: error instanceof Error ? error.message : 'Unable to write upload chunk' };
        } finally { upload.busy = false; }
    }

    async finishUpload(uploadId: string) {
        const done = this.completed.get(uploadId);
        if (done) return { success: true as const, ...done };
        const upload = this.uploads.get(uploadId);
        if (!upload) {
            return { success: false as const, error: 'Upload session was not found' };
        }
        if (upload.busy) return { success: false as const, error: 'Upload operation is still in progress; retry' };
        upload.busy = true;
        try {
            if (upload.received !== upload.declaredSize) {
                return { success: false as const, error: `Upload is incomplete (${upload.received}/${upload.declaredSize} bytes)` };
            }
            const sha256 = upload.hash.copy().digest('hex');
            if (upload.expectedHash && sha256 !== upload.expectedHash) throw new Error('SHA-256 verification failed; the uploaded file was not published');
            await upload.handle.sync();
            await upload.handle.close();
            this.uploads.delete(uploadId);

            const latestTarget = await this.resolveWritableFile(upload.targetPath);
            if (latestTarget.exists && !upload.overwrite) {
                await unlink(upload.tempPath).catch(() => undefined);
                return { success: false as const, conflict: true as const, error: 'A file with this name was created during upload' };
            }
            if (upload.overwrite) {
                await rename(upload.tempPath, upload.targetPath);
            } else {
                // Publish with an atomic no-clobber operation: a concurrent upload
                // cannot pass the existence check and overwrite the winner.
                await link(upload.tempPath, upload.targetPath);
                await unlink(upload.tempPath);
            }
            const result = { path: upload.targetPath, size: upload.declaredSize, sha256 };
            this.completed.set(uploadId, result);
            while (this.completed.size > 128) this.completed.delete(this.completed.keys().next().value!);
            return { success: true as const, ...result };
        } catch (error) {
            this.uploads.delete(uploadId);
            await upload.handle.close().catch(() => undefined);
            await unlink(upload.tempPath).catch(() => undefined);
            return { success: false as const, error: error instanceof Error ? error.message : 'Unable to finish upload' };
        } finally { upload.busy = false; }
    }

    async abortUpload(uploadId: string): Promise<FileTransferResult> {
        const upload = this.uploads.get(uploadId);
        if (!upload) {
            return { success: true };
        }
        this.uploads.delete(uploadId);
        await upload.handle.close().catch(() => undefined);
        await unlink(upload.tempPath).catch(() => undefined);
        return { success: true };
    }
}
