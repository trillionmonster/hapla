import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/sync/serverConfig', () => ({ getServerUrl: () => 'http://hapla.example:12345' }));
const credentials = (token: string) => ({ token, secret: 'private-test-secret' });
const fetchMock = vi.fn();

beforeEach(() => {
    vi.resetModules();
    vi.stubGlobal('window', {});
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockReset().mockResolvedValue(new Response(null, { status: 204 }));
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('account media authentication', () => {
    it('includes cookies and the account bearer, deduplicates startup, and waits until authorized', async () => {
        let complete!: (response: Response) => void;
        fetchMock.mockImplementation(() => new Promise<Response>(resolve => { complete = resolve; }));
        const { ensureMediaAccess } = await import('./mediaAccess');
        let ready = false;
        const first = ensureMediaAccess(credentials('account-a')).then(() => { ready = true; });
        const second = ensureMediaAccess(credentials('account-a'));
        await Promise.resolve();
        expect(ready).toBe(false);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(fetchMock).toHaveBeenCalledWith('http://hapla.example:12345/v1/account/media-access', expect.objectContaining({
            method: 'POST', credentials: 'include', cache: 'no-store',
            headers: { Authorization: 'Bearer account-a' },
        }));
        complete(new Response(null, { status: 204 }));
        await Promise.all([first, second]);
        expect(ready).toBe(true);
    });

    it('serializes different accounts so the old response cannot replace the new cookie', async () => {
        let complete!: (response: Response) => void;
        fetchMock.mockImplementationOnce(() => new Promise<Response>(resolve => { complete = resolve; }));
        const { ensureMediaAccess } = await import('./mediaAccess');
        const first = ensureMediaAccess(credentials('account-a'));
        const second = ensureMediaAccess(credentials('account-b'));
        await Promise.resolve();
        expect(fetchMock).toHaveBeenCalledTimes(1);
        complete(new Response(null, { status: 204 }));
        await Promise.all([first, second]);
        expect(fetchMock.mock.calls.map(([, options]) => options.headers.Authorization)).toEqual(['Bearer account-a', 'Bearer account-b']);
    });

    it('renews long running sessions and clears the server cookie on logout', async () => {
        vi.useFakeTimers();
        const { ensureMediaAccess, clearMediaAccess } = await import('./mediaAccess');
        await ensureMediaAccess(credentials('account-a'));
        await ensureMediaAccess(credentials('account-a'));
        expect(fetchMock).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(12 * 60 * 60 * 1000);
        await ensureMediaAccess(credentials('account-a'));
        await clearMediaAccess(credentials('account-a'));
        expect(fetchMock.mock.calls.map(([, options]) => options.method)).toEqual(['POST', 'POST', 'DELETE']);
        await ensureMediaAccess(credentials('account-a'));
        expect(fetchMock).toHaveBeenCalledTimes(4);
    });

    it('rejects denied authentication and allows an explicit retry', async () => {
        fetchMock.mockResolvedValueOnce(new Response(null, { status: 401 }));
        const { ensureMediaAccess } = await import('./mediaAccess');
        await expect(ensureMediaAccess(credentials('account-a'))).rejects.toThrow('无法建立文件访问权限');
        await expect(ensureMediaAccess(credentials('account-a'))).resolves.toBeUndefined();
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('aborts a stalled authentication request instead of hanging startup', async () => {
        vi.useFakeTimers();
        fetchMock.mockImplementation((_url, options) => new Promise((_resolve, reject) => {
            options.signal.addEventListener('abort', () => reject(new DOMException('Cancelled', 'AbortError')));
        }));
        const { ensureMediaAccess } = await import('./mediaAccess');
        const result = expect(ensureMediaAccess(credentials('account-a'))).rejects.toThrow('请检查连接后重试');
        await vi.advanceTimersByTimeAsync(12_000);
        await result;
    });
});
