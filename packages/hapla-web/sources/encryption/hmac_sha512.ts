import { digest } from './digest';

export async function hmac_sha512(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {    
    const blockSize = 128; // SHA512 block size in bytes
    const opad = 0x5c;
    const ipad = 0x36;
    
    // Prepare key
    let actualKey = key;
    if (key.length > blockSize) {
        // If key is longer than block size, hash it
        actualKey = await digest('SHA-512', new Uint8Array(key));
    }
    
    // Pad key to block size
    const paddedKey = new Uint8Array(blockSize);
    paddedKey.set(actualKey);
    
    // Create inner and outer padded keys
    const innerKey = new Uint8Array(blockSize);
    const outerKey = new Uint8Array(blockSize);
    
    for (let i = 0; i < blockSize; i++) {
        innerKey[i] = paddedKey[i] ^ ipad;
        outerKey[i] = paddedKey[i] ^ opad;
    }
    
    // Inner hash: SHA512(innerKey || data)
    const innerData = new Uint8Array(blockSize + data.length);
    innerData.set(innerKey);
    innerData.set(data, blockSize);
    const innerHash = await digest('SHA-512', innerData);
    
    // Outer hash: SHA512(outerKey || innerHash)
    const outerData = new Uint8Array(blockSize + 64); // 64 bytes for SHA512 hash
    outerData.set(outerKey);
    outerData.set(innerHash, blockSize);
    return digest('SHA-512', outerData);
}
