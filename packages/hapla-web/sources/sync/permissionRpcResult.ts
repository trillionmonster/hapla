/** Routing success and provider permission success are separate RPC envelopes. */
export function assertPermissionRpcSuccess(response: unknown): void {
    if (response && typeof response === 'object' && 'error' in response) {
        const error = (response as { error: unknown }).error;
        throw new Error(typeof error === 'string' && error.trim() ? error : 'Permission request failed');
    }
}
