import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ContentBlock } from '@/utils/MessageQueue2';
import type { CodexInputState } from '@hapla/wire';
type Receipt = NonNullable<CodexInputState['receipts']>[number];

export type PendingCodexInput<T> = {
    id: string;
    message: string;
    contentBlocks?: ContentBlock[];
    mode: T;
    revision: number;
    createdAt: number;
    error?: string;
};

/** One durable submission per turn. Queue edits never alter an active turn. */
export class CodexInputQueue<T> {
    private items: PendingCodexInput<T>[] = [];
    private completed = new Set<string>();
    private waiter: (() => void) | undefined;
    private closed = false;
    private paused = false;
    private inFlight: PendingCodexInput<T> | null = null;
    private held = new Set<string>();
    private immediate = new Set<string>();
    private receipts: Receipt[] = [];

    constructor(private modeHasher: (mode: T) => string, private file?: string, private changed: () => void = () => {}) {
        if (!file) return;
        try {
            const saved = JSON.parse(readFileSync(file, 'utf8'));
            if (saved.version !== 1 || !Array.isArray(saved.items) || !Array.isArray(saved.completed)) throw new Error('Invalid Codex input queue');
            this.items = saved.items;
            if (saved.inFlight) this.items.unshift({ ...saved.inFlight, error: '运行环境已重启，请确认后重试这条消息' });
            this.completed = new Set(saved.completed);
            this.receipts = saved.receipts ?? [];
            this.paused = saved.paused === true || !!saved.inFlight || saved.held?.length > 0 || saved.immediate?.length > 0;
        } catch (error: any) {
            if (error.code !== 'ENOENT') throw error;
        }
    }

    snapshot() { return { paused: this.paused, items: this.items.map(item => ({ ...item })), receipts: this.receipts.map(receipt => ({ ...receipt })) }; }
    has(id: string) { return this.completed.has(id) || this.inFlight?.id === id || this.items.some(item => item.id === id); }
    size() { return this.items.length; }
    isClosed() { return this.closed; }

    private save() {
        if (this.file) {
            mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
            const temporary = `${this.file}.${randomUUID()}.tmp`;
            writeFileSync(temporary, JSON.stringify({ version: 1, items: this.items, inFlight: this.inFlight, held: [...this.held], immediate: [...this.immediate], receipts: this.receipts, paused: this.paused, completed: [...this.completed].slice(-2000) }), { mode: 0o600 });
            renameSync(temporary, this.file);
        }
        this.changed();
    }

    push(message: string, mode: T, id: string = randomUUID()) {
        return this.pushMultimodal([{ type: 'text', text: message }], mode, id);
    }

    pushMultimodal(contentBlocks: ContentBlock[], mode: T, id: string = randomUUID(), hold = false) {
        if (this.closed) throw new Error('Codex input queue is closed');
        if (this.has(id)) return id;
        if (this.items.length >= 100) throw new Error('待处理消息已达 100 条，请先处理现有队列');
        this.items.push({ id, message: contentBlocks.filter(item => item.type === 'text').map(item => item.text).join('\n') || '[image]', contentBlocks, mode, revision: 0, createdAt: Date.now() });
        if (hold) this.held.add(id);
        this.receipt(id, hold ? 'submitting' : 'queued');
        this.save();
        this.wake();
        return id;
    }

    update(id: string, revision: number, message: string) {
        const item = this.require(id, revision);
        if (!message.trim()) throw new Error('消息不能为空');
        // Keep images/skills while replacing the text portion.
        item.message = message;
        item.contentBlocks = [...(item.contentBlocks ?? []).filter(block => block.type !== 'text'), { type: 'text', text: message }];
        item.revision++;
        item.error = undefined;
        this.save();
    }

    remove(id: string, revision: number) {
        this.require(id, revision);
        this.items = this.items.filter(item => item.id !== id);
        this.immediate.delete(id);
        this.completed.add(id);
        this.receipt(id, 'canceled');
        this.save();
    }

    reorder(ids: string[]) {
        if (ids.length !== this.items.length || new Set(ids).size !== ids.length || ids.some(id => !this.items.some(item => item.id === id))) throw new Error('队列已变化，请刷新后重试');
        const byId = new Map(this.items.map(item => [item.id, item]));
        this.items = ids.map(id => byId.get(id)!);
        this.save();
    }

    start(id?: string) {
        if (id) {
            const item = this.require(id);
            this.items = [item, ...this.items.filter(entry => entry.id !== id)];
            // Authorize only this submission. A direct send or replacement must
            // never resume older paused/failed inputs with unknown side effects.
            this.immediate.add(id);
        } else this.paused = false;
        this.save();
        this.wake();
    }

    pause() { this.paused = true; this.immediate.clear(); this.save(); }
    close() { this.closed = true; this.wake(); }

    fail(id: string, error: string) {
        if (this.completed.has(id)) return;
        this.held.delete(id);
        this.immediate.delete(id);
        if (this.inFlight?.id === id) { this.items.unshift(this.inFlight); this.inFlight = null; }
        const item = this.require(id);
        item.error = error;
        this.receipt(id, 'failed');
        this.paused = true;
        this.save();
    }

    acknowledge(id: string, status: Receipt['status'] = 'completed') {
        if (this.inFlight?.id === id) this.inFlight = null;
        this.held.delete(id);
        this.immediate.delete(id);
        this.items = this.items.filter(item => item.id !== id);
        this.completed.add(id);
        this.receipt(id, status);
        this.save();
    }

    private receipt(id: string, status: Receipt['status']) {
        this.receipts = [...this.receipts.filter(receipt => receipt.id !== id), { id, status }].slice(-100);
    }

    hold(id: string) {
        this.require(id);
        if (this.held.has(id)) throw new Error('这条消息正在提交，请稍候');
        this.held.add(id); this.receipt(id, 'submitting'); this.save();
    }

    release(id: string) { this.held.delete(id); this.receipt(id, 'queued'); this.save(); this.wake(); }

    get(id: string, revision?: number) { return this.require(id, revision); }
    private require(id: string, revision?: number) {
        if (this.held.has(id)) throw new Error('这条消息正在提交，请稍候');
        const item = this.items.find(item => item.id === id);
        if (!item || (revision !== undefined && item.revision !== revision)) throw new Error('这条消息已开始处理或已被修改，请刷新队列');
        return item;
    }

    private wake() { const waiter = this.waiter; this.waiter = undefined; waiter?.(); }

    async waitForMessagesAndGetAsString(signal?: AbortSignal): Promise<(PendingCodexInput<T> & { isolate: boolean; hash: string }) | null> {
        while (!this.closed && !signal?.aborted) {
            const index = this.items.findIndex(item => !this.held.has(item.id) && (!this.paused || this.immediate.has(item.id)));
            if (index >= 0) {
                const [item] = this.items.splice(index, 1);
                this.immediate.delete(item.id);
                this.inFlight = item;
                this.receipt(item.id, 'running');
                this.save();
                return { ...item, isolate: true, hash: this.modeHasher(item.mode) };
            }
            await new Promise<void>(resolve => {
                const done = () => { signal?.removeEventListener('abort', done); if (this.waiter === done) this.waiter = undefined; resolve(); };
                this.waiter = done;
                signal?.addEventListener('abort', done, { once: true });
                if (signal?.aborted || this.closed) done();
            });
        }
        return null;
    }
}
