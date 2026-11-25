import type { SpawnSessionResult } from '@/modules/common/registerCommonHandlers';
/** A lost browser acknowledgement must not launch a second agent in the same checkout. */
export function spawnSessionReceipts() {
    const requests = new Map<string, Promise<SpawnSessionResult>>();
    return (id: unknown, operation: () => Promise<SpawnSessionResult>) => {
        if (id === undefined) return operation();
        if (typeof id !== 'string' || !/^[a-f0-9-]{36}$/i.test(id)) throw new Error('Invalid session creation request ID.');
        const previous = requests.get(id); if (previous) return previous;
        if (requests.size >= 2000) throw new Error('Session creation receipt limit reached. Restart the idle development worker before creating more sessions.');
        const pending = operation(); requests.set(id, pending);
        // Uncertain errors remain cached: callers can inspect sessions instead of duplicating the launch.
        return pending;
    };
}
