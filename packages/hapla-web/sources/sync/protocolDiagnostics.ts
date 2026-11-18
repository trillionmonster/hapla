import { decodeBase64 } from '@/encryption/base64';

export type ProtocolCursor = { after_seq: number; after_part: number };
export type ProtocolCipherChunk = { seq: number; part: number; parts: number; content: string };
export type ProtocolEpoch = { epoch: string; epochStartedAt: number; lastSeq: number };
export type ProtocolDiagnosticChunk = Omit<ProtocolCipherChunk, 'content'> & {
    summary: { method?: string; kind: string; direction: string; protocol: Record<string, unknown> };
    bytes: Uint8Array;
};
export const PROTOCOL_PAGE_BYTES = 256 * 1024;

/** Reject oversized responses while streaming, before JSON parsing or decryption. */
export async function readBoundedProtocolResponse(response: Response): Promise<unknown> {
    if (!response.ok) throw new Error(`协议日志读取失败 (${response.status})`);
    if (Number(response.headers.get('Content-Length') ?? 0) > PROTOCOL_PAGE_BYTES) {
        await response.body?.cancel();
        throw new Error('协议日志页面超过大小限制');
    }
    if (!response.body) throw new Error('协议日志响应缺少正文');
    const reader = response.body.getReader();
    let text = '';
    let size = 0;
    const decoder = new TextDecoder();
    try {
        while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > PROTOCOL_PAGE_BYTES) { await reader.cancel(); throw new Error('协议日志页面超过大小限制'); }
            text += decoder.decode(value, { stream: true });
        }
        text += decoder.decode();
        return JSON.parse(text);
    } finally { reader.releaseLock(); }
}

export async function decryptProtocolPage(
    value: unknown,
    sessionId: string,
    epoch: string,
    decrypt: (content: string) => Promise<unknown>,
): Promise<{ chunks: ProtocolDiagnosticChunk[]; cursor: ProtocolCursor; hasMore: boolean }> {
    const page = value as { chunks?: ProtocolCipherChunk[]; cursor?: ProtocolCursor; hasMore?: boolean };
    if (!Array.isArray(page?.chunks) || page.chunks.length > 32 || !page.cursor || !Number.isSafeInteger(page.cursor.after_seq) || !Number.isSafeInteger(page.cursor.after_part)) {
        throw new Error('无效的协议日志页面');
    }
    const chunks: ProtocolDiagnosticChunk[] = [];
    let previous: ProtocolCipherChunk | undefined;
    for (const chunk of page.chunks) {
        if (!Number.isSafeInteger(chunk.seq) || chunk.seq < 1 || !Number.isSafeInteger(chunk.part) || chunk.part < 0 || !Number.isSafeInteger(chunk.parts) || chunk.part >= chunk.parts || typeof chunk.content !== 'string' || chunk.content.length > 48 * 1024) {
            throw new Error('无效的协议日志分片');
        }
        if (previous && (chunk.seq < previous.seq || (chunk.seq === previous.seq && chunk.part <= previous.part))) throw new Error('协议日志游标顺序错误');
        previous = chunk;
        const raw = await decrypt(chunk.content) as any;
        if (!raw || raw.version !== 1 || raw.sessionId !== sessionId || raw.epoch !== epoch || raw.seq !== chunk.seq || raw.part !== chunk.part || raw.parts !== chunk.parts || raw.record?.protocol?.epoch !== epoch || raw.record?.protocol?.seq !== chunk.seq || typeof raw.data !== 'string' || raw.data.length > 32 * 1024) {
            throw new Error('协议日志解密或关联校验失败');
        }
        const bytes = decodeBase64(raw.data);
        if (bytes.byteLength > 24 * 1024) throw new Error('协议日志分片超过大小限制');
        chunks.push({ seq: chunk.seq, part: chunk.part, parts: chunk.parts, summary: raw.record, bytes });
    }
    if (previous && (page.cursor.after_seq !== previous.seq || page.cursor.after_part !== previous.part)) throw new Error('协议日志返回了错误的游标');
    return { chunks, cursor: page.cursor, hasMore: page.hasMore === true };
}

/** Preview one byte slice only. Split UTF-8 boundary bytes are kept intact in the raw download. */
export function protocolChunkPreview(chunk: ProtocolDiagnosticChunk): string {
    return new TextDecoder().decode(chunk.bytes);
}
