import { useUpdates } from '@/hooks/useUpdates';

/** Keep release diagnostics available without interrupting the conversation. */
export function WebReleaseMonitor() {
    // Publishing a release must neither display an update prompt nor reload an
    // active session. A new page load or manual refresh picks up the release.
    useUpdates();
    return null;
}
