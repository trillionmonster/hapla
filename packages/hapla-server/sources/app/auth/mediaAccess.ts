import { createHmac, timingSafeEqual } from 'node:crypto';

const COOKIE = 'hapla_media_access';
const TTL_SECONDS = 30 * 24 * 60 * 60;

// This credential authorizes only media reads. It is deliberately not an API
// bearer token, and ownership is checked against UploadedFile on every read.
export class MediaAccess {
    private readonly key: Buffer;

    constructor(secret: string, private readonly now: () => number = Date.now) {
        if (!secret) throw new Error('HAPLA_MASTER_SECRET is required');
        this.key = createHmac('sha256', secret).update('hapla/account-media/v1').digest();
    }

    issueCookie(accountId: string, secure: boolean): string {
        const payload = Buffer.from(JSON.stringify({ accountId, expires: this.now() + TTL_SECONDS * 1000 })).toString('base64url');
        const signature = createHmac('sha256', this.key).update(payload).digest('base64url');
        return `${COOKIE}=${payload}.${signature}; Path=/files/; HttpOnly; SameSite=Lax; Max-Age=${TTL_SECONDS}${secure ? '; Secure' : ''}`;
    }

    clearCookie(secure: boolean): string {
        return `${COOKIE}=; Path=/files/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? '; Secure' : ''}`;
    }

    accountId(cookie: string | undefined): string | null {
        const value = cookie?.split(';').map(part => part.trim()).find(part => part.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);
        if (!value || value.length > 2048) return null;
        const parts = value.split('.');
        if (parts.length !== 2) return null;
        const [payload, signature] = parts;
        if (!/^[A-Za-z0-9_-]+$/.test(payload) || !/^[A-Za-z0-9_-]{43}$/.test(signature)) return null;
        const expected = createHmac('sha256', this.key).update(payload).digest('base64url');
        if (signature.length !== expected.length || !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;
        try {
            const data = JSON.parse(Buffer.from(payload, 'base64url').toString());
            return typeof data.accountId === 'string' && data.accountId.length > 0
                && Number.isFinite(data.expires) && data.expires > this.now() ? data.accountId : null;
        } catch { return null; }
    }
}
