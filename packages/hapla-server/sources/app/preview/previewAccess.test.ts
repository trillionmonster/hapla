import { afterEach, describe, expect, it, vi } from 'vitest';
import { isolatedPreviewOrigin, issuePreviewGrant, verifyPreviewGrant } from './previewAccess';
import { matchesPreviewKey, previewKeyHash } from './previewRegistry';
vi.mock('@/storage/db', () => ({ db: {} }));
afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers(); });
const handle = 'a'.repeat(32);
describe('isolated preview grants', () => {
    it('uses the actual external browser scheme and port on a separate per-handle hostname', () => {
        vi.stubEnv('HAPLA_PREVIEW_HOST_TEMPLATE', '{handle}.preview.example.test');
        expect(isolatedPreviewOrigin({ headers: { host: 'hapla.example.test:8843', 'x-forwarded-proto': 'https,http' } }, handle)?.origin).toBe(`https://${handle}.preview.example.test:8843`);
        expect(isolatedPreviewOrigin({ headers: { host: 'inner:80', 'x-forwarded-host': 'hapla.example.test:8843, inner:80', 'x-forwarded-proto': 'https,http' } }, handle)?.origin).toBe(`https://${handle}.preview.example.test:8843`);
    });
    it('fails closed on invalid hostname configuration', () => {
        vi.stubEnv('HAPLA_PREVIEW_HOST_TEMPLATE', 'main.example.test');
        expect(() => isolatedPreviewOrigin({ headers: { host: 'main.example.test' } }, handle)).toThrow();
    });
    it('binds a grant to the handle, access version and expiry without becoming a Hapla bearer token', () => {
        vi.stubEnv('HAPLA_MASTER_SECRET', 'isolated-unit-test-only'); vi.useFakeTimers();
        const token = issuePreviewGrant(handle, 'viewer-b', 3);
        expect(verifyPreviewGrant(token, handle, 3)?.viewer).toBe('viewer-b');
        expect(verifyPreviewGrant(token, 'b'.repeat(32), 3)).toBeNull();
        expect(verifyPreviewGrant(token, handle, 4)).toBeNull();
        expect(verifyPreviewGrant(token + 'x', handle, 3)).toBeNull();
        vi.advanceTimersByTime(24 * 60 * 60_000 + 1);
        expect(verifyPreviewGrant(token, handle, 3)).toBeNull();
    });
    it('compares only hashed keys and rejects absent, incorrect and oversized values', () => {
        const hash = previewKeyHash('test-share-key');
        expect(hash).not.toContain('test-share-key');
        expect(matchesPreviewKey(hash, 'test-share-key')).toBe(true);
        for (const value of [undefined, '', 'wrong', 'a'.repeat(257)]) expect(matchesPreviewKey(hash, value)).toBe(false);
        expect(matchesPreviewKey(null, 'test-share-key')).toBe(false);
    });
});
