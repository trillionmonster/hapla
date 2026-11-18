import { readFile, realpath, stat } from 'node:fs/promises';
import { resolve, sep, basename } from 'node:path';
import pg from 'pg';
import { CloudDeliveryError } from './cloudFileDelivery';

export class NasFileSource {
    private pool?: pg.Pool;
    constructor(private options: { root?: string; origin?: string; databaseFile?: string; query?: (key: string) => Promise<any> }) {}
    async resolve(address: string, downloadName?: string) {
        if (!this.options.root || !this.options.origin || !this.options.databaseFile && !this.options.query) throw new CloudDeliveryError(503, '局域网原文件索引未配置');
        let key: string;
        try {
            const url = new URL(address), base = new URL(this.options.origin.replace(/\/$/, '') + '/');
            if (url.origin !== base.origin || !url.pathname.startsWith(base.pathname) || url.username || url.password || url.hash || address.length > 16384) throw new Error();
            key = decodeURIComponent(url.pathname.slice(base.pathname.length));
            if (!key || key.includes('\0')) throw new Error();
        } catch { throw new CloudDeliveryError(400, '不是当前文件服务签发的地址'); }
        if (downloadName !== undefined && (!downloadName.trim() || Buffer.byteLength(downloadName) > 512 || /[/\\\x00-\x1f\x7f]/.test(downloadName) || ['.', '..'].includes(downloadName))) throw new CloudDeliveryError(400, '下载文件名无效');
        let row;
        if (this.options.query) row = await this.options.query(key);
        else {
            if (!this.pool) {
                this.pool = new pg.Pool({ connectionString: (await readFile(this.options.databaseFile!, 'utf8')).trim(), max: 2, connectionTimeoutMillis: 5000, query_timeout: 5000, idleTimeoutMillis: 30000 });
                // An idle connection failure must not take down the API process.
                this.pool.on('error', () => undefined);
            }
            const result = await this.pool.query('SELECT v.source_path,v.sha256,v.size_bytes,v.content_type,a.display_name FROM cache_copies c JOIN asset_versions v ON v.id=c.version_id JOIN assets a ON a.id=v.asset_id WHERE c.object_key=$1 AND v.source_state=\'AVAILABLE\'', [key]);
            row = result.rows[0];
        }
        if (!row) throw new CloudDeliveryError(404, '此地址没有 NAS 原文件记录');
        const root = await realpath(this.options.root), path = await realpath(resolve(root, row.source_path)).catch(() => '');
        if (!path.startsWith(root + sep)) throw new CloudDeliveryError(404, 'NAS 原文件不可用');
        const info = await stat(path).catch(() => null);
        if (!info?.isFile() || info.size !== Number(row.size_bytes)) throw new CloudDeliveryError(409, 'NAS 原文件已变化');
        return { path, sha256: row.sha256 as string, size: info.size, name: downloadName ?? basename(row.display_name || key), contentType: row.content_type || 'application/octet-stream' };
    }
}
export const nasFileSource = new NasFileSource({ root: process.env.HAPLA_NAS_SOURCE_ROOT, origin: process.env.HAPLA_R2_SOURCE_ORIGIN, databaseFile: process.env.HAPLA_R2_SOURCE_DATABASE_URL_FILE });
