import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ rows: new Map<string, any>() }));
vi.mock('@/storage/db', () => ({ db: { previewBrowserSession: {
    findFirst: async ({ where }: any) => [...state.rows.values()].find(row => row.id === where.id && row.accountId === where.accountId && row.expiresAt > where.expiresAt.gt) ?? null,
    findMany: async ({ where }: any) => [...state.rows.values()].filter(row => row.expiresAt <= where.expiresAt.lte),
    create: async ({ data }: any) => { state.rows.set(data.id, data); return data; },
    deleteMany: async ({ where }: any) => { let count = 0; for (const [id, row] of state.rows) if (typeof where.id === 'string' ? id === where.id && row.accountId === where.accountId : where.id.in.includes(id)) { state.rows.delete(id); count++; } return { count }; },
} } }));
import { previewSessions, previewSessionCookie } from './previewSessions';
import { previewEvents } from './previewEvents';
beforeEach(() => { state.rows.clear(); vi.stubEnv('HAPLA_PREVIEW_HOST_TEMPLATE', '{handle}.preview.example.test'); });
afterEach(() => { vi.unstubAllEnvs(); previewEvents.removeAllListeners(); });
describe('browser-scoped isolated preview sessions', () => {
    it('reuses this account browser lease without sharing it across accounts', async () => {
        const a = (await previewSessions.ensure('account-a', undefined))!;
        const cookie = previewSessionCookie('account-a', a.id, true).split(';')[0];
        expect((await previewSessions.ensure('account-a', cookie))!.id).toBe(a.id);
        const b = (await previewSessions.ensure('account-b', cookie))!;
        expect(b.id).not.toBe(a.id); expect(await previewSessions.valid(a.id, 'account-b')).toBe(false);
    });
    it('revokes only the logged-out browser lease and keeps another device active', async () => {
        const first = (await previewSessions.ensure('account-a', undefined))!;
        const second = (await previewSessions.ensure('account-a', undefined))!;
        const revoked = vi.fn(); previewEvents.on('session-revoked', revoked);
        await previewSessions.revoke('account-a', previewSessionCookie('account-a', first.id, false));
        expect(await previewSessions.valid(first.id, 'account-a')).toBe(false);
        expect(await previewSessions.valid(second.id, 'account-a')).toBe(true);
        expect(revoked).toHaveBeenCalledWith(first.id);
    });
    it('rejects expired viewer leases while anonymous keyed grants have no account lease', async () => {
        const lease = (await previewSessions.ensure('account-a', undefined))!; lease.expiresAt = new Date(0);
        expect(await previewSessions.valid(lease.id, 'account-a')).toBe(false);
        expect(await previewSessions.valid(undefined, 'account-a')).toBe(false);
        expect(await previewSessions.valid(undefined, null)).toBe(true);
    });
    it('does not create a lease when isolated preview hosting is disabled', async () => {
        vi.stubEnv('HAPLA_PREVIEW_HOST_TEMPLATE', '');
        expect(await previewSessions.ensure('account-a', undefined)).toBeNull(); expect(state.rows.size).toBe(0);
    });
});
