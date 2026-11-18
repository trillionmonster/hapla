import { KeyTree, crypto } from "privacy-kit";

let keyTree: KeyTree | null = null;
let legacyKeyTree: KeyTree | null = null;

export async function initEncrypt() {
    const masterSecret = process.env.HAPLA_MASTER_SECRET;
    if (!masterSecret) throw new Error('HAPLA_MASTER_SECRET is required');
    keyTree = new KeyTree(await crypto.deriveSecureKey({
        key: masterSecret,
        usage: 'hapla-server-tokens'
    }));
    // Read-only fallback for records encrypted before the Hapla rename.
    legacyKeyTree = new KeyTree(await crypto.deriveSecureKey({
        key: masterSecret,
        usage: 'happy-server-tokens'
    }));
}

export function encryptString(path: string[], string: string) {
    return keyTree!.symmetricEncrypt(path, string);
}

export function encryptBytes(path: string[], bytes: Uint8Array<ArrayBuffer>) {
    return keyTree!.symmetricEncrypt(path, bytes);
}

export function decryptString(path: string[], encrypted: Uint8Array<ArrayBuffer>) {
    try {
        return keyTree!.symmetricDecryptString(path, encrypted);
    } catch {
        return legacyKeyTree!.symmetricDecryptString(path, encrypted);
    }
}

export function decryptBytes(path: string[], encrypted: Uint8Array<ArrayBuffer>) {
    try {
        return keyTree!.symmetricDecryptBuffer(path, encrypted);
    } catch {
        return legacyKeyTree!.symmetricDecryptBuffer(path, encrypted);
    }
}
