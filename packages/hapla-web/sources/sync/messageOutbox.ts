import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils';

export type OutboxMessage = { localId: string; content: string; requestKey?: string; failed?: boolean };
export function messageRequestKey(value: unknown): string {
    return bytesToHex(sha256(utf8ToBytes(JSON.stringify(value))));
}
export function parseOutbox(value: string | undefined): Map<string, OutboxMessage[]> {
    const result = new Map<string, OutboxMessage[]>();
    if (!value) return result;
    const entries = JSON.parse(value);
    if (!Array.isArray(entries)) throw new Error('待发消息记录无法读取，请保留当前浏览器数据');
    for (const [id, messages] of entries) {
        if (typeof id !== 'string' || !Array.isArray(messages) || messages.some(row => !row || typeof row.localId !== 'string' || typeof row.content !== 'string')) throw new Error('待发消息记录损坏，请保留当前浏览器数据');
        // Reload is not authorization to execute an ambiguous submission again.
        result.set(id, messages.map(row => ({ ...row, failed: true })));
    }
    return result;
}

/** A runtime replacement keeps the logical submission id but uses its own cipher. */
export async function recoverOutboxRequest(outbox: Map<string, OutboxMessage[]>, runtimeIds: string[], target: string, requestKey: string,
    encryption: { getSessionEncryption(id: string): { decryptRaw(value: string): Promise<any>; encryptRawRecord(value: any): Promise<string> } | null }): Promise<OutboxMessage | undefined> {
    for (const id of runtimeIds) {
        const source = outbox.get(id);
        const previous = source?.find(message => message.requestKey === requestKey);
        if (!previous) continue;
        if (id !== target) {
            const from = encryption.getSessionEncryption(id); const to = encryption.getSessionEncryption(target);
            if (!from || !to) throw new Error('原待发消息的加密状态尚未就绪，请重试');
            const content = await from.decryptRaw(previous.content);
            if (!content || content.role !== 'user') throw new Error('原待发消息无法解密，请保留浏览器数据');
            const moved = { ...previous, content: await to.encryptRawRecord(content), failed: false };
            outbox.set(id, source!.filter(message => message !== previous));
            outbox.set(target, [...outbox.get(target) ?? [], moved]);
            return moved;
        }
        return previous;
    }
}
