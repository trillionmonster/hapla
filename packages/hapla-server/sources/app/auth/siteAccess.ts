import { createHmac, randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { readFileSync } from 'node:fs';

const scrypt = promisify(scryptCallback);
export const SITE_ACCESS_COOKIE = 'hapla_site_access';
const SESSION_SECONDS = 30 * 24 * 60 * 60;

export class SiteAccess {
    private readonly salt: Buffer;
    private readonly expected: Buffer;
    private readonly signingKey: Buffer;
    private readonly attempts = new Map<string, { count: number; until: number }>();
    private inFlight = 0;

    constructor(passwordHash: string, signingSecret: string, private readonly now = Date.now) {
        const parts = passwordHash.trim().split('$');
        if (parts.length !== 3 || parts[0] !== 'scrypt' || !/^[a-f0-9]{32}$/.test(parts[1]) || !/^[a-f0-9]{64}$/.test(parts[2])) {
            throw new Error('Invalid HAPLA_ACCESS_PASSWORD_HASH configuration');
        }
        if (!signingSecret) throw new Error('HAPLA_MASTER_SECRET is required for site access');
        this.salt = Buffer.from(parts[1], 'hex');
        this.expected = Buffer.from(parts[2], 'hex');
        this.signingKey = createHmac('sha256', signingSecret).update('hapla-site-access-v1\0').update(passwordHash.trim()).digest();
    }

    static fromEnvironment(env = process.env): SiteAccess | null {
        const value = env.HAPLA_ACCESS_PASSWORD_HASH_FILE
            ? readFileSync(env.HAPLA_ACCESS_PASSWORD_HASH_FILE, 'utf8').trim()
            : env.HAPLA_ACCESS_PASSWORD_HASH?.trim();
        if (env.HAPLA_ACCESS_PASSWORD_HASH_FILE && !value) throw new Error('Site access password file is empty');
        return value ? new SiteAccess(value, env.HAPLA_MASTER_SECRET || '') : null;
    }

    async verifyPassword(password: unknown, client: string): Promise<'accepted' | 'denied' | 'limited'> {
        const now = this.now();
        // Bounded memory and bounded simultaneous scrypt jobs, including requests
        // with malformed passwords. Never trust caller-supplied forwarding IPs.
        for (const [key, value] of this.attempts) if (value.until <= now) this.attempts.delete(key);
        const previous = this.attempts.get(client);
        if ((previous?.count ?? 0) >= 10 || this.inFlight >= 4 || (!previous && this.attempts.size >= 10000)) return 'limited';
        this.attempts.set(client, { count: (previous?.count ?? 0) + 1, until: previous?.until ?? now + 60000 });
        if (typeof password !== 'string' || password.length === 0 || Buffer.byteLength(password) > 1024) return 'denied';
        this.inFlight += 1;
        try {
            const actual = await scrypt(password, this.salt, 32) as Buffer;
            const accepted = timingSafeEqual(actual, this.expected);
            if (accepted) this.attempts.delete(client);
            return accepted ? 'accepted' : 'denied';
        } finally {
            this.inFlight -= 1;
        }
    }

    hasSession(cookieHeader?: string): boolean {
        const cookies = (cookieHeader || '').split(';').map(part => part.trim());
        const matching = cookies.filter(part => part.startsWith(`${SITE_ACCESS_COOKIE}=`));
        if (matching.length !== 1) return false;
        const token = matching[0].slice(SITE_ACCESS_COOKIE.length + 1);
        if (token.length > 256) return false;
        const [version, expiry, nonce, signature, extra] = token.split('.');
        if (extra !== undefined || version !== 'v1' || !/^\d{10}$/.test(expiry || '') || !/^[a-f0-9]{32}$/.test(nonce || '') || !/^[a-f0-9]{64}$/.test(signature || '')) return false;
        const seconds = Math.floor(this.now() / 1000);
        if (Number(expiry) <= seconds || Number(expiry) > seconds + SESSION_SECONDS) return false;
        const expected = createHmac('sha256', this.signingKey).update(`${version}.${expiry}.${nonce}`).digest();
        return timingSafeEqual(expected, Buffer.from(signature, 'hex'));
    }

    issueCookie(secure: boolean): string {
        const payload = `v1.${Math.floor(this.now() / 1000) + SESSION_SECONDS}.${randomBytes(16).toString('hex')}`;
        const signature = createHmac('sha256', this.signingKey).update(payload).digest('hex');
        return `${SITE_ACCESS_COOKIE}=${payload}.${signature}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_SECONDS}${secure ? '; Secure' : ''}`;
    }
}

export function safeReturnPath(value: unknown): string {
    if (typeof value !== 'string' || value.length > 8192 || !value.startsWith('/') || value.startsWith('//') || /[\\\u0000-\u0020\u007f]/.test(value)) return '/';
    try {
        const decoded = decodeURIComponent(value);
        if (decoded.startsWith('//') || /[\\\u0000-\u0020\u007f]/.test(decoded)) return '/';
        const parsed = new URL(value, 'http://hapla.invalid');
        if (parsed.origin !== 'http://hapla.invalid' || /^\/access(?:\/|$)/.test(parsed.pathname)) return '/';
    } catch { return '/'; }
    return value;
}
