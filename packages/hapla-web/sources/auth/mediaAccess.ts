import type { AuthCredentials } from './tokenStorage';
import { getServerUrl } from '@/sync/serverConfig';

const REQUEST_TIMEOUT_MS = 12_000;
const RENEW_AFTER_MS = 12 * 60 * 60 * 1000;
let issuedFor: string | null = null;
let issuedAt = 0;
let pending: { token: string; promise: Promise<void> } | null = null;

async function requestMediaAccess(token: string, method: 'POST' | 'DELETE'): Promise<void> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
        const response = await fetch(`${getServerUrl()}/v1/account/media-access`, {
            method,
            headers: { Authorization: `Bearer ${token}` },
            credentials: 'include',
            cache: 'no-store',
            signal: controller.signal,
        });
        if (!response.ok) throw new Error('无法建立文件访问权限，请重试');
    } catch {
        throw new Error(method === 'DELETE' ? '退出未完成，无法清除文件访问权限，请重试' : '无法建立文件访问权限，请检查连接后重试');
    } finally {
        clearTimeout(timeout);
    }
}

/** Establish the account cookie before mounting images, audio or video. */
export async function ensureMediaAccess(credentials: AuthCredentials): Promise<void> {
    if (typeof window === 'undefined') return;
    const token = credentials.token;
    if (issuedFor === token && Date.now() - issuedAt < RENEW_AFTER_MS) return;
    if (pending?.token === token) return pending.promise;
    // Serialize account changes so an older response cannot overwrite the new cookie.
    const previous = pending?.promise;
    const promise = (async () => {
        await previous?.catch(() => undefined);
        await requestMediaAccess(token, 'POST');
        issuedFor = token;
        issuedAt = Date.now();
    })();
    pending = { token, promise };
    try { await promise; }
    finally { if (pending?.promise === promise) pending = null; }
}

export async function clearMediaAccess(credentials: AuthCredentials): Promise<void> {
    if (typeof window === 'undefined') return;
    await pending?.promise.catch(() => undefined);
    await requestMediaAccess(credentials.token, 'DELETE');
    issuedFor = null;
    issuedAt = 0;
}
