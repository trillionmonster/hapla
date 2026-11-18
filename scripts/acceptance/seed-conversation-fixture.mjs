#!/usr/bin/env node

import { readFileSync, writeFileSync } from 'node:fs';

const [serverUrl, credentialPath, outputPath, requestedPadding = '155'] = process.argv.slice(2);
if (!serverUrl || !credentialPath || !outputPath) {
    throw new Error('Usage: seed-conversation-fixture.mjs <server-url> <access.key> <output.json> [padding-count]');
}

const credentials = JSON.parse(readFileSync(credentialPath, 'utf8'));
const headers = {
    Authorization: `Bearer ${credentials.token}`,
    'Content-Type': 'application/json',
    'X-Hapla-Client': 'architecture-acceptance-fixture/1',
};

const listResponse = await fetch(`${serverUrl}/v1/sessions`, { headers });
if (!listResponse.ok) throw new Error(`Unable to load source session: ${listResponse.status}`);
const listed = await listResponse.json();
const source = listed.sessions.find((session) => session.metadata && session.dataEncryptionKey);
if (!source) throw new Error('No encrypted source session is available for the fixture');

const prefix = `architecture-${Date.now()}`;
async function create(tag, conversationId = null) {
    const response = await fetch(`${serverUrl}/v1/sessions`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
            tag,
            metadata: source.metadata,
            agentState: null,
            dataEncryptionKey: source.dataEncryptionKey,
            conversationId,
        }),
    });
    if (!response.ok) throw new Error(`Unable to create ${tag}: ${response.status} ${await response.text()}`);
    return (await response.json()).session;
}

const targetOldA = await create(`${prefix}-target-old-a`);
const targetOldB = await create(`${prefix}-target-old-b`, targetOldA.conversationId);
const paddingRoot = await create(`${prefix}-padding-0`);
const paddingCount = Math.max(151, Number(requestedPadding));
const padding = [paddingRoot];

// Bounded parallel batches exercise concurrent creation without overwhelming
// the embedded database used by the lightweight deployment.
for (let offset = 1; offset < paddingCount; offset += 12) {
    const batch = Array.from(
        { length: Math.min(12, paddingCount - offset) },
        (_, index) => create(`${prefix}-padding-${offset + index}`, paddingRoot.conversationId),
    );
    padding.push(...await Promise.all(batch));
}

const targetCurrent = await create(`${prefix}-target-current`, targetOldA.conversationId);
const result = {
    prefix,
    target: {
        conversationId: targetOldA.conversationId,
        runtimeIds: [targetOldA.id, targetOldB.id, targetCurrent.id],
        currentId: targetCurrent.id,
    },
    padding: {
        conversationId: paddingRoot.conversationId,
        runtimeIds: padding.map((session) => session.id),
        currentId: padding.at(-1).id,
    },
};
writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
console.log(JSON.stringify({
    targetRuntimeCount: result.target.runtimeIds.length,
    paddingRuntimeCount: result.padding.runtimeIds.length,
    outputPath,
}));
