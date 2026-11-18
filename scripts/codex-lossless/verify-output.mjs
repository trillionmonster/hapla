/** Isolated actual-provider acceptance. No credentials or model reasoning are recorded. */
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, mkdirSync, openSync, readFileSync, writeSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { resolve } from 'node:path';

const large = process.argv.includes('--large');
const boundary = process.argv.includes('--boundary');
const executable = process.env.HAPLA_CODEX_PATH || resolve('scripts/codex-lossless/codex');
const version = execFileSync(executable, ['--version'], { encoding: 'utf8' }).trim();
const first = boundary ? Buffer.from('A'.repeat(512 * 1024)) : Buffer.from('RELP0_LOSSLESS_FIRST\n');
const last = boundary ? Buffer.from('Z'.repeat(512 * 1024)) : Buffer.from('RELP0_LOSSLESS_LAST\n');
const middle = boundary ? Buffer.from('M') : large ? Buffer.from('0123456789abcdef'.repeat(4096)) : Buffer.from('中文 stderr\n');
const iterations = large ? 160 : 1;
const expectedHash = createHash('sha256').update(first);
for (let i = 0; i < iterations; i++) expectedHash.update(middle);
expectedHash.update(last);
const expected = { bytes: first.length + middle.length * iterations + last.length, sha256: expectedHash.digest('hex') };
const python = boundary
    ? "import os; os.write(1,b'A'*524288+b'M'+b'Z'*524288)"
    : large
    ? "import sys; o=sys.stdout.buffer; o.write(b'RELP0_LOSSLESS_FIRST\\n'); o.flush(); chunk=b'0123456789abcdef'*4096; [o.write(chunk) for _ in range(160)]; o.write(b'RELP0_LOSSLESS_LAST\\n'); o.flush()"
    : "import os,time; os.write(1,b'RELP0_LOSSLESS_FIRST\\n'); time.sleep(.2); os.write(2,'中文 stderr\\n'.encode()); time.sleep(.2); os.write(1,b'RELP0_LOSSLESS_LAST\\n')";
const command = `python3 -c '${python.replaceAll("'", "'\\''")}'`;
const evidenceDirectory = resolve('.runtime/evidence/codex-lossless');
mkdirSync(evidenceDirectory, { recursive: true });
// Run --boundary with tsx so the actual runtime log store participates in this
// native-event regression. The other acceptance modes remain plain Node.js.
const storeErrors = [];
const outputStore = boundary ? new (await import('../../packages/hapla-cli/src/codex/utils/commandOutputStore.ts')).CommandOutputStore(evidenceDirectory, `boundary-${Date.now()}`, (error) => storeErrors.push(String(error))) : null;
const child = spawn(executable, ['app-server', '--listen', 'stdio://'], { stdio: ['pipe', 'pipe', 'pipe'] });
const pending = new Map();
const commands = new Map();
let sequence = 0;
let threadId;
let resolveTurn;
let rejectTurn;
const completed = new Promise((resolve, reject) => { resolveTurn = resolve; rejectTurn = reject; });
void completed.catch(() => {});
const request = (method, params) => new Promise((resolve, reject) => {
    const id = ++sequence;
    pending.set(id, { resolve, reject });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
});
function ensure(itemId) {
    if (!commands.has(itemId)) {
        const logPath = resolve(evidenceDirectory, `${Date.now()}-${large ? 'large' : 'startup'}-${itemId}.log`);
        commands.set(itemId, { itemId, logPath, fd: openSync(logPath, 'wx', 0o600), hash: createHash('sha256'), bytes: 0, deltas: 0, started: false, ended: false, lateDeltas: 0 });
    }
    return commands.get(itemId);
}
const lines = createInterface({ input: child.stdout });
lines.on('line', (line) => {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    if (message.id != null && !message.method) {
        const deferred = pending.get(message.id);
        pending.delete(message.id);
        if (message.error) deferred?.reject(new Error(message.error.message));
        else deferred?.resolve(message.result);
        return;
    }
    if (message.id != null) {
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Unsupported verification request' } }) + '\n');
        return;
    }
    const p = message.params || {};
    if (p.threadId && threadId && p.threadId !== threadId) return;
    if (message.method === 'item/started' && p.item?.type === 'commandExecution') {
        Object.assign(ensure(p.item.id), { started: true, command: p.item.command, processId: p.item.processId });
        outputStore?.begin(p.item.id, { command: p.item.command, cwd: p.item.cwd, turn_id: p.turnId });
    }
    if (message.method === 'item/commandExecution/outputDelta') {
        const item = ensure(p.itemId);
        if (item.ended) item.lateDeltas++;
        const bytes = Buffer.from(p.delta || '');
        outputStore?.append(p.itemId, p.delta || '', { turn_id: p.turnId });
        item.hash.update(bytes);
        let offset = 0;
        while (offset < bytes.length) offset += writeSync(item.fd, bytes, offset, bytes.length - offset);
        item.bytes += bytes.length;
        item.deltas++;
    }
    if (message.method === 'item/completed' && p.item?.type === 'commandExecution') {
        Object.assign(ensure(p.item.id), { ended: true, exitCode: p.item.exitCode, aggregateBytes: Buffer.byteLength(p.item.aggregatedOutput || ''), bytesAtCompletion: ensure(p.item.id).bytes });
        if (outputStore) {
            const completed = outputStore.complete(p.item.id, { output: p.item.aggregatedOutput, exit_code: p.item.exitCode, status: p.item.status });
            const log = readFileSync(resolve(evidenceDirectory, completed.logPath));
            Object.assign(ensure(p.item.id), { runtimeLogBytes: log.length, runtimeLogSha256: createHash('sha256').update(log).digest('hex'), runtimePreviewBytes: Buffer.byteLength(completed.output), runtimeTotalBytes: completed.totalBytes });
        }
    }
    if (message.method === 'turn/completed') resolveTurn(p.turn?.status);
});
child.stderr.resume();
const fail = (error) => {
    for (const deferred of pending.values()) deferred.reject(error);
    pending.clear();
    rejectTurn(error);
};
child.on('error', fail);
child.on('exit', (code) => fail(new Error(`App Server exited (code ${code})`)));
const timeout = setTimeout(() => fail(new Error('No authoritative turn completion within 180 seconds')), 180_000);
try {
    await request('initialize', { clientInfo: { name: 'hapla-lossless-acceptance', title: null, version: '1' }, capabilities: { experimentalApi: true } });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'initialized' }) + '\n');
    const started = await request('thread/start', { cwd: process.cwd(), approvalPolicy: 'never', sandbox: 'danger-full-access', experimentalRawEvents: false, persistExtendedHistory: true });
    threadId = started.thread.id;
    await request('turn/start', {
        threadId, approvalPolicy: 'never', sandboxPolicy: { type: 'dangerFullAccess' },
        input: [{ type: 'text', text: `Run exactly this one command using tools.exec_command inside functions.exec, with max_output_tokens:128 and yield_time_ms:1000. If still running, wait on its returned session until exit. Do not run any extra commands, redirect output, truncate the command, or modify files. Do not print the tool output into the answer; answer only done after command exit. Command:\n${command}` }],
    });
    const turnStatus = await completed;
    const results = [...commands.values()].map(({ fd, hash, ...item }) => ({ ...item, sha256: hash.digest('hex') }));
    const passed = storeErrors.length === 0 && turnStatus === 'completed' && results.length === 1 && results.every((item) => item.started && item.ended && item.exitCode === 0 && item.lateDeltas === 0 && item.bytes === expected.bytes && item.sha256 === expected.sha256 && (!boundary || (item.runtimeLogBytes === expected.bytes && item.runtimeLogSha256 === expected.sha256 && item.aggregateBytes > expected.bytes)));
    console.log(JSON.stringify({ version, executable, mode: boundary ? '1MiB-aggregate-boundary' : large ? '10MiB' : 'startup-and-stderr', threadId, expected, turnStatus, passed, results, ...(storeErrors.length ? { storeErrors } : {}) }, null, 2));
    process.exitCode = passed ? 0 : 2;
} catch (error) {
    console.error(error.message);
    process.exitCode = 1;
} finally {
    clearTimeout(timeout);
    for (const item of commands.values()) closeSync(item.fd);
    outputStore?.dispose();
    lines.close();
    child.stdin.end();
    child.kill('SIGTERM');
}
