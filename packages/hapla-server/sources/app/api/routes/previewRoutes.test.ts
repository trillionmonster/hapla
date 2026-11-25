import fastify from 'fastify';
import WebSocket from 'ws';
import { once } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { previewRoutes } from './previewRoutes';
import type { Fastify } from '../types';
import { previewKeyHash } from '@/app/preview/previewRegistry';
import { issuePreviewGrant } from '@/app/preview/previewAccess';
import { previewChanged } from '@/app/preview/previewEvents';

const mocks = vi.hoisted(() => ({ verify: vi.fn(), get: vi.fn(), lookup: vi.fn(), visible: vi.fn(), shareKey: vi.fn(), list: vi.fn(), save: vi.fn(), remove: vi.fn(), machine: vi.fn(), proxy: vi.fn(), openWebsocket: vi.fn() }));
vi.mock('@/app/auth/auth', () => ({ auth: { verifyToken: mocks.verify } }));
vi.mock('@/app/preview/previewSessions', () => ({ previewSessions: { ensure: async () => ({ id: 'test-browser-session', expiresAt: new Date(Date.now() + 86400_000) }), valid: async () => true, revoke: async () => {} }, previewSessionCookie: () => 'test-cookie' }));
vi.mock('@/app/preview/previewRegistry', async importOriginal => ({ ...await importOriginal(), previewRegistry: { get: mocks.get, lookup: mocks.lookup, visible: mocks.visible, shareKey: mocks.shareKey, list: mocks.list, save: mocks.save, remove: mocks.remove } }));
vi.mock('@/app/preview/previewBroker', () => ({ previewBroker: { machine: mocks.machine, proxyHttp: mocks.proxy, openWebsocket: mocks.openWebsocket } }));
afterEach(() => { vi.clearAllMocks(); vi.unstubAllEnvs(); });
const handle = 'a'.repeat(32);
const registration = { handle, machineId: 'machine-a', name: 'dev', target: 'http://127.0.0.1:5173/', revision: 0 };

async function fixture() {
    const app = fastify(); app.setValidatorCompiler(validatorCompiler); app.setSerializerCompiler(serializerCompiler);
    mocks.verify.mockImplementation(async token => ['owner-a', 'owner-b'].includes(token) ? { userId: token } : null);
    app.decorate('authenticate', async (request: any, reply: any) => { const verified = await mocks.verify(request.headers.authorization?.slice(7)); if (!verified) return reply.code(401).send(); request.userId = verified.userId; });
    vi.stubEnv('HAPLA_PREVIEW_HOST_TEMPLATE', '');
    mocks.lookup.mockResolvedValue({ ...registration, accountId: 'owner-a', access: 'private', shareKeyHash: null, accessVersion: 0 });
    mocks.get.mockImplementation(async account => account === 'owner-a' ? registration : null);
    mocks.list.mockResolvedValue([registration]); mocks.save.mockResolvedValue(registration);
    mocks.machine.mockReturnValue({});
    mocks.openWebsocket.mockResolvedValue({ protocol: '', attach: (ws: WebSocket) => ws.send('SCOPED_WS_OK') });
    mocks.proxy.mockImplementation(async (_socket, _request, response, _target, headers) => { response.writeHead(200, headers({ status: 200, headers: { 'content-type': 'text/plain' } })); response.end('owned bytes'); });
    previewRoutes(app as unknown as Fastify); await app.ready(); return app;
}

describe('private persistent development URLs', () => {
    it('checks current account ownership on every content read and never authorizes a link alone', async () => {
        const app = await fixture();
        expect((await app.inject({ url: `/preview/${handle}/` })).statusCode).toBe(401);
        expect((await app.inject({ url: `/preview/${handle}/`, headers: { cookie: 'hapla_preview_auth=owner-b' } })).statusCode).toBe(403);
        expect(mocks.proxy).not.toHaveBeenCalled();
        const response = await app.inject({ url: `/preview/${handle}/assets/app.js?v=2`, headers: { cookie: 'hapla_preview_auth=owner-a; hapla_site_access=outer', authorization: 'Bearer private' } });
        expect(response.statusCode).toBe(200); expect(response.body).toBe('owned bytes');
        const forwarded = mocks.proxy.mock.calls[0][3];
        expect(forwarded.target).toBe('http://127.0.0.1:5173/assets/app.js?v=2');
        expect(forwarded.headers.cookie).toBeUndefined(); expect(forwarded.headers.authorization).toBeUndefined();
        expect(response.headers['cache-control']).toBe('private, no-store');
        await app.close();
    });
    it('requires bearer login to grant navigation access and retains the same handle on update', async () => {
        const app = await fixture();
        expect((await app.inject({ method: 'POST', url: '/v1/preview/access', headers: { cookie: 'hapla_preview_auth=owner-a' } })).statusCode).toBe(401);
        const access = await app.inject({ method: 'POST', url: `/preview/${handle}/__hapla_auth`, headers: { authorization: 'Bearer owner-a', 'x-forwarded-proto': 'https' } });
        expect(access.statusCode).toBe(200); expect(access.headers['set-cookie']).toContain('Path=/preview/; HttpOnly; SameSite=Strict; Secure');
        const updated = await app.inject({ method: 'POST', url: '/v1/previews', headers: { authorization: 'Bearer owner-a' }, payload: { ...registration, target: 'http://10.0.0.3:9000/' } });
        expect(updated.json().handle).toBe(handle); expect(mocks.save).toHaveBeenCalledWith('owner-a', { ...registration, target: 'http://10.0.0.3:9000/' });
        await app.close();
    });
});

describe('shared proxy permissions', () => {
    const configure = (access: 'users' | 'key', shareKeyHash: string | null = null) => {
        vi.stubEnv('HAPLA_PREVIEW_HOST_TEMPLATE', '{handle}.preview.example.test');
        vi.stubEnv('HAPLA_MASTER_SECRET', 'test-only-preview-signing-key');
        const row = { ...registration, accountId: 'owner-a', access, shareKeyHash, accessVersion: 2 };
        mocks.lookup.mockResolvedValue(row); return row;
    };
    it('allows another authenticated account to launch a global share using the owner workbench', async () => {
        const app = await fixture(); configure('users');
        const launched = await app.inject({ url: `/preview/${handle}/`, headers: { host: 'main.example.test:8843', cookie: 'hapla_preview_auth=owner-b', 'x-forwarded-proto': 'https' } });
        expect(launched.statusCode).toBe(200);
        expect(launched.body).toContain(`${handle}.preview.example.test:8843`);
        const grant = issuePreviewGrant(handle, 'owner-b', 2);
        const response = await app.inject({ url: `/preview/${handle}/`, headers: { host: `${handle}.preview.example.test:8843`, cookie: `hapla_preview_grant=${grant}`, 'x-forwarded-proto': 'https' } });
        expect(response.body).toBe('owned bytes'); expect(mocks.machine).toHaveBeenCalledWith('owner-a', 'machine-a');
        const headers = { host: `${handle}.preview.example.test:8843`, cookie: `hapla_preview_grant=${grant}`, 'x-forwarded-proto': 'https', authorization: 'Bearer owner-b' };
        await app.inject({ url: `/preview/${handle}/`, headers });
        expect(mocks.proxy.mock.calls.at(-1)?.[3].headers.authorization).toBeUndefined();
        await app.inject({ url: `/preview/${handle}/`, headers: { ...headers, authorization: 'Bearer service-owned-token' } });
        expect(mocks.proxy.mock.calls.at(-1)?.[3].headers.authorization).toBe('Bearer service-owned-token');
        expect((await app.inject({ url: `/preview/${handle}/`, headers: { host: `${handle}.preview.example.test`, cookie: 'hapla_preview_auth=owner-b' } })).statusCode).toBe(401);
        await app.close();
    });
    it('requires a key for anonymous access, strips it from HTTP URLs and invalidates grants after rotation', async () => {
        const app = await fixture(); const row = configure('key', previewKeyHash('a-test-share-key'));
        expect((await app.inject({ url: `/preview/${handle}/` })).statusCode).toBe(401);
        expect((await app.inject({ method: 'POST', url: `/preview/${handle}/__hapla_share`, payload: { key: 'wrong' } })).statusCode).toBe(403);
        const response = await app.inject({ method: 'POST', url: `/preview/${handle}/__hapla_share`, headers: { host: 'main.example.test:8843', 'x-forwarded-proto': 'https' }, payload: { key: 'a-test-share-key' } });
        const url = new URL(response.json().url); const token = new URLSearchParams(url.hash.slice(1)).get('grant')!;
        expect(response.statusCode).toBe(200); expect(url.search).toBe(''); expect(url.toString()).not.toContain('a-test-share-key');
        const host = `${handle}.preview.example.test:8843`;
        const access = await app.inject({ method: 'POST', url: `/preview/${handle}/__hapla_grant`, headers: { host, 'x-forwarded-proto': 'https' }, payload: { grant: token } });
        expect(access.statusCode).toBe(200); expect(access.headers['set-cookie']).toContain('HttpOnly; SameSite=Lax; Max-Age=86400; Secure');
        const request = { url: `/preview/${handle}/`, headers: { host, cookie: `hapla_preview_grant=${token}`, 'x-forwarded-proto': 'https' } };
        expect((await app.inject(request)).body).toBe('owned bytes');
        row.accessVersion++; expect((await app.inject(request)).statusCode).toBe(401);
        await app.close();
    });
    it('rejects anonymous mutation, unknown public mode, and a stolen key grant on a different handle', async () => {
        const app = await fixture(); configure('key', previewKeyHash('key'));
        expect((await app.inject({ method: 'POST', url: '/v1/previews', payload: registration })).statusCode).toBe(401);
        mocks.remove.mockResolvedValue(false);
        expect((await app.inject({ method: 'DELETE', url: `/v1/previews/${handle}`, headers: { authorization: 'Bearer owner-b' } })).statusCode).toBe(404);
        expect(mocks.remove).toHaveBeenCalledWith('owner-b', handle);
        expect((await app.inject({ method: 'POST', url: '/v1/previews', headers: { authorization: 'Bearer owner-a' }, payload: { ...registration, access: 'public' } })).statusCode).toBe(400);
        const response = await app.inject({ method: 'POST', url: `/preview/${handle}/__hapla_grant`, headers: { host: `${handle}.preview.example.test` }, payload: { grant: issuePreviewGrant('b'.repeat(32), null, 2) } });
        expect(response.statusCode).toBe(403); await app.close();
    });
    it('applies the same scoped grant and revocation checks to actual WebSocket handshakes', async () => {
        const app = await fixture(); const row = configure('key', previewKeyHash('key'));
        const url = await app.listen({ host: '127.0.0.1', port: 0 });
        const address = url.replace('http:', 'ws:') + `/preview/${handle}/socket`;
        const host = `${handle}.preview.example.test`;
        const token = issuePreviewGrant(handle, null, 2);
        try {
            const client = new WebSocket(address, { headers: { host, origin: `http://${host}`, cookie: `hapla_preview_grant=${token}` } });
            const message = once(client, 'message');
            expect(String((await message)[0])).toBe('SCOPED_WS_OK');
            expect(mocks.machine).toHaveBeenCalledWith('owner-a', 'machine-a');
            const closed = once(client, 'close'); row.accessVersion++; previewChanged(handle);
            expect((await closed)[0]).toBe(1008);
            const rejected = new WebSocket(address, { headers: { host, origin: `http://${host}`, cookie: `hapla_preview_grant=${token}` } });
            const error = await new Promise<Error>(resolve => rejected.once('error', resolve));
            expect(error.message).toContain('401');
        } finally { await app.close(); }
    });

});
