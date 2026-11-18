import snapshot from './codexProtocolSnapshot.json';

// Both contracts were generated and checked against the bridge. Preserve the
// earlier verified runtime during a gradual machine/CLI rollout; do not infer
// compatibility for an unreviewed patch or minor version.
const VERIFIED_COMPATIBILITY_VERSIONS = new Set(['0.153.4', '0.156.1']);

export function codexProtocolAdapter(cliVersion: string) {
    const verified = cliVersion === snapshot.cliVersion || VERIFIED_COMPATIBILITY_VERSIONS.has(cliVersion);
    return {
        id: verified ? `app-server-v2/${cliVersion}` : 'app-server-v2/unverified-compatibility',
        verified,
        verifiedVersion: snapshot.cliVersion,
    };
}

export function codexEventCorrelation(params: any): {
    threadId?: string; turnId?: string; itemId?: string; requestId?: string | number;
} {
    const text = (value: unknown) => typeof value === 'string' && value.length ? value : undefined;
    const requestId = params?.requestId ?? params?.request_id;
    const threadId = text(params?.threadId ?? params?.thread_id ?? params?.conversationId ?? params?.thread?.id);
    const turnId = text(params?.turnId ?? params?.turn_id ?? params?.turn?.id ?? params?.msg?.turn_id);
    const itemId = text(params?.itemId ?? params?.item_id ?? params?.item?.id ?? params?.call_id);
    return {
        ...(threadId ? { threadId } : {}),
        ...(turnId ? { turnId } : {}),
        ...(itemId ? { itemId } : {}),
        ...(typeof requestId === 'string' || typeof requestId === 'number' ? { requestId } : {}),
    };
}
