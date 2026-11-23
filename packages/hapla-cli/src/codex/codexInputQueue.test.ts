import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexInputQueue } from './codexInputQueue';

const roots: string[] = [];
afterEach(() => { for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }); });
function queue() { const root = mkdtempSync(join(tmpdir(), 'codex-inputs-')); roots.push(root); const file = join(root, 'queue.json'); return { file, queue: new CodexInputQueue<string>(String, file) }; }

describe('durable Codex follow-up queue', () => {
    it('preserves independent submissions, supports edits/reordering and rejects stale actions', async () => {
        const { queue: q } = queue();
        q.push('first', 'default', 'a'); q.push('second', 'default', 'b');
        q.update('a', 0, 'edited first');
        expect(() => q.remove('a', 0)).toThrow('已开始处理或已被修改');
        expect(() => q.reorder(['a', 'a'])).toThrow('队列已变化');
        q.reorder(['b', 'a']);
        expect((await q.waitForMessagesAndGetAsString())?.message).toBe('second');
        q.acknowledge('b');
        expect((await q.waitForMessagesAndGetAsString())?.message).toBe('edited first');
        q.acknowledge('a');
        q.push('duplicate', 'default', 'a'); expect(q.size()).toBe(0);
    });
    it('recovers in-flight input after a runtime crash without automatically repeating side effects', async () => {
        const { queue: q, file } = queue(); q.push('create file', 'default', 'a');
        await q.waitForMessagesAndGetAsString();
        const recovered = new CodexInputQueue<string>(String, file);
        expect(recovered.snapshot()).toMatchObject({ paused: true, items: [{ id: 'a', message: 'create file' }] });
        const controller = new AbortController(); const waiting = recovered.waitForMessagesAndGetAsString(controller.signal); controller.abort();
        expect(await waiting).toBeNull();
        recovered.start(); expect((await recovered.waitForMessagesAndGetAsString())?.id).toBe('a'); recovered.acknowledge('a');
        expect(new CodexInputQueue<string>(String, file).has('a')).toBe(true);
    });
    it('holds steer submissions until acknowledged and pauses failed delivery for an explicit retry', async () => {
        const { queue: q } = queue();
        q.pushMultimodal([{ type: 'text', text: 'steer' }], 'default', 'a', true);
        const controller = new AbortController(); const waiting = q.waitForMessagesAndGetAsString(controller.signal); controller.abort(); expect(await waiting).toBeNull();
        q.fail('a', 'transport disconnected');
        expect(q.snapshot()).toMatchObject({ paused: true, items: [{ error: 'transport disconnected' }] });
        q.start('a'); expect((await q.waitForMessagesAndGetAsString())?.id).toBe('a');
        q.close(); expect(await q.waitForMessagesAndGetAsString()).toBeNull();
    });
    it('runs a selected direct input without resuming older paused or failed work', async () => {
        const { queue: q } = queue();
        q.push('older side effect', 'default', 'old'); q.fail('old', 'ambiguous delivery');
        q.push('new direct question', 'default', 'direct'); q.start('direct');
        expect((await q.waitForMessagesAndGetAsString())?.id).toBe('direct'); q.acknowledge('direct');
        expect(q.snapshot()).toMatchObject({ paused: true, items: [{ id: 'old', error: 'ambiguous delivery' }] });
        const controller = new AbortController(); const pending = q.waitForMessagesAndGetAsString(controller.signal); controller.abort();
        expect(await pending).toBeNull();
        q.start(); expect((await q.waitForMessagesAndGetAsString())?.id).toBe('old');
    });
    it('revokes single-input execution on pause and does not replay it after a crash', async () => {
        const { queue: q, file } = queue(); q.pause(); q.push('write file', 'default', 'a'); q.start('a');
        const recovered = new CodexInputQueue<string>(String, file);
        const controller = new AbortController(); const pending = recovered.waitForMessagesAndGetAsString(controller.signal); controller.abort(); expect(await pending).toBeNull();
        q.pause(); const second = new AbortController(); const stopped = q.waitForMessagesAndGetAsString(second.signal); second.abort(); expect(await stopped).toBeNull();
        q.start('a'); expect((await q.waitForMessagesAndGetAsString())?.id).toBe('a');
    });
});
