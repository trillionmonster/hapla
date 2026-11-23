import { randomBytes } from 'node:crypto';
import { db } from '@/storage/db';
import { validatePreviewTarget, type PreviewRegistration } from '@hapla/wire';

export const previewRegistry = {
    async list(accountId: string): Promise<PreviewRegistration[]> {
        return db.previewRegistration.findMany({ where: { accountId }, select: { handle: true, name: true, machineId: true, target: true, revision: true }, orderBy: { createdAt: 'desc' } });
    },
    async get(accountId: string, handle: string): Promise<PreviewRegistration | null> {
        return db.previewRegistration.findFirst({ where: { accountId, handle }, select: { handle: true, name: true, machineId: true, target: true, revision: true } });
    },
    async save(accountId: string, input: { handle?: string; name: string; machineId: string; target: string; revision?: number }): Promise<PreviewRegistration> {
        if (!await db.machine.findFirst({ where: { accountId, id: input.machineId }, select: { id: true } })) throw new Error('工作台不属于当前账号');
        const data = { name: input.name, machineId: input.machineId, target: validatePreviewTarget(input.target) };
        if (input.handle) {
            if (typeof input.revision !== 'number') throw new Error('更新代理需要当前版本，请刷新后重试');
            const updated = await db.previewRegistration.updateMany({ where: { accountId, handle: input.handle, revision: input.revision }, data: { ...data, revision: { increment: 1 } } });
            if (!updated.count) throw new Error('代理不存在或配置已更新，请刷新后重试');
            return (await this.get(accountId, input.handle))!;
        }
        if (await db.previewRegistration.count({ where: { accountId } }) >= 100) throw new Error('开发代理数量已达上限，请先删除不用的代理');
        const handle = randomBytes(16).toString('hex');
        await db.previewRegistration.create({ data: { ...data, accountId, handle } });
        return { ...data, handle, revision: 0 };
    },
    async remove(accountId: string, handle: string) { await db.previewRegistration.deleteMany({ where: { accountId, handle } }); },
};
