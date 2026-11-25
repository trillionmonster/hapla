import { createHmac, timingSafeEqual } from 'node:crypto';

type Request = { headers: Record<string, string | string[] | undefined>; protocol?: string };
export type PreviewGrant = { handle: string; viewer: string | null; version: number; expires: number; session?: string };

export function previewSharingConfigured(): boolean {
    const template = process.env.HAPLA_PREVIEW_HOST_TEMPLATE;
    if (!template || template.split('{handle}').length !== 2) return false;
    const hostname = template.replace('{handle}', 'a'.repeat(32));
    return hostname.length <= 253 && hostname.split('.').length > 1 && hostname.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label));
}

export function browserOrigin(request: Request): URL {
    const proto = String(request.headers['x-forwarded-proto'] ?? request.protocol ?? 'http').split(',')[0].trim();
    const host = String(request.headers['x-forwarded-host'] ?? request.headers.host).split(',')[0].trim();
    const url = new URL(`${proto === 'https' ? 'https' : 'http'}://${host}`);
    if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('Invalid browser host');
    return url;
}

/** Preserve the actual browser protocol/port while isolating each upstream's storage. */
export function isolatedPreviewOrigin(request: Request, handle: string): URL | null {
    const template = process.env.HAPLA_PREVIEW_HOST_TEMPLATE;
    if (!template) return null;
    if (!previewSharingConfigured()) throw new Error('Invalid preview host template');
    const url = browserOrigin(request);
    url.hostname = template.replace('{handle}', handle);
    return url;
}

function signature(value: string) {
    const secret = process.env.HAPLA_MASTER_SECRET;
    if (!secret) throw new Error('HAPLA_MASTER_SECRET is required');
    return createHmac('sha256', secret).update('hapla-preview-grant-v1:' + value).digest();
}
export function issuePreviewGrant(handle: string, viewer: string | null, version: number, session?: { id: string; expiresAt: Date }): string {
    const value = Buffer.from(JSON.stringify({ handle, viewer, version, expires: Math.min(Date.now() + 24 * 60 * 60_000, session?.expiresAt.getTime() ?? Infinity), ...(session ? { session: session.id } : {}) })).toString('base64url');
    return `${value}.${signature(value).toString('base64url')}`;
}
export function verifyPreviewGrant(token: string | undefined, handle: string, version: number): PreviewGrant | null {
    if (!token || token.length > 2048) return null;
    try {
        const [value, sig, extra] = token.split('.');
        if (extra || !sig) return null;
        const actual = Buffer.from(sig, 'base64url'); const expected = signature(value);
        if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
        const grant = JSON.parse(Buffer.from(value, 'base64url').toString()) as PreviewGrant;
        return grant.handle === handle && grant.version === version && grant.expires > Date.now() && (grant.viewer === null || typeof grant.viewer === 'string') ? grant : null;
    } catch { return null; }
}
