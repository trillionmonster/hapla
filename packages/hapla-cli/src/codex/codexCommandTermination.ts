import type { ThreadBackgroundTerminal, ThreadBackgroundTerminalsListResponse, ThreadBackgroundTerminalsTerminateResponse } from './codexAppServerTypes';

type NativeCommand = {
    threadId: string;
    turnId: string;
    itemId: string;
    processId: string | null;
    observedInList: boolean;
    observedOutput: boolean;
    approval: 'pending' | 'granted' | 'rejected' | null;
    command?: string;
    cwd?: string;
};

type Transport = {
    request<T>(method: string, params: unknown, timeoutMs: number): Promise<T>;
    assertCurrent(): void;
};

/** Tracks only native items correlated by the provider to this exact thread and turn. */
export class CodexCommandTermination {
    private readonly commands = new Map<string, NativeCommand>();

    private key(threadId: string, turnId: string, itemId: string): string {
        return JSON.stringify([threadId, turnId, itemId]);
    }

    observe(threadId: string, turnId: string, item: any, completed: boolean): void {
        if (item?.type !== 'commandExecution' || typeof item.id !== 'string') return;
        const key = this.key(threadId, turnId, item.id);
        if (completed || ['completed', 'failed', 'declined'].includes(item.status)) {
            this.commands.delete(key);
            return;
        }
        const current = this.commands.get(key);
        this.commands.set(key, {
            threadId, turnId, itemId: item.id,
            processId: typeof item.processId === 'string' ? item.processId : current?.processId ?? null,
            observedInList: current?.observedInList ?? false,
            observedOutput: current?.observedOutput ?? false,
            approval: current?.approval ?? null,
            command: typeof item.command === 'string' ? item.command : current?.command,
            cwd: typeof item.cwd === 'string' ? item.cwd : current?.cwd,
        });
    }

    observeApproval(threadId: string, turnId: string, itemId: string, decision: 'pending' | 'granted' | 'rejected'): void {
        const command = this.commands.get(this.key(threadId, turnId, itemId));
        // Once permission was granted, a later approval cannot prove the process
        // never started (for example an additional network approval).
        if (command && command.approval !== 'granted') command.approval = decision;
    }

    observeOutput(threadId: string, turnId: string, itemId: string): void {
        const command = this.commands.get(this.key(threadId, turnId, itemId));
        if (command) command.observedOutput = true;
    }

    /** Only call after this exact turn has an authoritative interrupted terminal. */
    takeUnstartedApprovals(threadId: string, turnId: string): NativeCommand[] {
        const unstarted = this.pending(threadId, turnId).filter(command =>
            (command.approval === 'pending' || command.approval === 'rejected')
            && command.processId === null && !command.observedInList && !command.observedOutput);
        for (const command of unstarted) this.commands.delete(this.key(threadId, turnId, command.itemId));
        return unstarted;
    }

    pending(threadId: string, turnId: string): NativeCommand[] {
        return [...this.commands.values()].filter((command) => command.threadId === threadId && command.turnId === turnId);
    }

    clear(): void { this.commands.clear(); }

    /** Establish presence before interruption so disappearance is evidence, not an assumption. */
    async capture(threadId: string, turnId: string, transport: Transport, timeoutMs = 2_000): Promise<ThreadBackgroundTerminal[]> {
        if (!this.pending(threadId, turnId).length) return [];
        const terminals: ThreadBackgroundTerminal[] = [];
        const cursors = new Set<string>();
        let cursor: string | null = null;
        const deadline = Date.now() + timeoutMs;
        do {
            transport.assertCurrent();
            const remaining = deadline - Date.now();
            if (remaining <= 0) throw new Error('Timed out reading Codex background terminals');
            const page: ThreadBackgroundTerminalsListResponse = await transport.request('thread/backgroundTerminals/list', {
                threadId, cursor, limit: 100,
            }, remaining);
            transport.assertCurrent();
            if (!Array.isArray(page.data)) throw new Error('Invalid Codex background terminal list');
            terminals.push(...page.data);
            cursor = page.nextCursor ?? null;
            if (cursor) {
                if (cursors.has(cursor)) throw new Error('Repeated Codex background terminal cursor');
                cursors.add(cursor);
            }
        } while (cursor);

        for (const command of this.pending(threadId, turnId)) {
            const matched = terminals.find((terminal) => terminal.itemId === command.itemId
                && (!command.processId || terminal.processId === command.processId));
            if (matched) {
                command.processId ??= matched.processId;
                command.observedInList = true;
            } else if (command.observedInList) {
                this.commands.delete(this.key(threadId, turnId, command.itemId));
            }
        }
        return terminals;
    }

    async terminate(threadId: string, turnId: string, transport: Transport, timeoutMs: number): Promise<void> {
        const deadline = Date.now() + Math.max(1, timeoutMs);
        const requested = new Set<string>();
        while (this.pending(threadId, turnId).length) {
            transport.assertCurrent();
            const remaining = deadline - Date.now();
            if (remaining <= 0) throw new Error('Codex command termination is not confirmed; retry interruption');
            const terminals = await this.capture(threadId, turnId, transport, Math.min(2_000, remaining));
            for (const command of this.pending(threadId, turnId)) {
                const matched = terminals.find((terminal) => terminal.itemId === command.itemId && terminal.processId === command.processId);
                if (!matched || requested.has(command.itemId)) continue;
                transport.assertCurrent();
                // This native method is scoped to the owning thread; never substitute an OS PID.
                await transport.request<ThreadBackgroundTerminalsTerminateResponse>('thread/backgroundTerminals/terminate', {
                    threadId, processId: matched.processId,
                }, Math.max(1, Math.min(2_000, deadline - Date.now())));
                transport.assertCurrent();
                requested.add(command.itemId);
                // `terminated:true` is an acknowledgement. A later item terminal or
                // complete list disappearance must confirm that this process is gone.
            }
            if (this.pending(threadId, turnId).length) await new Promise((resolve) => setTimeout(resolve, 50));
        }
    }
}
