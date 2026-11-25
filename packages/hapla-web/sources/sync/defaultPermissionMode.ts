import type { PermissionModeKey } from '@/components/PermissionModeSelector';

/** A fresh device inherits the runtime; it must never expand existing permissions. */
export function defaultPermissionModeForSession(_metadata: { flavor?: string | null; sandbox?: unknown } | null | undefined): PermissionModeKey {
    return 'default';
}
