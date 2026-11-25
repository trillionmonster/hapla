import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
type TurnInput = { threadId: string; turnId: string; steered?: boolean };
/** Native identity, independent of viewport order, repeated text and edited queue content. */
export class TurnInputLedger {
    private entries: Record<string, TurnInput> = {};
    constructor(private file: string) {
        try { this.entries = JSON.parse(readFileSync(file, 'utf8')); }
        catch (error: any) { if (error.code !== 'ENOENT') throw error; }
    }
    get(messageId: string) { return this.entries[messageId]; }
    record(messageId: string | undefined, input: TurnInput) {
        if (!messageId) return;
        this.entries[messageId] = input;
        mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
        const temporary = this.file + '.' + randomUUID() + '.tmp';
        writeFileSync(temporary, JSON.stringify(this.entries), { mode: 0o600 }); renameSync(temporary, this.file);
    }
}
