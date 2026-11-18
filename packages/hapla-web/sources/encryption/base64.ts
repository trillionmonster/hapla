const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]*={0,2}$/;
const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/;

function normalizeBase64(value: string, encoding: 'base64' | 'base64url'): string {
    const compact = value.replace(/[\t\n\f\r ]/g, '');
    const pattern = encoding === 'base64url' ? BASE64URL_PATTERN : BASE64_PATTERN;
    if (!pattern.test(compact)) {
        throw new Error(`Invalid ${encoding} characters`);
    }

    const firstPadding = compact.indexOf('=');
    const unpadded = firstPadding === -1 ? compact : compact.slice(0, firstPadding);
    if (unpadded.length % 4 === 1) {
        throw new Error(`Invalid ${encoding} length`);
    }

    if (firstPadding !== -1) {
        const suppliedPadding = compact.length - firstPadding;
        const requiredPadding = (4 - (unpadded.length % 4)) % 4;
        if (compact.length % 4 !== 0 || suppliedPadding !== requiredPadding) {
            throw new Error(`Invalid ${encoding} padding`);
        }
    }

    const standard = encoding === 'base64url'
        ? unpadded.replace(/-/g, '+').replace(/_/g, '/')
        : unpadded;
    return standard + '='.repeat((4 - (standard.length % 4)) % 4);
}

/**
 * Browser-independent Base64 decoder.
 * Safari's native atob/btoa can throw InvalidCharacterError at protocol boundaries.
 */
export function decodeBase64(value: string, encoding: 'base64' | 'base64url' = 'base64'): Uint8Array {
    const normalized = normalizeBase64(value, encoding);
    const padding = normalized.endsWith('==') ? 2 : normalized.endsWith('=') ? 1 : 0;
    const output = new Uint8Array((normalized.length / 4) * 3 - padding);
    let outputIndex = 0;

    for (let index = 0; index < normalized.length; index += 4) {
        const a = BASE64_ALPHABET.indexOf(normalized[index]);
        const b = BASE64_ALPHABET.indexOf(normalized[index + 1]);
        const c = normalized[index + 2] === '=' ? 0 : BASE64_ALPHABET.indexOf(normalized[index + 2]);
        const d = normalized[index + 3] === '=' ? 0 : BASE64_ALPHABET.indexOf(normalized[index + 3]);
        const block = (a << 18) | (b << 12) | (c << 6) | d;

        if (outputIndex < output.length) output[outputIndex++] = (block >>> 16) & 0xff;
        if (outputIndex < output.length) output[outputIndex++] = (block >>> 8) & 0xff;
        if (outputIndex < output.length) output[outputIndex++] = block & 0xff;
    }

    return output;
}

/** Browser-independent Base64 encoder for arbitrary binary payloads. */
export function encodeBase64(buffer: Uint8Array, encoding: 'base64' | 'base64url' = 'base64'): string {
    let encoded = '';

    for (let index = 0; index < buffer.length; index += 3) {
        const a = buffer[index];
        const hasB = index + 1 < buffer.length;
        const hasC = index + 2 < buffer.length;
        const b = hasB ? buffer[index + 1] : 0;
        const c = hasC ? buffer[index + 2] : 0;
        const block = (a << 16) | (b << 8) | c;

        encoded += BASE64_ALPHABET[(block >>> 18) & 0x3f];
        encoded += BASE64_ALPHABET[(block >>> 12) & 0x3f];
        encoded += hasB ? BASE64_ALPHABET[(block >>> 6) & 0x3f] : '=';
        encoded += hasC ? BASE64_ALPHABET[block & 0x3f] : '=';
    }

    if (encoding === 'base64url') {
        return encoded.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
    }
    return encoded;
}
