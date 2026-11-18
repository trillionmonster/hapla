import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createAuthClient, SiteAccessError } from './authClient';

const { prompt } = vi.hoisted(() => ({ prompt: vi.fn() }));
vi.mock('inquirer', () => ({ default: { prompt } }));

const servers: Server[] = [];
const restoreTty: Array<() => void> = [];

function tty(value: boolean) {
    for (const stream of [process.stdin, process.stdout]) {
        const descriptor = Object.getOwnPropertyDescriptor(stream, 'isTTY');
        Object.defineProperty(stream, 'isTTY', { configurable: true, value });
        restoreTty.push(() => descriptor
            ? Object.defineProperty(stream, 'isTTY', descriptor)
            : Reflect.deleteProperty(stream, 'isTTY'));
    }
}

afterEach(async () => {
    restoreTty.splice(0).reverse().forEach(restore => restore());
    vi.unstubAllEnvs();
    prompt.mockReset();
    await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve());
        server.closeAllConnections();
    })));
});

type Request = { path: string; body: any; headers: IncomingMessage['headers'] };
async function server(handler: (request: Request, response: ServerResponse) => void) {
    const requests: Request[] = [];
    const instance = createServer(async (request, response) => {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const body = Buffer.concat(chunks).toString();
        const entry = { path: request.url!, body: body ? JSON.parse(body) : null, headers: request.headers };
        requests.push(entry);
        handler(entry, response);
    });
    servers.push(instance);
    await new Promise<void>(resolve => instance.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${(instance.address() as AddressInfo).port}`;
    return { url, requests, client: createAuthClient(url, 'test-version') };
}

function json(response: ServerResponse, status: number, body: unknown) {
    response.writeHead(status, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(body));
}
const required = (response: ServerResponse) => json(response, 401, { code: 'SITE_ACCESS_REQUIRED' });
const cookie = 'hapla_site_access=v1.fake.signed-cookie';

describe('authentication with a global site password', () => {
    it('leaves an unprotected auth flow unchanged and never asks for a password', async () => {
        vi.stubEnv('HAPLA_ACCESS_PASSWORD', 'unused-secret');
        const state = await server((_request, response) => json(response, 200, { success: true, token: 'token' }));
        expect((await state.client.post('/v1/auth', { challenge: 'proof' })).data.token).toBe('token');
        expect(state.requests).toHaveLength(1);
        expect(state.requests[0].headers.cookie).toBeUndefined();
        expect(prompt).not.toHaveBeenCalled();
    });

    it('exchanges the environment password with the same Origin and reuses only the access cookie for auth polling', async () => {
        vi.stubEnv('HAPLA_ACCESS_PASSWORD', 'test-only-password');
        const state = await server((request, response) => {
            if (request.path === '/access/login') {
                response.setHeader('Set-Cookie', ['unrelated=private; Path=/', `${cookie}; HttpOnly; Path=/; SameSite=Lax`]);
                return json(response, 200, { next: '/' });
            }
            if (request.headers.cookie !== cookie) return required(response);
            json(response, 200, { state: 'requested' });
        });
        await state.client.post('/v1/auth/request', { publicKey: 'public-key', supportsV2: true });
        await state.client.post('/v1/auth/request', { publicKey: 'public-key', supportsV2: true });
        expect(state.requests.map(request => request.path)).toEqual(['/v1/auth/request', '/access/login', '/v1/auth/request', '/v1/auth/request']);
        expect(state.requests[1].headers.origin).toBe(state.url);
        expect(state.requests[1].body).toEqual({ password: 'test-only-password' });
        for (const request of [state.requests[2], state.requests[3]]) {
            expect(request.headers.cookie).toBe(cookie);
            expect(request.headers['x-hapla-client']).toBe('cli/test-version');
            expect(JSON.stringify(request)).not.toContain('test-only-password');
        }
        expect(prompt).not.toHaveBeenCalled();
    });

    it('gives non-interactive callers a clear environment instruction before attempting login', async () => {
        vi.stubEnv('HAPLA_ACCESS_PASSWORD', '');
        tty(false);
        const state = await server((_request, response) => required(response));
        await expect(state.client.post('/v1/auth', {})).rejects.toThrow('Set HAPLA_ACCESS_PASSWORD');
        expect(state.requests).toHaveLength(1);
        expect(prompt).not.toHaveBeenCalled();
    });

    it('uses a hidden password prompt on a terminal only when the gate requires it', async () => {
        vi.stubEnv('HAPLA_ACCESS_PASSWORD', '');
        tty(true);
        prompt.mockResolvedValue({ password: 'prompted-password' });
        const state = await server((request, response) => {
            if (request.path === '/access/login') {
                response.setHeader('Set-Cookie', cookie);
                return json(response, 200, { next: '/' });
            }
            if (!request.headers.cookie) return required(response);
            json(response, 200, { success: true });
        });
        await state.client.post('/v1/auth', {});
        expect(prompt).toHaveBeenCalledWith([expect.objectContaining({ type: 'password', mask: '*' })]);
        expect(state.requests[1].body.password).toBe('prompted-password');
    });

    it.each([401, 429, 500])('does not expose the password or axios request config when login fails with %s', async status => {
        vi.stubEnv('HAPLA_ACCESS_PASSWORD', 'must-never-be-in-error');
        const state = await server((request, response) => request.path === '/access/login'
            ? json(response, status, { error: 'must-never-be-in-error' }) : required(response));
        const error = await state.client.post('/v1/auth', {}).catch(error => error);
        expect(error).toBeInstanceOf(SiteAccessError);
        expect(error.config).toBeUndefined();
        expect(String(error) + JSON.stringify(error)).not.toContain('must-never-be-in-error');
        expect(state.requests).toHaveLength(2);
    });

    it('does not follow a redirect carrying the password', async () => {
        vi.stubEnv('HAPLA_ACCESS_PASSWORD', 'redirect-password');
        const destination = await server((_request, response) => json(response, 200, {}));
        const state = await server((request, response) => {
            if (request.path !== '/access/login') return required(response);
            response.writeHead(307, { Location: `${destination.url}/access/login` });
            response.end();
        });
        await expect(state.client.post('/v1/auth', {})).rejects.toThrow('final server URL');
        expect(destination.requests).toHaveLength(0);
    });

    it('does not mistake a normal auth 401 for a request to enter the site password', async () => {
        vi.stubEnv('HAPLA_ACCESS_PASSWORD', 'unused');
        const state = await server((_request, response) => json(response, 401, { error: 'Invalid signature' }));
        await expect(state.client.post('/v1/auth', {})).rejects.toThrow('HTTP 401');
        expect(state.requests).toHaveLength(1);
        expect(prompt).not.toHaveBeenCalled();
    });

    it('rejects missing cookies and stops after one rejected-cookie retry', async () => {
        vi.stubEnv('HAPLA_ACCESS_PASSWORD', 'password');
        const missing = await server((request, response) => request.path === '/access/login'
            ? json(response, 200, { next: '/' }) : required(response));
        await expect(missing.client.post('/v1/auth', {})).rejects.toThrow('did not return an access cookie');
        expect(missing.requests).toHaveLength(2);
        const rejected = await server((request, response) => {
            if (request.path !== '/access/login') return required(response);
            response.setHeader('Set-Cookie', cookie);
            json(response, 200, { next: '/' });
        });
        await expect(rejected.client.post('/v1/auth', {})).rejects.toThrow('rejected the access cookie');
        expect(rejected.requests).toHaveLength(3);
    });

    it('keeps cookies within one auth flow and strips them from subsequent request errors', async () => {
        vi.stubEnv('HAPLA_ACCESS_PASSWORD', 'password');
        const state = await server((request, response) => {
            if (request.path === '/access/login') {
                response.setHeader('Set-Cookie', cookie);
                return json(response, 200, { next: '/' });
            }
            if (!request.headers.cookie) return required(response);
            json(response, 500, { error: cookie });
        });
        const error = await state.client.post('/v1/auth', {}).catch(error => error);
        expect(error.config).toBeUndefined();
        expect(String(error) + JSON.stringify(error)).not.toContain(cookie);
        const other = createAuthClient(state.url, 'another-flow');
        await expect(other.post('/v1/auth', {})).rejects.toThrow('HTTP 500');
        expect(state.requests[3].headers.cookie).toBeUndefined();
        await expect(state.client.post('https://unrelated.example' as '/v1/auth', {})).rejects.toThrow('Unsupported');
        expect(state.requests).toHaveLength(6);
    });
});
