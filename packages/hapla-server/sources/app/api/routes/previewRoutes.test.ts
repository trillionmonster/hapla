import fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { previewRoutes } from './previewRoutes';
import type { Fastify } from '../types';

const mocks = vi.hoisted(() => ({ verify: vi.fn(), get: vi.fn(), list: vi.fn(), save: vi.fn(), remove: vi.fn(), machine: vi.fn(), proxy: vi.fn() }));
vi.mock('@/app/auth/auth', () => ({ auth: { verifyToken: mocks.verify } }));
vi.mock('@/app/preview/previewRegistry', () => ({ previewRegistry: { get: mocks.get, list: mocks.list, save: mocks.save, remove: mocks.remove } }));
vi.mock('@/app/preview/previewBroker', () => ({ previewBroker: { machine: mocks.machine, proxyHttp: mocks.proxy } }));
afterEach(() => vi.clearAllMocks());
const handle = 'a'.repeat(32);
const registration = { handle, machineId: 'machine-a', name: 'dev', target: 'http://127.0.0.1:5173/', revision: 0 };

async function fixture() {
    const app = fastify(); app.setValidatorCompiler(validatorCompiler); app.setSerializerCompiler(serializerCompiler);
    mocks.verify.mockImplementation(async token => ['owner-a', 'owner-b'].includes(token) ? { userId: token } : null);
    app.decorate('authenticate', async (request: any, reply: any) => { const verified = await mocks.verify(request.headers.authorization?.slice(7)); if (!verified) return reply.code(401).send(); request.userId = verified.userId; });
    mocks.get.mockImplementation(async account => account === 'owner-a' ? registration : null);
    mocks.list.mockResolvedValue([registration]); mocks.save.mockResolvedValue(registration);
    mocks.machine.mockReturnValue({});
    mocks.proxy.mockImplementation(async (_socket, _request, response, _target, headers) => { response.writeHead(200, headers({ status: 200, headers: { 'content-type': 'text/plain' } })); response.end('owned bytes'); });
    previewRoutes(app as unknown as Fastify); await app.ready(); return app;
}

describe('private persistent development URLs', () => {
    it('checks current account ownership on every content read and never authorizes a link alone', async () => {
        const app = await fixture();
        expect((await app.inject({ url: `/preview/${handle}/` })).statusCode).toBe(401);
        expect((await app.inject({ url: `/preview/${handle}/`, headers: { cookie: 'hapla_preview_auth=owner-b' } })).statusCode).toBe(404);
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
