import { describe, expect, it } from 'vitest';
import { codexEventCorrelation, codexProtocolAdapter } from './codexProtocolAdapter';

describe('reviewed Codex protocol versions', () => {
    it.each(['0.153.4', '0.156.1', '0.159.0'])('keeps experimental protocol support enabled for reviewed %s', (version) => {
        expect(codexProtocolAdapter(version)).toEqual({
            id: `app-server-v2/${version}`, verified: true, verifiedVersion: '0.159.0',
        });
    });

    it.each(['unknown', '0.156.0', '0.156.2', '0.157.0', '1.0.0'])('does not auto-approve unreviewed %s', (version) => {
        expect(codexProtocolAdapter(version)).toEqual({
            id: 'app-server-v2/unverified-compatibility', verified: false, verifiedVersion: '0.159.0',
        });
    });

    it('retains generated notification correlation and numeric server request ids', () => {
        expect(codexEventCorrelation({ threadId: 'thread', turn: { id: 'turn' }, item: { id: 'item' }, requestId: 0 }))
            .toEqual({ threadId: 'thread', turnId: 'turn', itemId: 'item', requestId: 0 });
    });
});
