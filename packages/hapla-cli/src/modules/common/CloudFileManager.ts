import { createHash, randomUUID } from 'node:crypto';
import type { FileHandle } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { CLOUD_FILE_THRESHOLD_BYTES, type CloudFileDelivery, type CloudFileTask } from '@hapla/wire';
import { FileTransferManager } from './FileTransferManager';
import { cloudControlRequest } from './cloudControlRequest';

type Request = { path: string; size: number; modified: number; consumerId: string; delivery?: 'direct' };
type Job = { id: string; key: string; value: CloudFileTask; consumers: Set<string>; touched: number; controller: AbortController };
const validConsumer = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9_-]{8,80}$/.test(value);
const cancelled = () => new Error('文件准备已取消');

export class CloudFileManager {
    private readonly jobs = new Map<string, Job>();
    private readonly files: FileTransferManager;
    private readonly timer: ReturnType<typeof setInterval>;
    constructor(root: string, private readonly options: { token: string; serverUrl: string; fetch?: typeof fetch }) {
        this.files = new FileTransferManager(root);
        this.timer = setInterval(() => {
            for (const job of this.jobs.values()) if (Date.now() - job.touched > (job.value.state === 'preparing' ? 90_000 : 3_600_000)) {
                job.controller.abort(); this.jobs.delete(job.id);
            }
        }, 15_000);
        this.timer.unref();
    }
    dispose(): void { clearInterval(this.timer); for (const job of this.jobs.values()) job.controller.abort(); this.jobs.clear(); void this.files.dispose(); }
    has(jobId: string): boolean { return this.jobs.has(jobId); }
    downloadInfo(path: string) { return this.files.downloadInfo(path); }
    downloadChunk(path: string, offset: number, length: number, modified?: number) { return this.files.downloadChunk(path, offset, length, modified); }

    async prepare(request: Request): Promise<CloudFileTask> {
        if (!validConsumer(request.consumerId) || !Number.isSafeInteger(request.size) || request.size <= CLOUD_FILE_THRESHOLD_BYTES || !Number.isFinite(request.modified)) return { success: false, error: '文件准备参数无效' };
        const snapshot = await this.files.openCloudSnapshot(request.path, request.size, request.modified);
        const key = JSON.stringify([snapshot.path, snapshot.size, snapshot.modified, snapshot.ctime, snapshot.inode, request.delivery ?? 'cloud']);
        const existing = [...this.jobs.values()].find(job => job.key === key && job.value.state !== 'failed' && !job.controller.signal.aborted
            && (job.value.state !== 'ready' || (job.value.delivery?.expiresAt ?? 0) > Date.now() + 120_000));
        if (existing) {
            await snapshot.handle.close(); existing.consumers.add(request.consumerId); existing.touched = Date.now();
            return { ...existing.value };
        }
        if ([...this.jobs.values()].filter(job => job.value.state === 'preparing').length >= 4) {
            await snapshot.handle.close(); return { success: false, error: '此工作台的文件准备队列繁忙，请稍后重试' };
        }
        while (this.jobs.size >= 64) {
            const old = [...this.jobs.values()].find(job => job.value.state !== 'preparing' && job.consumers.size === 0);
            if (!old) { await snapshot.handle.close(); return { success: false, error: '文件准备队列已满' }; }
            this.jobs.delete(old.id);
        }
        const id = randomUUID();
        const job: Job = { id, key, value: { success: true, jobId: id, state: 'preparing', stage: 'hashing', progress: 0 }, consumers: new Set([request.consumerId]), touched: Date.now(), controller: new AbortController() };
        this.jobs.set(id, job);
        void this.run(job, snapshot, request.delivery ?? 'cloud').catch(error => {
            job.value = { success: true, jobId: id, state: 'failed', error: job.controller.signal.aborted ? '文件准备已取消' : error instanceof Error ? error.message : '文件准备失败，请重试' };
        }).finally(() => snapshot.handle.close().catch(() => undefined));
        return { ...job.value };
    }

    status(jobId: string, consumerId: string): CloudFileTask {
        const job = this.jobs.get(jobId);
        if (!job || !job.consumers.has(consumerId)) return { success: false, error: '文件准备任务已结束，请重试' };
        job.touched = Date.now(); return { ...job.value };
    }
    release(jobId: string, consumerId: string): { success: true } {
        const job = this.jobs.get(jobId);
        if (job) {
            job.consumers.delete(consumerId);
            if (!job.consumers.size && job.value.state === 'preparing') job.controller.abort();
        }
        return { success: true };
    }

    private async request(path: string, options: RequestInit, signal: AbortSignal): Promise<CloudFileDelivery> {
        let response: Response;
        try {
            response = await (this.options.fetch ?? cloudControlRequest)(this.options.serverUrl.replace(/\/$/, '') + path, {
                ...options, signal: AbortSignal.any([signal, AbortSignal.timeout(options.method === 'PUT' ? 3_700_000 : 30_000)]), redirect: 'error',
                headers: { ...options.headers, Authorization: `Bearer ${this.options.token}` },
            });
        } catch { throw signal.aborted ? cancelled() : new Error('文件交付服务连接中断，请重试'); }
        if (response.status === 204) return undefined as never;
        const body = await response.json() as CloudFileDelivery & { message?: string };
        if (!response.ok) throw new Error(body.message || body.error || 'Cloudflare 文件准备失败，请重试');
        return body;
    }

    private async run(job: Job, file: { handle: FileHandle; size: number; modified: number; ctime: number; name: string }, deliveryMode: 'cloud' | 'direct'): Promise<void> {
        const signal = job.controller.signal;
        const check = async () => {
            if (signal.aborted) throw cancelled();
            const now = await file.handle.stat();
            if (now.size !== file.size || now.mtimeMs !== file.modified || now.ctimeMs !== file.ctime) throw new Error('文件在准备期间发生变化，请重新打开');
        };
        const hash = createHash('sha256'); let hashed = 0;
        const source = file.handle.createReadStream({ start: 0, end: file.size - 1, autoClose: false, highWaterMark: 256 * 1024, signal });
        for await (const chunk of source) { hash.update(chunk); hashed += chunk.length; job.value.progress = .1 * hashed / file.size; }
        await check();
        if (hashed !== file.size) throw new Error('文件读取不完整，请重试');
        const route = `/v1/files/${deliveryMode}`;
        let delivery = await this.request(`${route}/prepare`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sha256: hash.digest('hex'), name: file.name, size: file.size }) }, signal);
        if (delivery.state === 'upload-required') {
            job.value.stage = 'uploading-source'; let sent = 0;
            const input = file.handle.createReadStream({ start: 0, end: file.size - 1, autoClose: false, highWaterMark: 256 * 1024, signal });
            const body = Readable.from((async function* () {
                for await (const chunk of input) { sent += chunk.length; job.value.progress = .1 + .45 * sent / file.size; yield chunk; }
                job.value.stage = deliveryMode === 'cloud' ? 'uploading-r2' : 'preparing';
            })(), { objectMode: false, highWaterMark: 256 * 1024 });
            try {
                await this.request(`${route}/${delivery.id}/source`, { method: 'PUT', body, duplex: 'half',
                    headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(file.size) } } as RequestInit, signal);
            } finally { body.destroy(); if (!input.readableEnded) input.destroy(); }
            await check();
        }
        const deadline = Date.now() + 3_700_000;
        while (delivery.state !== 'ready') {
            if (signal.aborted) throw cancelled();
            if (Date.now() > deadline) throw new Error('Cloudflare 文件准备超时，请重试或检查缓存容量');
            delivery = await this.request(`${route}/${delivery.id}`, {}, signal);
            if (delivery.state === 'failed') throw new Error(delivery.error || 'Cloudflare 文件准备失败');
            job.value.stage = delivery.stage; job.value.progress = .55 + .45 * delivery.progress;
            if (delivery.state !== 'ready') await new Promise<void>((resolve, reject) => {
                if (signal.aborted) { reject(cancelled()); return; }
                const abort = () => { clearTimeout(timer); reject(cancelled()); };
                const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, 1500);
                signal.addEventListener('abort', abort, { once: true });
            });
        }
        await check();
        job.value = { success: true, jobId: job.id, state: 'ready', stage: 'ready', progress: 1, delivery };
    }
}
