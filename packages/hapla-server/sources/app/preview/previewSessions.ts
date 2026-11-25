import { createHash, randomBytes } from 'node:crypto';
import { db } from '@/storage/db';
import { previewSharingConfigured } from './previewAccess';
import { previewEvents } from './previewEvents';
const cookieName = (accountId: string) => 'hapla_preview_session_' + createHash('sha256').update(accountId).digest('hex').slice(0, 16);
function sessionId(accountId: string, cookies: string | undefined): string | undefined {
    const COOKIE = cookieName(accountId);
    const id = cookies?.split(';').map(value => value.trim()).find(value => value.startsWith(COOKIE + '='))?.slice(COOKIE.length + 1);
    return id && /^[a-f0-9]{32}$/.test(id) ? id : undefined;
}
export function previewSessionCookie(accountId: string, id: string, secure: boolean): string {
    return `${cookieName(accountId)}=${id}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${id ? 86400 : 0}${secure ? '; Secure' : ''}`;
}
export const previewSessions = {
    async ensure(accountId: string, cookies: string | undefined) {
        if (!previewSharingConfigured()) return null;
        const id = sessionId(accountId, cookies);
        const current = id && await db.previewBrowserSession.findFirst({ where: { id, accountId, expiresAt: { gt: new Date() } } });
        if (current) return current;
        const expired = await db.previewBrowserSession.findMany({ where: { expiresAt: { lte: new Date() } }, select: { id: true } });
        if (expired.length) {
            await db.previewBrowserSession.deleteMany({ where: { id: { in: expired.map(row => row.id) } } });
            for (const row of expired) previewEvents.emit('session-revoked', row.id);
        }
        return db.previewBrowserSession.create({ data: { id: randomBytes(16).toString('hex'), accountId, expiresAt: new Date(Date.now() + 86400_000) } });
    },
    async valid(id: string | undefined, viewer: string | null) {
        if (!viewer) return !id;
        return !!id && !!await db.previewBrowserSession.findFirst({ where: { id, accountId: viewer, expiresAt: { gt: new Date() } }, select: { id: true } });
    },
    async revoke(accountId: string, cookies: string | undefined) {
        const id = sessionId(accountId, cookies); if (!id) return;
        const result = await db.previewBrowserSession.deleteMany({ where: { id, accountId } });
        if (result.count) previewEvents.emit('session-revoked', id);
    },
};
