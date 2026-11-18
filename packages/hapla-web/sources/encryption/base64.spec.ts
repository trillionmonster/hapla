import { describe, expect, it } from 'vitest';
import { decodeBase64, encodeBase64 } from './base64';

describe('base64', () => {
    it('encodes and decodes large payloads without overflowing the stack', () => {
        const input = new Uint8Array(256 * 1024);
        for (let i = 0; i < input.length; i++) {
            input[i] = i % 251;
        }

        const encoded = encodeBase64(input);
        expect(typeof encoded).toBe('string');

        const decoded = decodeBase64(encoded);
        expect(decoded).toEqual(input);
    });

    it('decodes an unpadded CLI public key without browser atob', () => {
        const key = 'gCvOeBup7yHUFSgOH5roEULwYnjqirhaK6HImLmdI1M';
        expect(decodeBase64(key, 'base64url')).toHaveLength(32);
    });

    it('does not depend on native atob or btoa', () => {
        const previousAtob = globalThis.atob;
        const previousBtoa = globalThis.btoa;
        globalThis.atob = (() => { throw new DOMException('The string contains invalid characters.'); }) as typeof atob;
        globalThis.btoa = (() => { throw new DOMException('The string contains invalid characters.'); }) as typeof btoa;
        try {
            const input = new Uint8Array([0, 127, 128, 255]);
            expect(decodeBase64(encodeBase64(input, 'base64url'), 'base64url')).toEqual(input);
        } finally {
            globalThis.atob = previousAtob;
            globalThis.btoa = previousBtoa;
        }
    });

    it('rejects malformed protocol keys with an actionable error', () => {
        expect(() => decodeBase64('bad+key', 'base64url')).toThrow('Invalid base64url characters');
        expect(() => decodeBase64('A', 'base64url')).toThrow('Invalid base64url length');
    });
});
