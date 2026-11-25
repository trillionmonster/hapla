import { sessionConfigurationValuesSchema } from '@hapla/wire/sessionConfiguration';
import type { SessionConfigurationValues } from '@hapla/wire';
import type { Metadata, Session } from './storageTypes';
import type { Encryption } from './encryption/encryption';
import { apiSocket } from './apiSocket';

/** Merge a field patch against freshly decrypted metadata, retaining unrelated CLI state. */
export async function persistSessionConfiguration(owner: string, source: Session, patch: SessionConfigurationValues, encryption: Encryption,
    apply: (session: Session) => void): Promise<void> {
    sessionConfigurationValuesSchema.parse(patch);
    const cipher = encryption.getSessionEncryption(owner);
    if (!cipher) throw new Error('会话设置尚未就绪，请稍后重试');
    const response = await apiSocket.request(`/v1/sessions/${encodeURIComponent(owner)}/metadata`);
    if (!response.ok) throw new Error('无法读取会话设置，设置尚未同步');
    const row = await response.json() as { metadata: string; metadataVersion: number; conversationId?: string };
    if (source.conversationId && row.conversationId && source.conversationId !== row.conversationId) throw new Error('会话配置归属不一致');
    let metadata = await cipher.decryptRaw(row.metadata) as Metadata | null;
    let version = row.metadataVersion;
    for (let attempt = 0; attempt < 8; attempt++) {
        if (!metadata) throw new Error('无法解密会话设置');
        const updated = { ...metadata, executionConfiguration: {
            revision: (metadata.executionConfiguration?.revision ?? 0) + 1,
            values: { ...metadata.executionConfiguration?.values, ...patch },
        } };
        const answer = await apiSocket.emitWithAck<any>('update-metadata', {
            sid: owner, expectedVersion: version, metadata: await cipher.encryptMetadata(updated),
        });
        if (answer.result !== 'success' && answer.result !== 'version-mismatch') throw new Error('会话设置未保存，请重试');
        metadata = await cipher.decryptRaw(answer.metadata) as Metadata | null;
        version = answer.version;
        if (answer.result === 'success') {
            apply({ ...source, id: owner, metadata, metadataVersion: version });
            return;
        }
    }
    throw new Error('会话设置发生并发冲突，请重试');
}

/** Drain field patches without reasserting fields already acknowledged by an earlier write. */
export async function writeQueuedSessionConfiguration(owner: string, id: string, patches: Map<string, SessionConfigurationValues>,
    encryption: () => Encryption, apply: (session: Session) => void): Promise<void> {
    const account = encryption();
    const { storage } = await import('./storage');
    while (patches.has(owner)) {
        if (account !== encryption()) throw new Error('账号已变化');
        const patch = patches.get(owner)!;
        patches.delete(owner);
        try {
            const source = storage.getState().sessions[owner] ?? storage.getState().sessions[id];
            if (!source) throw new Error('会话设置尚未就绪');
            const cipher = encryption();
            await persistSessionConfiguration(owner, source, patch, cipher, session => {
                if (cipher !== encryption()) throw new Error('账号已变化');
                apply(session);
            });
        } catch (error) {
            if (account === encryption()) patches.set(owner, { ...patch, ...patches.get(owner) });
            throw error;
        }
    }
}
