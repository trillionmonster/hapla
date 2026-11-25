import { z } from 'zod';

export const previewAccessSchema = z.enum(['private', 'users', 'key']);
export type PreviewAccess = z.infer<typeof previewAccessSchema>;
export const previewRegistrationSchema = z.object({
    handle: z.string().regex(/^[a-f0-9]{32}$/),
    name: z.string().min(1).max(100),
    machineId: z.string().min(1).max(128),
    target: z.string().url().max(4096),
    revision: z.number().int().nonnegative(),
    access: previewAccessSchema.default('private'),
    hasShareKey: z.boolean().default(false),
});
export type PreviewRegistration = z.infer<typeof previewRegistrationSchema>;
export type PreviewListing = (PreviewRegistration & { canManage: true }) | { handle: string; name: string; access: PreviewAccess; canManage: false };
export type PreviewHttpRequest = { id: string; target: string; prefix: string; method: string; headers: Record<string, string | string[]> };
export type PreviewHttpHead = { status: number; headers: Record<string, string | string[] | undefined> };

export function validatePreviewTarget(value: string): string {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) throw new Error('请输入不含账号密码的 HTTP(S) 开发服务地址');
    return url.toString();
}
