import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, writeFile, rename, rm, stat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { CloudFileDelivery } from '@hapla/wire';
import { CloudDeliveryError, MAX_CLOUD_FILE_BYTES } from './cloudFileDelivery';
import { getStoredFileContentType } from './files';

const digest = (v: string) => createHash('sha256').update(v).digest('hex');
const validId = (v: string) => /^[a-f0-9]{64}$/.test(v);
const TTL = 24 * 60 * 60_000;
const ACCOUNT_BUDGET = 32 * 1024 ** 3;
type Record = { id: string; sha256: string; name: string; size: number; expiresAt: number; source?: string; contentType?: string };
export class DirectFileDeliveryService {
    private uploads = new Set<string>();
    private pending: Promise<unknown> = Promise.resolve();
    constructor(private directory: string) {}
    private folder(account: string) { return join(this.directory, digest(account)); }
    private filename(account: string, id: string, suffix = '.json') {
        if (!validId(id)) throw new CloudDeliveryError(404, '文件不存在');
        return join(this.folder(account), id + suffix);
    }
    private async save(account: string, record: Record) {
        await mkdir(this.folder(account), { recursive: true, mode: 0o700 });
        const name = this.filename(account, record.id), temp = name + '.' + randomUUID();
        await writeFile(temp, JSON.stringify(record), { mode: 0o600 }); await rename(temp, name);
    }
    private async load(account: string, id: string): Promise<Record> {
        try {
            const value = JSON.parse(await readFile(this.filename(account, id), 'utf8')) as Record;
            if (value.expiresAt < Date.now()) throw new Error('expired');
            return value;
        } catch { throw new CloudDeliveryError(404, '本地文件地址已过期，请重新打开'); }
    }
    /** Expired copies are removed even when an account stops opening files. */
    async cleanup(): Promise<void> {
        for (const folder of await readdir(this.directory).catch(() => [])) {
            if (!validId(folder)) continue;
            const path = join(this.directory, folder);
            for (const name of await readdir(path).catch(() => [])) {
                if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
                try {
                    const record = JSON.parse(await readFile(join(path, name), 'utf8')) as Record;
                    if (record.expiresAt >= Date.now() || [...this.uploads].some(key => key.endsWith(':' + record.id))) continue;
                    await rm(join(path, record.id + '.bin'), { force: true });
                    await rm(join(path, name), { force: true });
                } catch { /* A concurrent prepare may be replacing metadata. */ }
            }
            for (const name of await readdir(path).catch(() => [])) {
                if (!name.endsWith('.part')) continue;
                const file = join(path, name), info = await stat(file).catch(() => null);
                if (info && info.mtimeMs < Date.now() - TTL) await rm(file, { force: true });
            }
        }
    }
    private async delivery(account: string, record: Record): Promise<CloudFileDelivery> {
        const info = await stat(record.source ?? this.filename(account, record.id, '.bin')).catch(() => null);
        const ready = info?.isFile() && info.size === record.size;
        const url = `/files/direct/${record.id}`;
        return { ...record, source: undefined, state: ready ? 'ready' : 'upload-required', stage: ready ? 'ready' : 'uploading-source', progress: ready ? 1 : 0,
            ...(ready ? { url, downloadUrl: url + '?download=1' } : {}) } as CloudFileDelivery;
    }
    async prepare(account: string, input: { sha256: string; name: string; size: number }): Promise<CloudFileDelivery> {
        if (!validId(input.sha256) || !input.name || Buffer.byteLength(input.name) > 512 || /[/\\\x00-\x1f\x7f]/.test(input.name) || ['.', '..'].includes(input.name)
            || !Number.isSafeInteger(input.size) || input.size < 1 || input.size > MAX_CLOUD_FILE_BYTES) throw new CloudDeliveryError(400, '本地文件元信息无效');
        const task = this.pending.catch(() => undefined).then(async () => {
            const id = digest(input.sha256 + '\0' + input.name);
            const records = await readdir(this.folder(account)).catch(() => []);
            let allocated = 0;
            for (const name of records.filter(n => /^[a-f0-9]{64}\.json$/.test(n))) {
                const old = JSON.parse(await readFile(join(this.folder(account), name), 'utf8')) as Record;
                if (old.expiresAt < Date.now() && !this.uploads.has(account + ':' + old.id)) {
                    await rm(this.filename(account, old.id, '.bin'), { force: true }); await rm(this.filename(account, old.id), { force: true });
                } else if (!old.source && old.id !== id) allocated += old.size;
            }
            if (allocated + input.size > ACCOUNT_BUDGET) throw new CloudDeliveryError(429, '本地文件临时空间已满，请稍后重试');
            const record: Record = { id, ...input, expiresAt: Date.now() + TTL };
            await this.save(account, record); return this.delivery(account, record);
        });
        this.pending = task; return task;
    }
    async status(account: string, id: string) { return this.delivery(account, await this.load(account, id)); }
    async upload(account: string, id: string, source: Readable, length: number, signal: AbortSignal): Promise<void> {
        const record = await this.load(account, id), key = account + ':' + id;
        if (record.source || length !== record.size) throw new CloudDeliveryError(409, '本地文件大小不匹配');
        if (this.uploads.has(key) || this.uploads.size >= 4) throw new CloudDeliveryError(429, '本地文件传输繁忙，请重试');
        this.uploads.add(key);
        const temp = this.filename(account, id, '.' + randomUUID() + '.part');
        const hash = createHash('sha256'); let bytes = 0;
        const verify = new Transform({ transform(chunk, _encoding, done) {
            bytes += chunk.length;
            if (bytes > record.size) return done(new Error('文件大小变化'));
            hash.update(chunk); done(null, chunk);
        } });
        try {
            await pipeline(source, verify, createWriteStream(temp, { flags: 'wx', mode: 0o600 }), { signal });
            if (bytes !== length || hash.digest('hex') !== record.sha256) throw new CloudDeliveryError(409, '本地文件校验失败');
            await rename(temp, this.filename(account, id, '.bin'));
        } finally { this.uploads.delete(key); await rm(temp, { force: true }); }
    }
    async grantSource(account: string, source: { path: string; sha256: string; size: number; name: string; contentType: string }) {
        const record: Record = { id: digest('nas\0' + source.sha256 + '\0' + source.name), sha256: source.sha256, name: source.name, size: source.size,
            contentType: source.contentType, source: source.path, expiresAt: Date.now() + TTL };
        await this.save(account, record); return this.delivery(account, record);
    }
    async file(account: string, id: string) {
        const record = await this.load(account, id);
        const path = record.source ?? this.filename(account, id, '.bin');
        const info = await stat(path).catch(() => null);
        if (!info?.isFile() || info.size !== record.size) throw new CloudDeliveryError(404, '本地原文件不可用');
        return { path, name: record.name, size: record.size, contentType: record.contentType ?? getStoredFileContentType(record.name) };
    }
}
export const directFiles = new DirectFileDeliveryService(join(process.env.DATA_DIR || './data', 'direct-file-delivery'));
