import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { cloudControlRequest } from './cloudControlRequest';
import { CLOUD_FILE_THRESHOLD_BYTES, type CloudFileDelivery } from '@hapla/wire';

const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const validId = (value: string) => /^[a-f0-9]{64}$/.test(value);
export const MAX_CLOUD_FILE_BYTES = 8 * 1024 * 1024 * 1024;
export const CLOUD_REQUEST_TIMEOUT_MS = 3_700_000;
type FileRecord = { id: string; sha256: string; name: string; size: number; url?: string };
type Link = { url: string; expiresAt: number };
type Job = { value: CloudFileDelivery; pending: boolean; touched: number };

export class CloudDeliveryError extends Error {
    constructor(public statusCode: number, message: string) { super(message); this.name = 'CloudDeliveryError'; }
}

export function cloudLink(url: unknown): Link {
    try {
        if (typeof url !== 'string' || url.length > 16_384) throw new Error();
        const parsed = new URL(url);
        if (parsed.protocol !== 'https:' || parsed.username || parsed.password || !parsed.hostname.endsWith('.r2.cloudflarestorage.com')) throw new Error();
        const date = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(parsed.searchParams.get('X-Amz-Date') ?? '');
        const ttl = Number(parsed.searchParams.get('X-Amz-Expires'));
        if (!date || !Number.isSafeInteger(ttl) || ttl < 1 || ttl > 604800 || !parsed.searchParams.get('X-Amz-Signature')) throw new Error();
        const expiresAt = Date.UTC(+date[1], +date[2] - 1, +date[3], +date[4], +date[5], +date[6]) + ttl * 1000;
        if (!Number.isFinite(expiresAt) || expiresAt < Date.now() + 30_000) throw new Error();
        return { url, expiresAt };
    } catch { throw new CloudDeliveryError(502, '文件服务返回了无效或已过期的 R2 地址'); }
}

/** NAS API v2 has only POST upload/restore. This adapter retains Hapla account
 * ownership and bounded background status, but never sends task IDs or tokens
 * to NAS. Only small control metadata is cached, never original media bytes. */
export class CloudFileDeliveryService {
    private readonly locks = new Map<string, Promise<unknown>>();
    private readonly uploads = new Set<string>();
    private readonly jobs = new Map<string, Job>();
    private readonly links = new Map<string, { value: Link; until: number }>();
    private readonly restores = new Map<string, Promise<Link>>();
    constructor(private readonly options: { endpoint?: string; directory: string; fetch?: typeof fetch }) {}

    private endpoint(): string {
        if (!this.options.endpoint) throw new CloudDeliveryError(503, 'Cloudflare 文件交付尚未配置');
        const url = new URL(this.options.endpoint);
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new CloudDeliveryError(503, 'Cloudflare 文件交付配置无效');
        return url.href.replace(/\/$/, '');
    }

    private async remote(path: '/v1/upload' | '/v1/restore', body: RequestInit['body'], signal?: AbortSignal, length?: number): Promise<Link> {
        const timeout = AbortSignal.timeout(CLOUD_REQUEST_TIMEOUT_MS);
        const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
        let response: Response;
        try {
            response = await (this.options.fetch ?? cloudControlRequest)(this.endpoint() + path, {
                method: 'POST', body, duplex: 'half', signal: combined, redirect: 'error',
                headers: { 'Content-Type': 'application/json', ...(length === undefined ? {} : { 'Content-Length': String(length) }) },
            } as RequestInit);
        } catch {
            throw new CloudDeliveryError(timeout.aborted ? 504 : 502, signal?.aborted ? '文件准备已取消' : timeout.aborted ? '等待 Cloudflare 就绪超时，可重试继续获取' : '文件缓存服务连接中断，请重试');
        }
        const reader = response.body?.getReader(); const chunks: Uint8Array[] = []; let bytes = 0;
        try {
            if (reader) for (;;) { const part = await reader.read(); if (part.done) break; bytes += part.value.length;
                if (bytes > 64 * 1024) throw new CloudDeliveryError(502, '文件服务响应过大'); chunks.push(part.value); }
        } finally { await reader?.cancel().catch(() => undefined); }
        let value: { url?: unknown; error?: string };
        try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
        catch { throw new CloudDeliveryError(502, '文件服务返回了无效响应'); }
        if (!response.ok) {
            const messages: Record<string, string> = {
                source_not_found: '此链接没有可恢复的 NAS 原文件', file_not_found: 'NAS 原文件不存在', source_changed: '原文件在读取期间变化，请写入完成后重试',
                busy: '文件服务繁忙，请稍后重试', upload_paused: 'Cloudflare 上传暂时暂停，请稍后重试', upload_timeout: '等待 Cloudflare 就绪超时，可重试继续获取',
                file_too_large: '文件超过缓存容量上限', invalid_url: '这不是当前文件服务签发的 R2 地址',
            };
            throw new CloudDeliveryError([400, 404, 409, 413, 429, 503, 504].includes(response.status) ? response.status : 502,
                messages[value.error ?? ''] ?? '文件服务暂时不可用，请重试');
        }
        return cloudLink(value.url);
    }

    private filename(accountId: string, id: string): string {
        if (!validId(id)) throw new CloudDeliveryError(404, '文件交付记录不存在');
        return join(this.options.directory, digest(accountId), id + '.json');
    }
    private async save(accountId: string, record: FileRecord): Promise<void> {
        const file = this.filename(accountId, record.id);
        await mkdir(join(this.options.directory, digest(accountId)), { recursive: true, mode: 0o700 });
        const temp = file + '.' + randomUUID();
        await writeFile(temp, JSON.stringify(record), { mode: 0o600 }); await rename(temp, file);
    }
    private async load(accountId: string, id: string): Promise<FileRecord> {
        try { return JSON.parse(await readFile(this.filename(accountId, id), 'utf8')); }
        catch { throw new CloudDeliveryError(404, '文件交付记录不存在'); }
    }
    private async locked<T>(key: string, work: () => Promise<T>): Promise<T> {
        const previous = this.locks.get(key) ?? Promise.resolve();
        const next = previous.catch(() => undefined).then(work); this.locks.set(key, next);
        try { return await next; } finally { if (this.locks.get(key) === next) this.locks.delete(key); }
    }
    private delivery(record: FileRecord, value: Link): CloudFileDelivery {
        // API v2 supplies one GET URL. Never invent a HEAD signature or edit
        // query parameters to pretend an attachment URL was provided.
        return { id: record.id, name: record.name, size: record.size, state: 'ready', stage: 'ready', progress: 1,
            url: value.url, downloadUrl: value.url, expiresAt: value.expiresAt };
    }

    async prepare(accountId: string, input: { sha256: string; name: string; size: number }): Promise<CloudFileDelivery> {
        this.endpoint();
        if (!validId(input.sha256) || !input.name || input.name.length > 512 || /[/\\\r\n\0]/.test(input.name) || ['.', '..'].includes(input.name)
            || !Number.isSafeInteger(input.size) || input.size <= CLOUD_FILE_THRESHOLD_BYTES || input.size > MAX_CLOUD_FILE_BYTES) throw new CloudDeliveryError(400, '文件交付元信息无效');
        const id = digest(input.sha256 + '\0' + input.name);
        return this.locked(digest(accountId) + ':' + id, async () => {
            let record: FileRecord;
            try { record = await this.load(accountId, id); }
            catch (error) { if (!(error instanceof CloudDeliveryError && error.statusCode === 404)) throw error; record = { id, ...input }; }
            if (record.size !== input.size || record.sha256 !== input.sha256 || record.name !== input.name) throw new CloudDeliveryError(409, '文件版本不一致');
            await this.save(accountId, record);
            const key = digest(accountId) + ':' + id;
            if (this.jobs.get(key)?.value.state === 'failed') this.jobs.delete(key);
            return this.inspect(accountId, record);
        });
    }

    async status(accountId: string, id: string): Promise<CloudFileDelivery> { return this.inspect(accountId, await this.load(accountId, id)); }

    private inspect(accountId: string, record: FileRecord): CloudFileDelivery {
        const key = digest(accountId) + ':' + record.id;
        const current = this.jobs.get(key);
        if (current && (current.pending || current.touched > Date.now() - 60_000 && (current.value.state !== 'ready' || (current.value.expiresAt ?? 0) > Date.now() + 120_000))) return current.value;
        if (!record.url) return { id: record.id, name: record.name, size: record.size, state: 'upload-required', stage: 'uploading-source', progress: 0 };
        const job: Job = { pending: true, touched: Date.now(), value: { id: record.id, name: record.name, size: record.size, state: 'preparing', stage: 'preparing', progress: 0 } };
        this.pruneJobs(); this.jobs.set(key, job);
        void this.resolve(accountId, record.url).then(async value => {
            record.url = value.url; await this.save(accountId, record); job.value = this.delivery(record, value);
        }).catch(error => { job.value = { ...job.value, state: 'failed', error: error instanceof Error ? error.message : '文件恢复失败，请重试' }; })
            .finally(() => { job.pending = false; job.touched = Date.now(); });
        return job.value;
    }
    private pruneJobs(): void {
        for (const [key, job] of this.jobs) if (!job.pending && job.touched < Date.now() - 60_000) this.jobs.delete(key);
        while (this.jobs.size >= 256) { const old = [...this.jobs].find(([, job]) => !job.pending); if (!old) throw new CloudDeliveryError(429, '文件准备队列繁忙'); this.jobs.delete(old[0]); }
    }

    async resolve(accountId: string, url: string, force = false, downloadFilename?: string): Promise<Link> {
        // Old signed links are inputs to NAS restore, not HTTP requests to
        // caller-selected hosts. NAS validates its exact bucket and mapping.
        try { const u = new URL(url); if (url.length > 16_384 || u.protocol !== 'https:' || u.username || u.password || !u.hostname.endsWith('.r2.cloudflarestorage.com')) throw new Error(); }
        catch { throw new CloudDeliveryError(400, '无效的 R2 文件地址'); }
        if (downloadFilename !== undefined && (!downloadFilename.trim() || Buffer.byteLength(downloadFilename) > 512 || /[/\\\x00-\x1f\x7f]/.test(downloadFilename) || ['.', '..'].includes(downloadFilename))) throw new CloudDeliveryError(400, '下载文件名无效');
        const u = new URL(url); const key = digest(accountId + '\0' + u.origin + u.pathname + '\0' + (downloadFilename ?? ''));
        const cached = this.links.get(key);
        if (!force && cached && cached.until > Date.now() && cached.value.expiresAt > Date.now() + 120_000) return cached.value;
        const existing = this.restores.get(key); if (existing) return existing;
        if (this.restores.size >= 4) throw new CloudDeliveryError(429, '文件恢复队列繁忙，请稍后重试');
        const task = this.remote('/v1/restore', JSON.stringify({ url, ...(downloadFilename ? { download: true, filename: downloadFilename } : {}) })).then(value => {
            if (downloadFilename) {
                const query = new URL(value.url).searchParams;
                if (!/^attachment(?:;|$)/i.test(query.get('response-content-disposition') ?? '') || query.get('response-content-type') !== 'application/octet-stream') throw new CloudDeliveryError(502, '文件服务未返回附件下载地址，请重试');
            }
            this.links.set(key, { value, until: Date.now() + 60_000 });
            while (this.links.size > 256) this.links.delete(this.links.keys().next().value!);
            return value;
        });
        this.restores.set(key, task);
        try { return await task; } finally { if (this.restores.get(key) === task) this.restores.delete(key); }
    }

    async upload(accountId: string, id: string, source: Readable, length: number, signal: AbortSignal): Promise<void> {
        const record = await this.load(accountId, id);
        if (length !== record.size) throw new CloudDeliveryError(409, '文件上传大小不匹配');
        const key = digest(accountId) + ':' + id;
        if (this.uploads.has(key)) throw new CloudDeliveryError(409, '这个文件正在上传，请稍后重试');
        if (this.uploads.size >= 2) throw new CloudDeliveryError(429, '文件上传队列繁忙，请稍后重试');
        this.pruneJobs();
        const job: Job = { pending: true, touched: Date.now(), value: { id, name: record.name, size: record.size, state: 'preparing', stage: 'uploading-source', progress: 0 } };
        this.uploads.add(key); this.jobs.set(key, job);
        const prefix = JSON.stringify({ filename: record.name }).slice(0, -1) + ',"base64":"'; const suffix = '"}';
        let bytes = 0; let verified = false; const hash = createHash('sha256');
        const body = Readable.from((async function* () {
            yield prefix; let carry: Buffer = Buffer.alloc(0);
            for await (const raw of source) {
                const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw); bytes += chunk.length;
                if (bytes > length || signal.aborted) throw new Error('文件大小变化或上传取消');
                hash.update(chunk); job.value.progress = .5 * bytes / length;
                const combined = carry.length ? Buffer.concat([carry, chunk]) : chunk;
                const end = combined.length - combined.length % 3;
                if (end) yield combined.subarray(0, end).toString('base64');
                carry = Buffer.from(combined.subarray(end));
            }
            if (bytes !== length || hash.digest('hex') !== record.sha256) throw new Error('文件内容校验失败，请重新打开');
            verified = true;
            if (carry.length) yield carry.toString('base64');
            job.value.stage = 'uploading-r2'; job.value.progress = .5; yield suffix;
        })(), { objectMode: false, highWaterMark: 256 * 1024 });
        body.on('error', () => undefined);
        const sourceError = (error: Error) => body.destroy(error);
        source.on('error', sourceError);
        const cancel = () => { body.destroy(new Error('文件准备已取消')); source.destroy(); };
        signal.addEventListener('abort', cancel, { once: true }); if (signal.aborted) cancel();
        try {
            const value = await this.remote('/v1/upload', body, signal, Buffer.byteLength(prefix + suffix) + 4 * Math.ceil(length / 3));
            if (bytes !== length || !verified) throw new CloudDeliveryError(502, '文件未完整传输');
            record.url = value.url; await this.save(accountId, record); job.value = this.delivery(record, value);
        } catch (error) { job.value = { ...job.value, state: 'failed', error: error instanceof Error ? error.message : '文件上传失败，请重试' }; throw error; }
        finally { job.pending = false; job.touched = Date.now(); signal.removeEventListener('abort', cancel); source.removeListener('error', sourceError); body.destroy(); this.uploads.delete(key); }
    }
}

export const cloudFiles = new CloudFileDeliveryService({ endpoint: process.env.HAPLA_R2_CACHE_URL, directory: join(process.env.DATA_DIR || './data', 'cloud-file-delivery') });
