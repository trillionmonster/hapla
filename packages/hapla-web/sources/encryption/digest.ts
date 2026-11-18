import * as Crypto from 'expo-crypto';
import { sha256, sha512 } from '@noble/hashes/sha2';

type DigestAlgorithm = 'SHA-256' | 'SHA-512';

function getWebCrypto(): Crypto | undefined {
    return globalThis.crypto;
}

function normalizeAlgorithm(algorithm: DigestAlgorithm): Crypto.CryptoDigestAlgorithm {
    switch (algorithm) {
        case 'SHA-256':
            return Crypto.CryptoDigestAlgorithm.SHA256;
        case 'SHA-512':
            return Crypto.CryptoDigestAlgorithm.SHA512;
    }
}

function digestWithNoble(algorithm: DigestAlgorithm, data: Uint8Array): Uint8Array {
    switch (algorithm) {
        case 'SHA-256':
            return sha256(data);
        case 'SHA-512':
            return sha512(data);
    }
}

export async function digest(algorithm: DigestAlgorithm, data: Uint8Array): Promise<Uint8Array> {
    const input = Uint8Array.from(data);
    const webCrypto = getWebCrypto();
    if (webCrypto?.subtle) {
        const result = await webCrypto.subtle.digest(algorithm, input);
        return new Uint8Array(result);
    }

    try {
        return digestWithNoble(algorithm, input);
    } catch {
        // Fall through to expo-crypto for environments where a JS hash fallback
        // is not available or fails unexpectedly.
    }

    if (typeof Crypto.digest === 'function') {
        const result = await Crypto.digest(normalizeAlgorithm(algorithm), input);
        return new Uint8Array(result);
    }

    throw new Error(`No digest implementation available for ${algorithm}`);
}
