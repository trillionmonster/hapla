import { createHash } from 'node:crypto';
import { open } from 'node:fs/promises';
import { basename } from 'node:path';
import { Readable } from 'node:stream';
import type { CloudFileDelivery } from '@hapla/wire';
import { CloudDeliveryError, CloudFileDeliveryService, cloudFiles } from './cloudFileDelivery';

type LocalJob = { touched: number; pending: boolean; deliveryId?: string; value: CloudFileDelivery };

/** Server-owned uploaded files use the same account-scoped cache protocol as
 * workspaces. Jobs retain a file descriptor, never an original-file Buffer. */
export class LocalCloudFiles {
    private jobs = new Map<string, LocalJob>();
    private locks = new Map<string, Promise<unknown>>();
    private running = 0;
    constructor(private readonly delivery: CloudFileDeliveryService) {}
    private async locked<T>(id: string, work: () => Promise<T>): Promise<T> {
        const previous = this.locks.get(id) ?? Promise.resolve();
        const next = previous.catch(() => undefined).then(work);
        this.locks.set(id, next);
        try { return await next; } finally { if (this.locks.get(id) === next) this.locks.delete(id); }
    }
    async prepare(accountId: string, path: string, retry = false): Promise<CloudFileDelivery> {
        const handle = await open(path, 'r');
        let delegated = false;
        try {
            const stat = await handle.stat();
            if (!stat.isFile()) throw new CloudDeliveryError(404, '文件不存在');
            const id = createHash('sha256').update(JSON.stringify([accountId, path, stat.size, stat.mtimeMs, stat.ctimeMs, stat.ino])).digest('hex');
            return await this.locked(id, async () => {
                const existing = this.jobs.get(id);
                if (existing && !(retry && existing.value.state === 'failed' && !existing.pending)) {
                    existing.touched = Date.now();
                    if (existing.pending && existing.deliveryId) {
                        const current = await this.delivery.status(accountId, existing.deliveryId);
                        // Upload waits until NAS has published the R2 copy. Poll
                        // that job while it waits, without starting another upload
                        // or reporting ready before the original-file check below.
                        if (existing.pending && existing.value.state === 'preparing' && current.state === 'preparing') {
                            existing.value = { ...current, progress: .1 + .9 * current.progress };
                        }
                    }
                    if (existing.value.state !== 'ready' || (existing.value.expiresAt ?? 0) > Date.now() + 120_000) return existing.value;
                    const renewed = await this.delivery.status(accountId, existing.value.id);
                    if (renewed.state === 'ready') { existing.value = renewed; return renewed; }
                    // If the remote copy was evicted, the source still belongs to
                    // this server. Re-enter the bounded preparation job below.
                }
                if (existing?.value.state === 'failed' && !existing.pending && retry) this.jobs.delete(id);
                for (const [key, job] of this.jobs) if (!job.pending && Date.now() - job.touched > 60 * 60_000) this.jobs.delete(key);
                if (this.running >= 2) return { id, state: 'preparing', stage: 'waiting-capacity', progress: 0, name: basename(path), size: stat.size };
                if (this.jobs.size >= 256) { const oldest = [...this.jobs].find(([, job]) => !job.pending); if (oldest) this.jobs.delete(oldest[0]); else throw new CloudDeliveryError(429, '文件准备队列繁忙'); }
                const job: LocalJob = { touched: Date.now(), pending: true, value: { id, state: 'preparing', stage: 'hashing', progress: 0, name: basename(path), size: stat.size } };
                this.jobs.set(id, job); this.running++; delegated = true;
                const signal = AbortSignal.timeout(3_700_000);
                const check = async () => { const now = await handle.stat(); if (now.size !== stat.size || now.mtimeMs !== stat.mtimeMs || now.ctimeMs !== stat.ctimeMs) throw new Error('文件在准备期间变化，请重试'); };
                void (async () => {
                    const hash = createHash('sha256'); let hashed = 0;
                    const input = handle.createReadStream({ start: 0, end: stat.size - 1, autoClose: false, highWaterMark: 256 * 1024, signal });
                    for await (const chunk of input) { hash.update(chunk); hashed += chunk.length; job.value.progress = .1 * hashed / stat.size; }
                    await check();
                    let value = await this.delivery.prepare(accountId, { sha256: hash.digest('hex'), name: job.value.name, size: stat.size });
                    job.deliveryId = value.id;
                    if (value.state === 'upload-required') {
                        job.value.stage = 'uploading-source'; let sent = 0;
                        const file = handle.createReadStream({ start: 0, end: stat.size - 1, autoClose: false, highWaterMark: 256 * 1024, signal });
                        const stream = Readable.from((async function* () { for await (const bytes of file) { sent += bytes.length; job.value.progress = .1 + .45 * sent / stat.size; yield bytes; } })(), { objectMode: false, highWaterMark: 256 * 1024 });
                        try { await this.delivery.upload(accountId, value.id, stream, stat.size, signal); } finally { stream.destroy(); if (!file.readableEnded) file.destroy(); }
                        await check();
                    }
                    for (;;) {
                        if (signal.aborted) throw new Error('文件准备超时，请重试');
                        value = await this.delivery.status(accountId, value.id);
                        if (value.state === 'failed') throw new Error(value.error);
                        if (value.state === 'ready') { await check(); job.value = value; return; }
                        job.value = { ...value, state: 'preparing', progress: .55 + .45 * value.progress };
                        await new Promise(resolve => setTimeout(resolve, 1500));
                    }
                })().catch(error => { job.value = { ...job.value, state: 'failed', error: error instanceof Error ? error.message : '文件准备失败，请重试' }; })
                    .finally(() => { job.pending = false; this.running--; void handle.close(); });
                return job.value;
            });
        } finally { if (!delegated) await handle.close(); }
    }
}
export const localCloudFiles = new LocalCloudFiles(cloudFiles);
