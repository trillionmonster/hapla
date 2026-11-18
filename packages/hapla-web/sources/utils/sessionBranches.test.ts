import { describe, expect, it } from 'vitest';
import type { Message } from '@/sync/typesMessage';
import { filterMessagesForActiveBranch, getActiveBranchLineage, getUserMessageOrdinal } from './sessionBranches';

const message = (id: string, createdAt: number, branchId?: string): Message => ({
    kind: 'user-text', id, localId: null, createdAt, text: id, meta: branchId ? { branchId } : undefined,
});

describe('session branches', () => {
    const messages = [
        message('shared-1', 1),
        message('fork-point', 2),
        message('original-later', 3, 'root'),
        message('edited', 4, 'child'),
        message('other', 5, 'other'),
    ];
    const metadata: any = {
        activeCodexBranchId: 'child',
        codexBranches: [
            { id: 'root', threadId: 'root', label: 'Original', createdAt: 1 },
            { id: 'child', threadId: 'child', label: 'Edit', parentId: 'root', forkMessageId: 'fork-point', forkMessageCreatedAt: 2, createdAt: 4 },
            { id: 'other', threadId: 'other', label: 'Other', parentId: 'root', forkMessageId: 'fork-point', createdAt: 5 },
        ],
    };

    it('keeps the shared prefix and selected branch while hiding divergent successors', () => {
        expect(filterMessagesForActiveBranch(messages, metadata).map((item) => item.id)).toEqual(['shared-1', 'edited']);
    });

    it('builds ancestry and calculates visible user ordinals', () => {
        expect(getActiveBranchLineage(metadata).map((branch) => branch.id)).toEqual(['root', 'child']);
        expect(getUserMessageOrdinal(filterMessagesForActiveBranch(messages, metadata), 'edited')).toBe(1);
    });

    it('retains a stable cutoff after the optimistic message id is replaced', () => {
        const replaced = messages.map((item) => item.id === 'fork-point' ? { ...item, id: 'server-fork-point' } : item);
        expect(filterMessagesForActiveBranch(replaced, metadata).map((item) => item.id)).toEqual(['shared-1', 'edited']);
    });

    it('uses branch creation time to isolate legacy branches without fork metadata', () => {
        const legacyMetadata = {
            ...metadata,
            codexBranches: [
                metadata.codexBranches[0],
                { id: 'child', threadId: 'child', label: 'Edit', parentId: 'root', createdAt: 2.5 },
            ],
        };
        expect(filterMessagesForActiveBranch(messages, legacyMetadata).map((item) => item.id))
            .toEqual(['shared-1', 'fork-point', 'edited']);
    });
});


it('keeps a protocol-scoped input card on its child branch even without message metadata', () => {
    const metadata: any = { activeCodexBranchId: 'child', codexBranches: [
        { id: 'main', threadId: 'main-thread', createdAt: 1 },
        { id: 'child', threadId: 'child-thread', parentId: 'main', createdAt: 10, forkMessageCreatedAt: 10 },
    ] };
    const request = (id: string, threadId: string): any => ({ kind: 'tool-call', id, createdAt: 20, children: [], tool: {
        name: 'AskUserQuestion', state: 'running', input: {}, permission: { id, status: 'pending', protocol: { epoch: 'epoch', requestId: id, threadId, turnId: 'turn', itemId: 'item' } },
    } });
    expect(filterMessagesForActiveBranch([request('current', 'child-thread'), request('old', 'main-thread')], metadata).map(message => message.id)).toEqual(['current']);
});
