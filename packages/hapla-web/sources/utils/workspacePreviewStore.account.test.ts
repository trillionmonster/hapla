import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearWorkspacePreviewPersistence } from './workspacePreviewStore';

let request: any;
let transaction: any;
let database: any;
const clearChunks = vi.fn();
const clearOwners = vi.fn();

beforeEach(() => {
    vi.clearAllMocks();
    transaction = {
        objectStore: vi.fn((name: string) => ({ clear: name === 'chunks' ? clearChunks : clearOwners })),
        abort: vi.fn(),
    };
    database = { transaction: vi.fn(() => transaction), close: vi.fn() };
    request = { result: database };
    vi.stubGlobal('indexedDB', { open: vi.fn(() => request) });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('account preview cache deletion', () => {
    it('waits for both the file bytes and owner records to commit deletion before allowing account changes', async () => {
        let complete = false;
        const pending = clearWorkspacePreviewPersistence().then(() => { complete = true; });
        request.onsuccess();
        await Promise.resolve();
        expect(clearChunks).toHaveBeenCalledTimes(1);
        expect(clearOwners).toHaveBeenCalledTimes(1);
        expect(database.transaction).toHaveBeenCalledWith(['chunks', 'owners'], 'readwrite');
        expect(complete).toBe(false);
        transaction.oncomplete();
        await pending;
        expect(complete).toBe(true);
        expect(database.close).toHaveBeenCalledTimes(1);
    });

    it('blocks account changes when deletion fails so another account cannot inherit preview bytes', async () => {
        const pending = clearWorkspacePreviewPersistence();
        const rejected = expect(pending).rejects.toThrow('无法清除上一个账号的文件缓存');
        request.onsuccess();
        transaction.onerror();
        await rejected;
        expect(database.close).toHaveBeenCalledTimes(1);
    });

    it('terminates a stalled deletion with a retryable error', async () => {
        vi.useFakeTimers();
        const pending = clearWorkspacePreviewPersistence();
        const rejected = expect(pending).rejects.toThrow('请重试');
        request.onsuccess();
        await vi.advanceTimersByTimeAsync(15_000);
        await rejected;
        expect(transaction.abort).toHaveBeenCalledTimes(1);
    });
});
