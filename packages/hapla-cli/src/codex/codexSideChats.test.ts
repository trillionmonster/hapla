import { it, expect, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CodexSideChats } from './codexSideChats';
it('applies this reply’s desired settings to a separate read-only native turn', async () => {
    const root = mkdtempSync(join(tmpdir(), 'hapla-side-config-'));
    const sent = vi.fn(async () => ({ aborted: false }));
    const client = { setApprovalHandler: vi.fn(), setUserInputHandler: vi.fn(), setEventHandler: vi.fn(), connect: vi.fn(), forkThread: vi.fn(async () => ({ threadId: 'side' })), requestRaw: vi.fn(), sendTurnContentAndWait: sent, disconnect: vi.fn() };
    const chats = new CodexSideChats({ file: join(root, 'root.json'), sourceThread: () => 'main', createClient: () => client as any, changed: vi.fn(), approval: vi.fn(), userInput: vi.fn() });
    try {
        await chats.submit({ id: 'question', text: 'side question', configuration: { model: 'selected', effort: 'high', verbosity: 'high', serviceTier: 'priority', collaborationMode: 'plan', permissionMode: 'yolo' } });
        await vi.waitFor(() => expect(sent).toHaveBeenCalled());
        expect(sent.mock.calls[0]).toEqual([[{ type: 'text', text: 'side question' }], expect.objectContaining({ model: 'selected', effort: 'high', verbosity: 'high', serviceTier: 'priority', collaborationMode: 'plan', sandbox: 'read-only', approvalPolicy: 'never' })]);
    } finally { await chats.close(); rmSync(root, { recursive: true, force: true }); }
});
