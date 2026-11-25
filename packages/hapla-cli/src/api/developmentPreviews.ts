import { configuration } from '@/configuration';
import { validatePreviewTarget, type PreviewRegistration } from '@hapla/wire';

export async function listDevelopmentPreviews(token: string): Promise<PreviewRegistration[]> {
    const response = await fetch(`${configuration.serverUrl}/v1/previews`, { headers: { Authorization: `Bearer ${token}` } });
    if (!response.ok) throw new Error(`无法读取开发代理 (${response.status})`);
    return (await response.json() as { registrations: PreviewRegistration[] }).registrations;
}

export async function registerDevelopmentPreview(context: { token: string; machineId: string }, input: { target: string; name: string; handle?: string }) {
    const target = validatePreviewTarget(input.target);
    const registrations = await listDevelopmentPreviews(context.token);
    const existing = input.handle ? registrations.find(item => item.handle === input.handle) : registrations.find(item => item.machineId === context.machineId && item.name === input.name);
    if (input.handle && !existing) throw new Error('代理不存在或不属于当前账号');
    const response = await fetch(`${configuration.serverUrl}/v1/previews`, {
        method: 'POST', headers: { Authorization: `Bearer ${context.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...input, target, machineId: context.machineId, handle: existing?.handle, revision: existing?.revision }),
    });
    const result = await response.json() as PreviewRegistration & { error?: string };
    if (!response.ok) throw new Error(result.error ?? `代理注册失败 (${response.status})`);
    return { handle: result.handle, name: result.name, url: `/preview/${result.handle}/`, target: result.target, access: result.access ?? 'private' };
}
