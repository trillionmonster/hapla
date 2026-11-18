import { describe, expect, it } from 'vitest';
import { assertPermissionRpcSuccess } from './permissionRpcResult';

describe('encrypted permission RPC result', () => {
    it('rejects the decrypted handler error even when outer routing succeeded', () => {
        expect(() => assertPermissionRpcSuccess({ error: 'This request is no longer pending in the active Codex runtime' })).toThrow('no longer pending');
        expect(() => assertPermissionRpcSuccess({ error: '' })).toThrow('Permission request failed');
    });
    it('accepts submitting receipts and legacy void responses', () => {
        for (const response of [undefined, null, { status: 'submitting' }, { status: 'resolved' }]) expect(() => assertPermissionRpcSuccess(response)).not.toThrow();
    });
});
