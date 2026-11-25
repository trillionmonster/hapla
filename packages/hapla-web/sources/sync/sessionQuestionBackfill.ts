import type { ApiMessage } from './apiTypes';

export const QUESTION_BACKFILL_CONCURRENCY = 2;
export const QUESTION_BACKFILL_PAGE_SIZE = 20;
export const QUESTION_BACKFILL_REQUEST_TIMEOUT_MS = 15_000;
type RecordObject = Record<string, any>;
const object = (value: unknown): value is RecordObject => !!value && typeof value === 'object' && !Array.isArray(value);
const compactReplayText = (value: unknown) => typeof value === 'string' && /^\s*This session is being continued from a previous conversation/i.test(value);

/** Inspect only envelope fields. This deliberately does not normalize, cache or
 * render historical content, including media and tool output. */
export function isUserQuestionRecord(raw: unknown): boolean {
    if (!object(raw)) return false;
    if (raw.meta?.messageRole === 'agent' || raw.meta?.messageRole === 'system' || raw.meta?.isMeta || raw.meta?.isCompactSummary || raw.meta?.isSynthetic || raw.meta?.isSidechain || raw.meta?.replayed || raw.meta?.isReplay) return false;
    if (raw.role === 'user' && object(raw.content)) {
        return (raw.content.type === 'text' && typeof raw.content.text === 'string')
            || (raw.content.type === 'multimodal' && Array.isArray(raw.content.parts));
    }
    const envelope = raw.role === 'session'
        ? (raw.content?.type === 'session' ? raw.content.data : raw.content)
        : !('content' in raw) ? raw : null;
    if (object(envelope)) return !envelope.ev?.inputEdit && envelope.role === 'user' && !envelope.subagent && envelope.ev?.t === 'text' && typeof envelope.ev.text === 'string';
    if (raw.role === 'agent' && raw.content?.type === 'output') {
        const data = raw.content.data;
        if (!object(data) || data.type !== 'user' || data.isMeta || data.isCompactSummary || data.isSynthetic || data.isSidechain || data.parent_tool_use_id || data.toolUseResult) return false;
        const content = data.message?.content;
        if (typeof content === 'string') return !compactReplayText(content);
        if (!Array.isArray(content) || content.some(part => ['tool_result', 'tool-result', 'tool-call-result'].includes(part?.type))) return false;
        if (content.some(part => part?.type === 'text' && compactReplayText(part.text))) return false;
        return content.some(part => (part?.type === 'text' && typeof part.text === 'string') || ['image', 'document'].includes(part?.type));
    }
    return false;
}

export type QuestionBackfillTask = { id: string; seq: number; indexedThroughSeq?: number | null };
export type QuestionBackfillResult = { messageId: string | null; scannedThroughSeq: number };
type BackfillDependencies = {
    fetchPage: (sessionId: string, before: number, limit: number, signal: AbortSignal) => Promise<{ messages: ApiMessage[]; hasMore: boolean }>;
    decrypt: (sessionId: string, message: ApiMessage) => Promise<unknown>;
    save: (sessionId: string, result: QuestionBackfillResult, signal: AbortSignal) => Promise<void>;
    isCurrent: (task: QuestionBackfillTask) => boolean;
};

async function boundedRequest<T>(operation: (signal: AbortSignal) => Promise<T>, parent: AbortSignal): Promise<T> {
    if (parent.aborted) throw new DOMException('Question index changed', 'AbortError');
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abort: (() => void) | undefined;
    const interrupted = new Promise<never>((_, reject) => {
        abort = () => { controller.abort(); reject(new DOMException('Question index changed', 'AbortError')); };
        parent.addEventListener('abort', abort, { once: true });
        timer = setTimeout(() => { controller.abort(); reject(new Error('Question index request timed out')); }, QUESTION_BACKFILL_REQUEST_TIMEOUT_MS);
    });
    try { return await Promise.race([operation(controller.signal), interrupted]); }
    finally { clearTimeout(timer); if (abort) parent.removeEventListener('abort', abort); }
}

/** Two small pages maximum are in flight. Each raw body is decrypted by itself
 * and dropped before the next page; no UI message window is populated. */
export class SessionQuestionBackfill {
    private queued = new Map<string, QuestionBackfillTask>();
    private running = new Map<string, AbortController>();
    private completed = new Map<string, number>();
    private failedUntil = new Map<string, number>();
    private stopped = false;
    constructor(private readonly dependencies: BackfillDependencies) {}

    enqueue(tasks: QuestionBackfillTask[]): void {
        this.stopped = false;
        for (const task of tasks) {
            if (!Number.isSafeInteger(task.seq) || task.seq < 0) continue;
            if ((task.indexedThroughSeq ?? -1) >= task.seq || (this.completed.get(task.id) ?? -1) >= task.seq) continue;
            if ((this.failedUntil.get(task.id) ?? 0) > Date.now()) continue;
            const current = this.queued.get(task.id);
            if (!current || current.seq < task.seq) this.queued.set(task.id, task);
        }
        this.pump();
    }

    stop(): void {
        this.stopped = true;
        this.queued.clear(); this.completed.clear(); this.failedUntil.clear();
        for (const controller of this.running.values()) controller.abort();
    }

    getStats() { return { queued: this.queued.size, running: this.running.size }; }

    private pump(): void {
        if (this.stopped) return;
        for (const [id, task] of this.queued) {
            if (this.running.size >= QUESTION_BACKFILL_CONCURRENCY) break;
            if (this.running.has(id)) continue;
            this.queued.delete(id);
            if ((this.completed.get(id) ?? -1) >= task.seq || (this.failedUntil.get(id) ?? 0) > Date.now()) continue;
            if (!this.dependencies.isCurrent(task)) continue;
            const controller = new AbortController();
            this.running.set(id, controller);
            void this.scan(task, controller.signal).then(() => {
                if (!controller.signal.aborted) this.completed.set(id, task.seq);
            }).catch(error => {
                if (!controller.signal.aborted && error?.name !== 'AbortError') this.failedUntil.set(id, Date.now() + 60_000);
            }).finally(() => { this.running.delete(id); this.pump(); });
        }
    }

    private async scan(task: QuestionBackfillTask, signal: AbortSignal): Promise<void> {
        const check = () => { if (signal.aborted || !this.dependencies.isCurrent(task)) throw new DOMException('Question index changed', 'AbortError'); };
        let before = task.seq + 1;
        let messageId: string | null = null;
        let finished = false;
        while (!finished) {
            check();
            const page = await boundedRequest(requestSignal => this.dependencies.fetchPage(task.id, before, QUESTION_BACKFILL_PAGE_SIZE, requestSignal), signal);
            check();
            const messages = page.messages;
            if (messages.length > QUESTION_BACKFILL_PAGE_SIZE) throw new Error('Question history exceeded its page budget');
            messages.sort((left, right) => right.seq - left.seq);
            let next = before;
            for (const message of messages) {
                if (!Number.isSafeInteger(message.seq) || message.seq <= 0 || message.seq >= before) throw new Error('Invalid question history cursor');
                next = Math.min(next, message.seq);
                if (message.seq <= (task.indexedThroughSeq ?? -1)) { finished = true; break; }
                const raw = await this.dependencies.decrypt(task.id, message);
                check();
                // A failed decrypt must never mark a possibly real question as
                // scanned. Retry later with a working key instead of guessing.
                if (!raw) throw new Error('Question history could not be decrypted');
                if (isUserQuestionRecord(raw)) { messageId = message.id; finished = true; break; }
            }
            if (!page.hasMore) finished = true;
            if (!finished && next >= before) throw new Error('Question history cursor did not advance');
            before = next;
            // Let normal rendering/input proceed between old history pages.
            if (!finished) await new Promise<void>(resolve => setTimeout(resolve, 0));
        }
        check();
        await boundedRequest(requestSignal => this.dependencies.save(task.id, { messageId, scannedThroughSeq: task.seq }, requestSignal), signal);
        check();
    }
}
