import { describe, expect, it, vi } from 'vitest';
vi.mock('./workspaceFileTransfer', () => ({ bytesToBase64: (bytes: Uint8Array) => Buffer.from(bytes).toString('base64') }));
const rpc = vi.hoisted(() => ({ begin: vi.fn(), chunk: vi.fn(), finish: vi.fn(), status: vi.fn(), abort: vi.fn() }));
vi.mock('@/sync/ops', () => ({
    sessionFileUploadBegin: rpc.begin, sessionFileUploadChunk: rpc.chunk, sessionFileUploadFinish: rpc.finish,
    sessionFileUploadStatus: rpc.status, sessionFileUploadAbort: rpc.abort,
}));
import { attachmentDestination, attachmentMessage, hashAttachment, uploadAttachment, type AttachmentUploadCheckpoint } from './workspaceAttachments';

describe('workspace attachments', () => {
    it('streams standard SHA-256 including empty files and sanitizes names without collisions', async () => {
        expect(await hashAttachment(new Blob(['abc']))).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
        expect(await hashAttachment(new Blob([]))).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
        const path = attachmentDestination('../中文/ a\u0000.csv', 'one');
        expect(path).not.toMatch(/[\u0000/\\]/);
        expect(path).not.toBe(attachmentDestination('../中文/ a\u0000.csv', 'two'));
        expect(attachmentMessage('读取', [{ name: 'a.csv', path, mimeType: 'text/csv', size: 0, sha256: 'digest' }]).text).toContain('"attachments":[');
    });
    it('resumes after a lost chunk response, keeps the target fixed, and validates completion', async () => {
        vi.clearAllMocks();
        const file = new File(['abcdef'], 'a.txt');
        const digest = await hashAttachment(file);
        let checkpoint: AttachmentUploadCheckpoint | undefined;
        rpc.begin.mockResolvedValue({ success: true, uploadId: 'upload', chunkSize: 3 });
        rpc.chunk.mockRejectedValueOnce(new Error('connection lost'));
        const options = { sessionId: 'A', file, path: 'a.txt', onCheckpoint: (value: AttachmentUploadCheckpoint | undefined) => { checkpoint = value; } };
        await expect(uploadAttachment(options)).rejects.toThrow('connection lost');
        expect(checkpoint?.sessionId).toBe('A');
        expect(rpc.abort).not.toHaveBeenCalled();
        rpc.status.mockResolvedValue({ success: true, received: 3, size: 6, sha256: digest, complete: false });
        rpc.chunk.mockResolvedValue({ success: true, received: 6 });
        rpc.finish.mockResolvedValue({ success: true, path: 'a.txt', size: 6, sha256: digest });
        await expect(uploadAttachment({ ...options, sessionId: 'B', checkpoint })).rejects.toThrow('会话');
        const result = await uploadAttachment({ ...options, checkpoint });
        expect(result.sha256).toBe(digest);
        expect(rpc.chunk).toHaveBeenLastCalledWith('A', 'upload', 3, 'ZGVm');
        expect(checkpoint).toBeUndefined();
    });
    it('cancels an in-progress transfer and never sends a completed attachment', async () => {
        vi.clearAllMocks();
        const controller = new AbortController();
        rpc.begin.mockResolvedValue({ success: true, uploadId: 'cancel', chunkSize: 3 });
        rpc.chunk.mockImplementationOnce(() => { controller.abort(); return { success: true, received: 3 }; });
        rpc.abort.mockResolvedValue({ success: true });
        await expect(uploadAttachment({ sessionId: 'A', file: new File(['abcdef'], 'a.txt'), path: 'a.txt', signal: controller.signal, onCheckpoint: () => {} })).rejects.toThrow('取消');
        expect(rpc.abort).toHaveBeenCalledWith('A', 'cancel');
        expect(rpc.finish).not.toHaveBeenCalled();
    });
});
