#!/usr/bin/env node
/** Seed synthetic encrypted histories through the real API of an isolated acceptance account. */
import { createCipheriv, createHmac, randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
const require = createRequire(import.meta.url);
const nacl = require('tweetnacl');
const api = process.argv[2] ?? 'http://127.0.0.1:12445';
const home = resolve(process.argv[3] ?? '.runtime/reliability-isolated/a1');
const output = resolve(process.argv[4] ?? '.runtime/evidence/session-cache-production-seed.json');
const credentials = JSON.parse(readFileSync(`${home}/access.key`, 'utf8'));
const headers = { Authorization: `Bearer ${credentials.token}`, 'Content-Type': 'application/json', 'X-Hapla-Client': 'production-cache-acceptance/1' };
const masterKey = Buffer.from(credentials.encryption?.machineKey ?? credentials.secret, 'base64');
function key(tag) { return credentials.secret ? masterKey : createHmac('sha256', masterKey).update(`cache-fixture:${tag}`).digest(); }
function encrypt(value, secret) {
    const data = Buffer.from(JSON.stringify(value));
    if (credentials.secret) { const nonce = randomBytes(24); return Buffer.concat([nonce, nacl.secretbox(data, nonce, secret)]).toString('base64'); }
    const nonce = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', secret, nonce);
    return Buffer.concat([Buffer.from([0]), nonce, cipher.update(data), cipher.final(), cipher.getAuthTag()]).toString('base64');
}
function wrap(secret) {
    if (credentials.secret) return null;
    const ephemeral = nacl.box.keyPair(); const nonce = randomBytes(24);
    return Buffer.concat([Buffer.from([0]), ephemeral.publicKey, nonce, nacl.box(secret, nonce, Buffer.from(credentials.encryption.publicKey, 'base64'), ephemeral.secretKey)]).toString('base64');
}
async function post(path, body) {
    const response = await fetch(`${api}${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
    if (!response.ok) throw new Error(`Fixture API ${path}: ${response.status}`);
    return response.json();
}
const manifest = existsSync(output) ? JSON.parse(readFileSync(output, 'utf8')) : { prefix: `cache-production-${Date.now()}`, fixture: 'Synthetic encrypted user messages, created through actual API. No model output is represented by this fixture.', sessions: [], archives: [] };
const save = () => { mkdirSync(dirname(output), { recursive: true }); writeFileSync(output, JSON.stringify(manifest, null, 2), { mode: 0o600 }); };
save();
async function create(index, count, conversationId) {
    const tag = `${manifest.prefix}-${index}`;
    const name = `CACHE_PROD ${String(index).padStart(2, '0')}`;
    const encryptionKey = key(tag);
    const data = await post('/v1/sessions', { tag, conversationId: conversationId ?? null,
        metadata: encrypt({ name, path: `/synthetic-cache-fixture/${index}`, host: 'acceptance-fixture', flavor: 'codex' }, encryptionKey),
        agentState: encrypt({}, encryptionKey), dataEncryptionKey: wrap(encryptionKey) });
    return { id: data.session.id, conversationId: data.session.conversationId, index, tag, name, count, seeded: 0 };
}
async function seed(session) {
    const encryptionKey = key(session.tag);
    for (let offset = session.seeded; offset < session.count; offset += 100) {
        const messages = Array.from({ length: Math.min(100, session.count - offset) }, (_, index) => {
            const seq = offset + index + 1;
            const marker = `[${session.name} #${seq}]`;
            const text = marker + (seq > session.count - 200 ? '\n\n' + `${session.index}/${seq} synthetic encrypted history. `.repeat(220) : ' synthetic history');
            return { localId: `${session.tag}:${seq}`, content: encrypt({ role: 'user', content: { type: 'text', text } }, encryptionKey) };
        });
        await post(`/v3/sessions/${session.id}/messages`, { messages });
        session.seeded = Math.min(session.count, offset + 100); save();
        if (session.count >= 100000 && session.seeded % 10000 === 0) console.log(JSON.stringify({ historySeeded: session.seeded, total: session.count }));
    }
}
for (let index = 0; index < 50; index++) {
    let session = manifest.sessions[index];
    if (!session) { session = await create(index, index === 49 ? 100000 : 200); manifest.sessions[index] = session; save(); }
    await seed(session);
    if ((index + 1) % 10 === 0) console.log(JSON.stringify({ sessionsSeeded: index + 1 }));
}
// Two older transport generations are part of one independent logical conversation.
for (let index = 0; index < 2; index++) {
    let archive = manifest.archives[index];
    if (!archive) { archive = await create(`archive-${index}`, 80, manifest.sessions[0].conversationId); manifest.archives[index] = archive; save(); }
    await seed(archive);
}
manifest.completedAt = new Date().toISOString(); save();
console.log(JSON.stringify({ ok: true, sessions: manifest.sessions.length, archivedRuntimes: manifest.archives.length, records: [...manifest.sessions, ...manifest.archives].reduce((total, session) => total + session.seeded, 0), output }));
