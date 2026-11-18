import { describe, expect, it } from 'vitest';
import { decryptProtocolPage, readBoundedProtocolResponse, PROTOCOL_PAGE_BYTES } from './protocolDiagnostics';

const chunk = { seq: 3, part: 0, parts: 2, content: 'ciphertext' };
const raw = { version: 1, sessionId: 'session-1', epoch: 'epoch-1', seq: 3, part: 0, parts: 2, record: { kind: 'raw', direction: 'incoming', protocol: { epoch: 'epoch-1', seq: 3 } }, data: '5Lit5paHCg==' };
const page = { chunks: [chunk], cursor: { after_seq: 3, after_part: 0 }, hasMore: true };

describe('bounded protocol diagnostics decryption', () => {
    it('decrypts exact individual bytes without reconstructing a multi-part record', async () => {
        const result = await decryptProtocolPage(page, 'session-1', 'epoch-1', async () => raw);
        expect(result.chunks).toHaveLength(1);
        expect(new TextDecoder().decode(result.chunks[0].bytes)).toBe('中文\n');
        expect(result.chunks[0].parts).toBe(2);
    });
    it('rejects ciphertext moved to another session, epoch, sequence, or part', async () => {
        for (const changed of [{ sessionId: 'other' }, { epoch: 'other' }, { seq: 4 }, { part: 1 }]) {
            await expect(decryptProtocolPage(page, 'session-1', 'epoch-1', async () => ({ ...raw, ...changed }))).rejects.toThrow('关联校验');
        }
        await expect(decryptProtocolPage({ ...page, cursor: { after_seq: 99, after_part: 0 } }, 'session-1', 'epoch-1', async () => raw)).rejects.toThrow('游标');
    });
    it('aborts oversized streaming pages before parsing', async () => {
        let canceled = false;
        const response = new Response(new ReadableStream({
            pull(controller) { controller.enqueue(new Uint8Array(32 * 1024)); },
            cancel() { canceled = true; },
        }));
        await expect(readBoundedProtocolResponse(response)).rejects.toThrow('大小限制');
        expect(canceled).toBe(true);
        await expect(readBoundedProtocolResponse(new Response('{}', { headers: { 'Content-Length': String(PROTOCOL_PAGE_BYTES + 1) } }))).rejects.toThrow('大小限制');
        expect(await readBoundedProtocolResponse(new Response('{"chunks":[]}'))).toEqual({ chunks: [] });
    });
});
