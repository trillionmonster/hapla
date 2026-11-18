import { scryptSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { SiteAccess, safeReturnPath } from './siteAccess';

const salt = Buffer.alloc(16, 1);
const hash = (password: string) => `scrypt$${salt.toString('hex')}$${scryptSync(password, salt, 32).toString('hex')}`;
const passwordHash = hash('test password');

describe('site access sessions', () => {
    it('checks the password and signs a persistent HTTP-only cookie', async () => {
        const access = new SiteAccess(passwordHash, 'test signing key');
        expect(await access.verifyPassword('wrong', 'client')).toBe('denied');
        expect(await access.verifyPassword('test password', 'client')).toBe('accepted');
        const cookie = access.issueCookie(true);
        expect(cookie).toContain('HttpOnly; SameSite=Lax; Max-Age=2592000; Secure');
        expect(access.hasSession(cookie)).toBe(true);
        expect(new SiteAccess(passwordHash, 'test signing key').hasSession(cookie)).toBe(true);
    });

    it('rejects forged, duplicate, expired and rotated sessions', () => {
        let now = 1800000000000;
        const access = new SiteAccess(passwordHash, 'key', () => now);
        const cookie = access.issueCookie(false).split(';')[0];
        expect(access.hasSession()).toBe(false);
        expect(access.hasSession(cookie + '; ' + cookie)).toBe(false);
        expect(access.hasSession(cookie.replace('v1.', 'v2.'))).toBe(false);
        expect(access.hasSession(cookie.slice(0, -1) + (cookie.endsWith('0') ? '1' : '0'))).toBe(false);
        expect(new SiteAccess(hash('changed'), 'key', () => now).hasSession(cookie)).toBe(false);
        now += 30 * 24 * 3600 * 1000;
        expect(access.hasSession(cookie)).toBe(false);
    });

    it('limits repeated failures before expensive password checks and recovers', async () => {
        let now = 1800000000000;
        const access = new SiteAccess(passwordHash, 'key', () => now);
        for (let i = 0; i < 10; i++) expect(await access.verifyPassword(null, 'client')).toBe('denied');
        expect(await access.verifyPassword('test password', 'client')).toBe('limited');
        now += 60001;
        expect(await access.verifyPassword('test password', 'client')).toBe('accepted');
    });

    it('rejects malformed configuration instead of opening access', () => {
        expect(() => new SiteAccess('plaintext', 'secret')).toThrow('Invalid');
        expect(() => new SiteAccess(passwordHash, '')).toThrow('HAPLA_MASTER_SECRET');
        expect(SiteAccess.fromEnvironment({})).toBeNull();
    });
});

describe('post-login return paths', () => {
    it.each(['https://evil.invalid', '//evil.invalid', '/\\evil.invalid', '/%2fevil.invalid', '/%5cevil.invalid', '/%0aevil', '/access/login', '/a/../access/login', '/bad%'])('rejects %s', value => {
        expect(safeReturnPath(value)).toBe('/');
    });
    it('preserves session and file-preview query strings', () => {
        const path = '/session/abc/file?path=L3Jvb3QvZmlsZQ&view=preview';
        expect(safeReturnPath(path)).toBe(path);
    });
});
