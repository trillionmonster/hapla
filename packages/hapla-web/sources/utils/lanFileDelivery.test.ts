import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ request: vi.fn(), server: 'http://192.168.42.10:12345' }));
vi.mock('@/sync/apiSocket', () => ({ apiSocket: { request: mocks.request } }));
vi.mock('@/sync/serverConfig', () => ({ getServerUrl: () => mocks.server }));
beforeEach(() => { vi.resetModules(); mocks.request.mockReset(); mocks.server = 'http://192.168.42.10:12345'; });
afterEach(() => vi.unstubAllGlobals());
describe('LAN delivery capability', () => {
    it('requires both a local browser address and a working private server, then caches only the confirmation', async () => {
        vi.stubGlobal('window', { location: { hostname: '192.168.42.10' } }); mocks.request.mockResolvedValue(Response.json({ direct: true }));
        const { usesDirectFileDelivery } = await import('./lanFileDelivery');
        expect(await usesDirectFileDelivery()).toBe(true); expect(await usesDirectFileDelivery()).toBe(true); expect(mocks.request).toHaveBeenCalledTimes(1);
    });
    it('never probes private addresses or trusts Docker client addresses from public pages', async () => {
        vi.stubGlobal('window', { location: { hostname: '203.0.113.10' } });
        const { usesDirectFileDelivery } = await import('./lanFileDelivery'); expect(await usesDirectFileDelivery()).toBe(false); expect(mocks.request).not.toHaveBeenCalled();
        vi.stubGlobal('window', { location: { hostname: '192.168.42.10' } }); mocks.server = 'https://hapla.example.com'; expect(await usesDirectFileDelivery()).toBe(false);
    });
    it('does not silently upload LAN files to R2 when local preparation is unavailable', async () => {
        vi.stubGlobal('window', { location: { hostname: '192.168.42.10' } }); mocks.request.mockResolvedValue(Response.json({ direct: false }));
        const { usesDirectFileDelivery } = await import('./lanFileDelivery'); await expect(usesDirectFileDelivery()).rejects.toThrow(/局域网/);
    });
});
