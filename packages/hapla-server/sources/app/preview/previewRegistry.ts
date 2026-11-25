import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { previewSharingConfigured } from './previewAccess';
import { previewChanged } from './previewEvents';
import { db } from '@/storage/db';
import { validatePreviewTarget, type PreviewRegistration, type PreviewListing, type PreviewAccess } from '@hapla/wire';

function registration(row: { handle: string; name: string; machineId: string; target: string; revision: number; access: string; shareKeyHash: string | null }): PreviewRegistration {
    return { handle: row.handle, name: row.name, machineId: row.machineId, target: row.target, revision: row.revision, access: row.access as PreviewAccess, hasShareKey: !!row.shareKeyHash };
}
export function previewKeyHash(key: string) { return createHash('sha256').update(key).digest('hex'); }
export function matchesPreviewKey(hash: string | null, key: string | undefined): boolean {
    if (!hash || !key || key.length > 256) return false;
    const expected = Buffer.from(hash, 'hex');
    const actual = Buffer.from(previewKeyHash(key), 'hex');
    return expected.length === actual.length && timingSafeEqual(expected, actual);
}
export const previewRegistry = {
    async list(accountId: string): Promise<PreviewRegistration[]> {
        return (await db.previewRegistration.findMany({ where: { accountId }, orderBy: { createdAt: 'desc' } })).map(registration);
    },
    async visible(accountId: string): Promise<PreviewListing[]> {
        return (await db.previewRegistration.findMany({ where: { OR: [{ accountId }, { access: 'users' }] }, orderBy: { createdAt: 'desc' } })).map(row => row.accountId === accountId ? { ...registration(row), canManage: true as const } : { handle: row.handle, name: row.name, access: 'users' as const, canManage: false as const });
    },
    async get(accountId: string, handle: string): Promise<PreviewRegistration | null> {
        const row = await db.previewRegistration.findFirst({ where: { accountId, handle } });
        return row && registration(row);
    },
    async lookup(handle: string) { return db.previewRegistration.findUnique({ where: { handle } }); },
    async save(accountId: string, input: { handle?: string; name: string; machineId: string; target: string; revision?: number; access?: PreviewAccess }): Promise<PreviewRegistration> {
        if (!await db.machine.findFirst({ where: { accountId, id: input.machineId }, select: { id: true } })) throw new Error('工作台不属于当前账号');
        const current = input.handle ? await db.previewRegistration.findFirst({ where: { accountId, handle: input.handle } }) : null;
        if (input.handle && !current) throw new Error('代理不存在或不属于当前账号');
        const access = input.access ?? current?.access ?? 'private';
        if (access !== 'private' && !previewSharingConfigured()) throw new Error('开启共享前需配置独立预览域名');
        const data = { name: input.name, machineId: input.machineId, target: validatePreviewTarget(input.target), access };
        if (input.handle) {
            if (typeof input.revision !== 'number') throw new Error('更新代理需要当前版本，请刷新后重试');
            const changed = access !== current!.access;
            const updated = await db.previewRegistration.updateMany({ where: { accountId, handle: input.handle, revision: input.revision }, data: { ...data, revision: { increment: 1 }, ...(changed ? { accessVersion: { increment: 1 }, shareKeyHash: null } : {}) } });
            if (!updated.count) throw new Error('代理不存在或配置已更新，请刷新后重试');
            if (changed || current!.target !== data.target || current!.machineId !== data.machineId) previewChanged(input.handle);
            return (await this.get(accountId, input.handle))!;
        }
        if (await db.previewRegistration.count({ where: { accountId } }) >= 100) throw new Error('开发代理数量已达上限，请先删除不用的代理');
        return registration(await db.previewRegistration.create({ data: { ...data, accountId, handle: randomBytes(16).toString('hex') } }));
    },
    async shareKey(accountId: string, handle: string, revision: number, operation: 'rotate' | 'revoke') {
        const key = operation === 'rotate' ? randomBytes(32).toString('base64url') : undefined;
        const updated = await db.previewRegistration.updateMany({ where: { accountId, handle, revision, access: 'key' }, data: { shareKeyHash: key ? previewKeyHash(key) : null, revision: { increment: 1 }, accessVersion: { increment: 1 } } });
        if (!updated.count) throw new Error('代理不存在、共享模式不符或版本已更新，请刷新后重试');
        previewChanged(handle);
        return { registration: (await this.get(accountId, handle))!, ...(key ? { key } : {}) };
    },
    async remove(accountId: string, handle: string) {
        const removed = (await db.previewRegistration.deleteMany({ where: { accountId, handle } })).count > 0;
        if (removed) previewChanged(handle);
        return removed;
    },
};
