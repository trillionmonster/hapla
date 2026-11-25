import axios, { AxiosError } from 'axios';
import tweetnacl from 'tweetnacl';
import { z } from 'zod';

import { decodeBase64, decryptLegacy, decryptWithDataKey } from '@/api/encryption';
import type { Metadata } from '@/api/types';
import { configuration } from '@/configuration';
import {
    getLocalHaplaAgentCredentialPath,
    readLocalHaplaAgentCredentials,
    type LocalHaplaAgentCredentials,
} from './localHaplaAgentAuth';

const ResumableMetadataSchema = z.object({
    path: z.string().min(1),
    flavor: z.string().optional(),
    claudeSessionId: z.string().optional(),
    codexThreadId: z.string().optional(),
}).passthrough();

type RawSession = {
    id: string;
    conversationId?: string | null;
    active: boolean;
    metadata: string;
    dataEncryptionKey: string | null;
};

type RecordEncryption = {
    key: Uint8Array;
    variant: 'legacy' | 'dataKey';
};

export type ResumableHaplaSession = {
    id: string;
    conversationId?: string;
    active: boolean;
    metadata: Metadata;
};

export function resolveSessionRecordByPrefix<T extends { id: string }>(records: T[], sessionId: string): T {
    const trimmed = sessionId.trim();
    if (!trimmed) {
        throw new Error('Hapla session ID is required: hapla resume <session-id>');
    }

    const matches = records.filter((record) => record.id.startsWith(trimmed));
    if (matches.length === 0) {
        throw new Error(`No Hapla session found matching "${trimmed}"`);
    }
    if (matches.length > 1) {
        throw new Error(`Ambiguous Hapla session "${trimmed}" matches ${matches.length} sessions. Be more specific.`);
    }
    return matches[0];
}

function decryptBoxBundle(bundle: Uint8Array, recipientSecretKey: Uint8Array): Uint8Array | null {
    if (bundle.length < 56) {
        return null;
    }

    const ephemeralPublicKey = bundle.slice(0, 32);
    const nonce = bundle.slice(32, 56);
    const ciphertext = bundle.slice(56);
    const decrypted = tweetnacl.box.open(ciphertext, nonce, ephemeralPublicKey, recipientSecretKey);

    return decrypted ? new Uint8Array(decrypted) : null;
}

function readAgentCredentials() {
    const credentialPath = getLocalHaplaAgentCredentialPath();
    const credentials = readLocalHaplaAgentCredentials();
    if (!credentials) {
        throw new Error(
            `Cannot resume historical Hapla sessions without ${credentialPath}. Run \`hapla auth login\` in this environment first.`,
        );
    }
    return credentials;
}

function resolveSessionEncryption(session: RawSession, credentials: LocalHaplaAgentCredentials): RecordEncryption {
    if (session.dataEncryptionKey) {
        const encrypted = decodeBase64(session.dataEncryptionKey);
        const sessionKey = decryptBoxBundle(encrypted.slice(1), credentials.contentKeyPair.secretKey);
        if (!sessionKey) {
            throw new Error(`Failed to decrypt data key for Hapla session ${session.id}`);
        }
        return {
            key: sessionKey,
            variant: 'dataKey',
        };
    }

    return {
        key: credentials.secret,
        variant: 'legacy',
    };
}

function decryptSessionMetadata(session: RawSession, credentials: LocalHaplaAgentCredentials): Metadata {
    const encryption = resolveSessionEncryption(session, credentials);
    const encryptedMetadata = decodeBase64(session.metadata);
    const metadata = encryption.variant === 'dataKey'
        ? decryptWithDataKey(encryptedMetadata, encryption.key)
        : decryptLegacy(encryptedMetadata, encryption.key);

    if (!metadata) {
        throw new Error(`Failed to decrypt metadata for Hapla session ${session.id}`);
    }

    try {
        return ResumableMetadataSchema.parse(metadata) as Metadata;
    } catch {
        throw new Error(`Hapla session ${session.id} is missing resumable metadata.`);
    }
}

export async function resolveHaplaSession(sessionId: string): Promise<ResumableHaplaSession> {
    const credentials = readAgentCredentials();

    let sessions: RawSession[];
    try {
        const response = await axios.get(`${configuration.serverUrl}/v1/sessions`, {
            headers: {
                Authorization: `Bearer ${credentials.token}`,
                'X-Hapla-Client': `cli-coding-session/${configuration.currentCliVersion}`,
            },
        });
        sessions = (response.data as { sessions: RawSession[] }).sessions;
    } catch (error) {
        if (error instanceof AxiosError) {
            if (error.response?.status === 401) {
                throw new Error('Hapla session lookup authentication expired. Run `hapla auth login` in this environment.');
            }
            throw new Error(`Failed to load Hapla sessions: ${error.message}`);
        }
        throw error;
    }

    const matched = resolveSessionRecordByPrefix(sessions, sessionId);
    const metadata = decryptSessionMetadata(matched, credentials);
    const root = metadata.conversationRootSessionId;
    if (root && root !== matched.id) {
        const response = await axios.get(`${configuration.serverUrl}/v1/sessions/${encodeURIComponent(root)}/metadata`, {
            headers: { Authorization: `Bearer ${credentials.token}` },
        });
        const owner = { ...response.data, id: root, active: false } as RawSession;
        if (owner.conversationId !== matched.conversationId) throw new Error('会话配置归属不一致');
        metadata.executionConfiguration = decryptSessionMetadata(owner, credentials).executionConfiguration;
    }
    return {
        id: matched.id,
        conversationId: matched.conversationId ?? matched.id,
        active: matched.active,
        metadata,
    };
}
