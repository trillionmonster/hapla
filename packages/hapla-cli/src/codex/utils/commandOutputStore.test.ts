import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CommandOutputStore, COMMAND_LIVE_OUTPUT_BYTES, COMMAND_PREVIEW_OUTPUT_BYTES } from './commandOutputStore';
import { mapCodexMcpMessageToSessionEnvelopes } from './sessionProtocolMapper';

const temporaryDirectories: string[] = [];
afterEach(() => { for (const path of temporaryDirectories.splice(0)) rmSync(path, { recursive: true, force: true }); });

function fixture() {
    const root = mkdtempSync(join(tmpdir(), 'hapla-command-output-'));
    temporaryDirectories.push(root);
    const onError = vi.fn();
    return { root, onError, store: new CommandOutputStore(root, 'session-a', onError) };
}

describe('CommandOutputStore', () => {
    it('bounds 10 MiB output in memory while keeping a complete downloadable log', () => {
        const { store, root, onError } = fixture();
        store.begin('command-a', { command: 'build', cwd: root });
        const chunk = '中文 stdout stderr\n'.repeat(50_000);
        let expected = '';
        for (let i = 0; i < 12; i++) {
            expected += chunk;
            const live = store.append('command-a', chunk);
            expect(Buffer.byteLength(live.output)).toBeLessThanOrEqual(COMMAND_LIVE_OUTPUT_BYTES);
            expect(live.output).not.toContain('\ufffd');
        }
        expect(Buffer.byteLength(expected)).toBeGreaterThan(10 * 1024 * 1024);
        const result = store.complete('command-a', { exit_code: 0, status: 'completed', duration_ms: 1234 });
        expect(Buffer.byteLength(result.output as string)).toBeLessThanOrEqual(COMMAND_PREVIEW_OUTPUT_BYTES);
        expect(result).toMatchObject({ command: 'build', cwd: root, truncated: true, totalBytes: Buffer.byteLength(expected) });
        expect(readFileSync(join(root, result.logPath as string), 'utf8')).toBe(expected);
        expect(onError).not.toHaveBeenCalled();
    });

    it('uses authoritative completed output without duplicating streamed chunks', () => {
        const { store, root } = fixture();
        store.begin('command-a');
        store.append('command-a', 'first\n');
        const result = store.complete('command-a', { output: 'first\nlast\n', exit_code: 1 });
        expect(result.output).toBe('first\nlast\n');
        expect(readFileSync(join(root, result.logPath as string), 'utf8')).toBe('first\nlast\n');
        expect(result.totalBytes).toBe(11);
    });

    it('preserves streamed output when the final aggregate is absent or provider-truncated', () => {
        const { store, root } = fixture();
        store.append('command-a', 'full output\n');
        const result = store.complete('command-a', { output: 'output\n', status: 'completed' });
        expect(result.output).toBe('full output\n');
        expect(readFileSync(join(root, result.logPath as string), 'utf8')).toBe('full output\n');
    });

    it('never overwrites a complete stream with a longer head/tail truncation near the provider cap', () => {
        const { store, root } = fixture();
        const full = 'A'.repeat(COMMAND_LIVE_OUTPUT_BYTES / 2) + 'M' + 'Z'.repeat(COMMAND_LIVE_OUTPUT_BYTES / 2);
        const truncated = 'A'.repeat(COMMAND_LIVE_OUTPUT_BYTES / 2) + '\n... 1 bytes omitted ...\n' + 'Z'.repeat(COMMAND_LIVE_OUTPUT_BYTES / 2);
        expect(truncated.length).toBeGreaterThan(full.length);
        store.append('command-a', full);
        const result = store.complete('command-a', { output: truncated, status: 'completed' });
        expect(result.totalBytes).toBe(full.length);
        expect(readFileSync(join(root, result.logPath as string), 'utf8')).toBe(full);
    });

    it('verifies all received bytes after completed-cache tail reduction before adopting a larger aggregate', () => {
        const { store, root } = fixture();
        const full = 'A'.repeat(200_000) + 'Z'.repeat(200_000);
        store.append('command-a', full, { turn_id: 'turn-a' });
        const [interrupted] = store.finishTurn('turn-a', 'interrupted');
        const changedPrefix = 'B'.repeat(200_000) + 'Z'.repeat(200_000) + 'extra';
        const rejected = store.complete('command-a', { output: changedPrefix, status: 'completed' });
        expect(rejected.logPath).toBe(interrupted.logPath);
        expect(readFileSync(join(root, rejected.logPath as string), 'utf8')).toBe(full);
        const extended = store.complete('command-a', { output: 'missing-prefix\n' + full, status: 'completed' });
        expect(readFileSync(join(root, extended.logPath as string), 'utf8')).toBe('missing-prefix\n' + full);
    });

    it('removes terminal control sequences from previews while retaining original bytes in logs', () => {
        const { store, root } = fixture();
        const raw = '\x1b[31m红色\x1b[0m\x00\x1b]0;dangerous title\x07\n' + 'x'.repeat(20_000);
        store.append('command-a', raw);
        const result = store.complete('command-a', { output: raw });
        expect(result.output).not.toContain('\x1b');
        expect(result.output).not.toContain('\x00');
        expect(result.output).not.toContain('dangerous title');
        expect((result.output as string).split('\n').every((line) => line.length <= 16_384)).toBe(true);
        expect(readFileSync(join(root, result.logPath as string), 'utf8')).toBe(raw);
    });

    it('records an empty log for successful commands with no output', () => {
        const { store, root } = fixture();
        const result = store.complete('command-a', { command: 'true', output: '', exit_code: 0 });
        expect(result).toMatchObject({ output: '', truncated: false, totalBytes: 0 });
        expect(readFileSync(join(root, result.logPath as string), 'utf8')).toBe('');
    });

    it('finishes only the interrupted turn and preserves received output without fabricating an exit code', () => {
        const { store, root } = fixture();
        store.begin('command-a', { command: 'sleep 60', cwd: root, protocol: { turnId: 'turn-a' } });
        store.begin('command-b', { command: 'other', turn_id: 'turn-b' });
        store.append('command-a', 'received before interrupt\n');
        store.append('command-b', 'other turn output\n');
        expect(store.finishTurn('old-turn', 'interrupted')).toEqual([]);

        const [ended] = store.finishTurn('turn-a', 'interrupted');
        expect(ended).toMatchObject({
            type: 'exec_command_end', call_id: 'command-a', turn_id: 'turn-a', status: 'interrupted',
            command: 'sleep 60', cwd: root, output: 'received before interrupt\n',
        });
        expect(ended).not.toHaveProperty('exit_code');
        expect(readFileSync(join(root, ended.logPath as string), 'utf8')).toBe('received before interrupt\n');
        expect(store.finishTurn('turn-a', 'interrupted')).toEqual([]);
        const mapped = mapCodexMcpMessageToSessionEnvelopes(ended, { currentTurnId: 'turn-a' });
        expect(mapped.envelopes[0]).toMatchObject({
            turn: 'turn-a', ev: { t: 'tool-call-end', call: 'command-a', isError: true, result: { status: 'interrupted', exitCode: null, durationMs: null, completedByTurn: true } },
        });
        const [other] = store.finishTurn('turn-b', 'failed');
        expect(other).toMatchObject({ call_id: 'command-b', status: 'failed', output: 'other turn output\n' });
    });

    it('bounds interrupted previews and adopts a turn supplied with an early output delta', () => {
        const { store, root } = fixture();
        const received = 'large output\n'.repeat(100_000);
        store.append('command-a', received, { turn_id: 'turn-a' });
        store.begin('command-a', { command: 'build', cwd: root, turn_id: 'turn-a' });
        const [ended] = store.finishTurn('turn-a', 'failed');
        expect(ended).toMatchObject({ command: 'build', cwd: root, status: 'failed', truncated: true });
        expect(Buffer.byteLength(ended.output as string)).toBeLessThanOrEqual(COMMAND_PREVIEW_OUTPUT_BYTES);
        expect(readFileSync(join(root, ended.logPath as string), 'utf8')).toBe(received);
        expect(store.finishTurn('turn-a', 'failed')).toEqual([]);
    });

    it('marks termination confirmed only for explicitly verified commands of the finished turn', () => {
        const { store } = fixture();
        store.begin('verified', { turn_id: 'turn-a' });
        store.begin('unverified', { turn_id: 'turn-a' });
        store.begin('other-turn', { turn_id: 'turn-b' });
        const ended = store.finishTurn('turn-a', 'interrupted', new Set(['verified', 'other-turn']));
        expect(ended).toHaveLength(2);
        const verified = ended.find((item) => item.call_id === 'verified')!;
        const unverified = ended.find((item) => item.call_id === 'unverified')!;
        expect(verified.commandTerminationConfirmed).toBe(true);
        expect(unverified).not.toHaveProperty('commandTerminationConfirmed');
        expect(verified).not.toHaveProperty('exit_code');
        expect(mapCodexMcpMessageToSessionEnvelopes(verified, { currentTurnId: 'turn-a' }).envelopes[0]).toMatchObject({
            ev: { result: { commandTerminationConfirmed: true, completedByTurn: true, exitCode: null } },
        });
        expect(store.getContext('other-turn')?.turnId).toBe('turn-b');
    });

    it('reconciles a real completion after turn interruption without losing the log or reopening the command', () => {
        const { store, root, onError } = fixture();
        store.begin('command-a', { command: 'build', branchId: 'branch-a', protocol: { turnId: 'turn-a', threadId: 'thread-a', epoch: 'epoch-a' } });
        store.append('command-a', 'first\n');
        const [interrupted] = store.finishTurn('turn-a', 'interrupted');
        const actual = store.complete('command-a', { type: 'exec_command_end', call_id: 'command-a', output: 'first\nlast\n', exit_code: 130, status: 'failed' });
        expect(actual).toMatchObject({ logPath: interrupted.logPath, output: 'first\nlast\n', exit_code: 130, completedByTurn: false, branchId: 'branch-a', turn_id: 'turn-a' });
        expect(store.getContext('command-a')).toEqual({ turnId: 'turn-a', threadId: 'thread-a', epoch: 'epoch-a', branchId: 'branch-a' });
        expect(readFileSync(join(root, actual.logPath as string), 'utf8')).toBe('first\nlast\n');
        const mapped = mapCodexMcpMessageToSessionEnvelopes(actual, { currentTurnId: 'turn-b' });
        expect(mapped.currentTurnId).toBe('turn-b');
        expect(mapped.envelopes[0]).toMatchObject({ turn: 'turn-a', ev: { result: { exitCode: 130, output: 'first\nlast\n' } } });
        expect((mapped.envelopes[0].ev as { result: object }).result).not.toHaveProperty('completedByTurn');
        expect(store.finishTurn('turn-a', 'interrupted')).toEqual([]);
        expect(onError).not.toHaveBeenCalled();
    });

    it('preserves a confirmed canceled approval and clears its inference on a later actual completion', () => {
        const { store, root } = fixture();
        store.begin('approval', { command: 'echo approved', turn_id: 'turn-a' });
        const canceled = store.complete('approval', {
            type: 'exec_command_end', call_id: 'approval', status: 'interrupted',
            exit_code: null, completedByTurn: true, commandNotStarted: true,
        });
        expect(mapCodexMcpMessageToSessionEnvelopes(canceled, { currentTurnId: 'turn-a' }).envelopes[0]).toMatchObject({
            ev: { isError: true, result: { commandNotStarted: true, completedByTurn: true, exitCode: null } },
        });
        const actual = store.complete('approval', {
            type: 'exec_command_end', call_id: 'approval', status: 'completed', output: 'approved\n', exit_code: 0,
        });
        expect(actual).toMatchObject({ commandNotStarted: false, completedByTurn: false, logPath: canceled.logPath });
        const result = (mapCodexMcpMessageToSessionEnvelopes(actual, { currentTurnId: 'turn-b' }).envelopes[0].ev as { result: object }).result;
        expect(result).not.toHaveProperty('commandNotStarted');
        expect(result).not.toHaveProperty('completedByTurn');
        expect(readFileSync(join(root, actual.logPath as string), 'utf8')).toBe('approved\n');
    });

    it('keeps received output when a late real completion has no aggregate', () => {
        const { store, root, onError } = fixture();
        store.begin('command-a', { turn_id: 'turn-a' });
        store.append('command-a', 'received\n');
        const [interrupted] = store.finishTurn('turn-a', 'interrupted');
        store.append('command-a', 'late delta ignored\n');
        const actual = store.complete('command-a', { status: 'failed', exit_code: 130, output: '' });
        expect(actual).toMatchObject({ output: 'received\n', logPath: interrupted.logPath, completedByTurn: false });
        expect(readFileSync(join(root, actual.logPath as string), 'utf8')).toBe('received\n');
        expect(onError).not.toHaveBeenCalled();
    });

    it('bounds finalized command retention by both byte budget and item count', () => {
        const { root, onError } = fixture();
        const store = new CommandOutputStore(root, 'bounded-cache', onError, { bytes: 1536, count: 2 });
        for (const id of ['a', 'b', 'c']) {
            store.begin(id, { turn_id: 'turn-a' });
            store.complete(id, { output: 'small\n', status: 'completed' });
        }
        expect(store.getContext('a')).toBeNull();
        expect(store.getContext('b')).not.toBeNull();
        expect(store.getContext('c')).not.toBeNull();
        store.complete('large', { output: 'x'.repeat(2048), status: 'completed' });
        expect(store.getContext('large')).toBeNull();
        store.dispose();
        expect(store.getContext('c')).toBeNull();
    });
});
