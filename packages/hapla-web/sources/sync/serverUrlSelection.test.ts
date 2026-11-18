import { describe, expect, it } from 'vitest';
import { selectServerUrl } from './serverUrlSelection';

describe('selectServerUrl', () => {
    it('uses the secure proxy origin instead of a persisted HTTP LAN endpoint', () => {
        expect(selectServerUrl({
            stored: 'http://192.168.42.10:12345',
            browserOrigin: 'https://example-host.example.ts.net:8443',
        })).toBe('https://example-host.example.ts.net:8443');
    });

    it('does not let an HTTP build-time endpoint create mixed content either', () => {
        expect(selectServerUrl({
            configured: 'http://192.168.42.10:12345',
            browserOrigin: 'https://public.example.test',
        })).toBe('https://public.example.test');
    });

    it('keeps an explicit secure custom endpoint', () => {
        expect(selectServerUrl({
            stored: 'https://api.example.test',
            browserOrigin: 'https://app.example.test',
        })).toBe('https://api.example.test');
    });

    it('keeps an HTTP endpoint on an HTTP page', () => {
        expect(selectServerUrl({
            stored: 'http://192.168.42.10:12345',
            browserOrigin: 'http://203.0.113.10:12345',
        })).toBe('http://192.168.42.10:12345');
    });
});

