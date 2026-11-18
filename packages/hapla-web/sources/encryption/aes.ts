import { getRandomBytes } from 'expo-crypto';
import { Platform } from 'react-native';
import { gcm } from '@noble/ciphers/aes';
import { decodeUTF8, encodeUTF8 } from './text';
import { decodeBase64, encodeBase64 } from '@/encryption/base64';

type AesModule = typeof import('rn-encryption');

let aesModulePromise: Promise<AesModule> | null = null;

async function getAesModule(): Promise<AesModule> {
    if (!aesModulePromise) {
        aesModulePromise = import('rn-encryption');
    }
    return aesModulePromise;
}

function shouldUseJsAesFallback(): boolean {
    return Platform.OS === 'web' && !globalThis.crypto?.subtle;
}

async function encryptWithJsAes(data: string, key64: string): Promise<string> {
    const key = decodeBase64(key64);
    const iv = getRandomBytes(12);
    const encrypted = gcm(key, iv).encrypt(encodeUTF8(data));
    const combined = new Uint8Array(iv.length + encrypted.length);
    combined.set(iv, 0);
    combined.set(encrypted, iv.length);
    return encodeBase64(combined);
}

async function decryptWithJsAes(data: string, key64: string): Promise<string | null> {
    const key = decodeBase64(key64);
    const combined = decodeBase64(data);
    const iv = combined.slice(0, 12);
    const encrypted = combined.slice(12);
    const decrypted = gcm(key, iv).decrypt(encrypted);
    return decodeUTF8(decrypted);
}

export async function encryptAESGCMString(data: string, key64: string): Promise<string> {
    if (shouldUseJsAesFallback()) {
        return encryptWithJsAes(data, key64);
    }
    return await (await getAesModule()).encryptAsyncAES(data, key64);
}

export async function decryptAESGCMString(data: string, key64: string): Promise<string | null> {
    if (shouldUseJsAesFallback()) {
        return decryptWithJsAes(data, key64);
    }
    const res = (await (await getAesModule()).decryptAsyncAES(data, key64)).trim();
    return res;
}

export async function encryptAESGCM(data: Uint8Array, key64: string): Promise<Uint8Array> {
    const encrypted = shouldUseJsAesFallback()
        ? await encryptWithJsAes(decodeUTF8(data), key64)
        : (await (await getAesModule()).encryptAsyncAES(decodeUTF8(data), key64)).trim();
    return decodeBase64(encrypted);
}
export async function decryptAESGCM(data: Uint8Array, key64: string): Promise<Uint8Array | null> {
    const raw = shouldUseJsAesFallback()
        ? await decryptWithJsAes(encodeBase64(data), key64)
        : await (await getAesModule()).decryptAsyncAES(encodeBase64(data), key64);
    return raw ? encodeUTF8(raw) : null;
}