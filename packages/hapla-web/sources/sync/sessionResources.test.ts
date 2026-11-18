import { describe, expect, it, vi } from 'vitest';
import { ByteLruCache, SessionResourceRegistry, estimateRetainedBytes } from './sessionResources';
import { initialHistorySession, olderHistorySession, historyPagePath } from './sessionHistory';

describe('session resource lifetime', () => {
    it('evicts by bytes and recent access, and clears plaintext for one owner', () => {
        const item = 'x'.repeat(100);
        const cache = new ByteLruCache<string>(estimateRetainedBytes(item) * 2);
        cache.set('a', item, 'one'); cache.set('b', item, 'two'); cache.get('a'); cache.set('c', item, 'three');
        expect(cache.get('b')).toBeUndefined();
        expect(cache.get('a')).toBe(item);
        cache.clearOwner('one');
        expect(cache.get('a')).toBeUndefined();
        expect(cache.bytes).toBe(estimateRetainedBytes(item));
        cache.set('huge', item.repeat(100));
        expect(cache.size).toBe(1);
    });

    it('aborts requests, invalidates late work, and revokes each Blob exactly once', () => {
        const registry = new SessionResourceRegistry();
        const abort = new AbortController();
        registry.register('session', () => abort.abort());
        const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
        const dispose = registry.trackObjectUrl('session', 'blob:preview');
        const current = registry.capture('session');
        registry.release('session'); dispose(); registry.release('session');
        expect(abort.signal.aborted).toBe(true);
        expect(current()).toBe(false);
        expect(registry.capture('session')()).toBe(true);
        expect(revoke).toHaveBeenCalledExactlyOnceWith('blob:preview');
        expect(registry.getStats()).toEqual({ sessions: 0, resources: 0 });
        revoke.mockRestore();
    });

    it('loads a single runtime window and advances archived runtimes only at the cursor boundary', () => {
        const ids = ['new', 'middle', 'old'];
        expect(initialHistorySession(ids, {})).toBe('new');
        expect(initialHistorySession(ids, { new: { anchor: { offset: 500, sourceSessionId: 'middle', seq: 200 } } })).toBe('middle');
        expect(olderHistorySession(ids, { new: { hasOlder: true } })).toBe('new');
        expect(olderHistorySession(ids, { new: { hasOlder: false } })).toBe('middle');
        expect(olderHistorySession(ids, { middle: { hasOlder: false } })).toBe('old');
        expect(olderHistorySession(ids, { old: { hasOlder: false } })).toBeUndefined();
        expect(historyPagePath('new', {})).toBe('/v3/sessions/new/messages?before_seq=2147483647&limit=80');
        expect(historyPagePath('middle', { before: 50000 })).toBe('/v3/sessions/middle/messages?before_seq=50000&limit=80');
        expect(historyPagePath('old', { after: 12 })).toBe('/v3/sessions/old/messages?after_seq=12&limit=100');
    });
});
