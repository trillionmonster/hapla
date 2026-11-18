import type { PermissionModeKey } from '@/components/PermissionModeSelector';

type PermissionMetadata = {
    flavor?: string | null;
    sandbox?: unknown;
} | null | undefined;

function isManagedSandboxEnabled(metadata: PermissionMetadata): boolean {
    const sandbox = metadata?.sandbox;
    return !!sandbox
        && typeof sandbox === 'object'
        && (sandbox as { enabled?: unknown }).enabled === true;
}

/** Keep browser defaults aligned with the agent's native startup policy. */
export function defaultPermissionModeForSession(metadata: PermissionMetadata): PermissionModeKey {
    if (isManagedSandboxEnabled(metadata)) return 'bypassPermissions';
    if (metadata?.flavor === 'codex') return 'yolo';
    return 'default';
}
