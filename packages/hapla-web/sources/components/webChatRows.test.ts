import { describe, expect, it } from 'vitest';
import type { Message } from '@/sync/typesMessage';
import { isVisibleChatMessage, shouldHoldReadingWindow, snapshotChatMessage, WebChatRowIdentity } from './webChatRows';

const text = (id: string, value = 'text'): Message => ({ kind: 'agent-text', id, localId: null, createdAt: 1, text: value });
const row = (message: Message, rawId = message.id) => ({ message, rawId, sourceSessionId: 'session' });
const signature = (message: Message) => JSON.stringify([message.kind, message.createdAt, 'text' in message ? message.text : message]);

describe('Normal reading rows', () => {
    it('keeps the held permission card visible if the reducer approves its shared permission during touch', () => {
        const permission = { id: 'p', status: 'pending' as 'pending' | 'approved' };
        const message: Message = { kind: 'tool-call', id: 'tool', localId: null, createdAt: 1, children: [], tool: {
            name: 'Bash', state: 'running', input: {}, createdAt: 1, startedAt: 1, completedAt: null, description: null, permission,
        } };
        const held = snapshotChatMessage(message);
        permission.status = 'approved';
        expect(isVisibleChatMessage(held, 'normal')).toBe(true);
        expect(isVisibleChatMessage(message, 'normal')).toBe(false);
    });

    it('holds a 600-row reading window if a delayed older page would evict the row reached by a reverse gesture', () => {
        const old = Array.from({ length: 600 }, (_, i) => ({ ...row(text(String(i))), key: String(i) }));
        const next = [...Array.from({ length: 80 }, (_, i) => ({ ...row(text(String(i - 80))), key: String(i - 80) })), ...old.slice(0, 520)];
        expect(shouldHoldReadingWindow('590', old, next)).toBe(true);
        expect(shouldHoldReadingWindow('500', old, next)).toBe(false);
        expect(shouldHoldReadingWindow(undefined, old, next)).toBe(false);
    });
    it('excludes hidden tool and thinking rows but retains public summaries and questions', () => {
        const tool: Message = { kind: 'tool-call', id: 'tool', localId: null, createdAt: 1, children: [], tool: {
            name: 'Bash', state: 'completed', input: {}, createdAt: 1, startedAt: 1, completedAt: 2, description: null,
        } };
        expect(isVisibleChatMessage(tool, 'normal')).toBe(false);
        expect(isVisibleChatMessage(tool, 'coder')).toBe(true);
        expect(isVisibleChatMessage({ ...tool, tool: { ...tool.tool, name: 'AskUserQuestion' } }, 'normal')).toBe(true);
        expect(isVisibleChatMessage({ ...text('a'), isThinking: true } as Message, 'normal')).toBe(false);
        expect(isVisibleChatMessage({ ...text('a'), isThinking: true, meta: { reasoningSummary: true } } as Message, 'normal')).toBe(true);
        expect(isVisibleChatMessage(text('blank', '   '), 'normal')).toBe(false);
    });

    it('preserves the DOM key while text streams and reducer IDs change after a window rebuild', () => {
        const identity = new WebChatRowIdentity();
        const first = identity.reconcile([row(text('temp', 'first'), 'raw-1')], signature);
        const stream = identity.reconcile([row(text('temp', 'first second'), 'raw-1')], signature);
        const rebuilt = identity.reconcile([row(text('rebuilt', 'first second'), 'raw-1')], signature);
        expect(stream[0].key).toBe(first[0].key);
        expect(rebuilt[0].key).toBe(first[0].key);
    });

    it('preserves exact replay identity through a runtime continuation and never duplicates keys', () => {
        const identity = new WebChatRowIdentity();
        const first = identity.reconcile([row(text('stream'))], signature);
        const persisted = identity.reconcile([{ ...row(text('saved')), sourceSessionId: 'resumed' }], signature);
        expect(persisted[0].key).toBe(first[0].key);
        const duplicateBlocks = identity.reconcile([row(text('a'), 'raw'), row(text('b'), 'raw')], signature);
        expect(new Set(duplicateBlocks.map((item) => item.key)).size).toBe(2);
    });

    it('preserves overlapping rows when the bounded history window moves', () => {
        const identity = new WebChatRowIdentity();
        const first = identity.reconcile([row(text('b', 'B')), row(text('c', 'C'))], signature);
        const older = identity.reconcile([row(text('a', 'A')), row(text('b', 'B'))], signature);
        expect(older[1].key).toBe(first[0].key);
        expect(older[0].key).not.toBe(first[1].key);
    });

    it('reuses a retained text key after many raw windows have moved past it', () => {
        const identity = new WebChatRowIdentity();
        const retained = identity.reconcile([row(text('original', 'answer'), 'raw-answer')], signature);
        identity.reconcile([row(text('other', 'other'), 'raw-other')], signature);
        const reloaded = identity.reconcile([row(text('rebuilt', 'updated answer'), 'raw-answer')], signature, retained);
        expect(reloaded[0].key).toBe(retained[0].key);
    });

    it('does not assign a retained block key to a different block from the same raw event', () => {
        const identity = new WebChatRowIdentity();
        const initial = identity.reconcile([row(text('first', ''), 'raw'), row(text('second', 'visible'), 'raw')], signature);
        identity.reconcile([], signature);
        const reloaded = identity.reconcile([row(text('first', ''), 'raw'), row(text('second', 'visible'), 'raw')], signature, [initial[1]]);
        expect(reloaded[1].key).toBe(initial[1].key);
        expect(reloaded[0].key).not.toBe(initial[1].key);
        expect(new Set(reloaded.map((item) => item.key)).size).toBe(2);
    });

    it('retains both identical blocks through eviction and rebuilt reducer ids', () => {
        const identity = new WebChatRowIdentity();
        const retained = identity.reconcile([row(text('a', 'same'), 'raw'), row(text('b', 'same'), 'raw')], signature);
        identity.reconcile([], signature);
        const reloaded = identity.reconcile([row(text('c', 'same'), 'raw'), row(text('d', 'same'), 'raw')], signature, retained);
        expect(reloaded.map((item) => item.key)).toEqual(retained.map((item) => item.key));
    });
});
