import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { randomBytes, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { io, type Socket } from 'socket.io-client';
import { authGetToken } from '../../packages/hapla-cli/src/api/auth';
import { ApiClient } from '../../packages/hapla-cli/src/api/api';
import { RpcHandlerManager } from '../../packages/hapla-cli/src/api/rpc/RpcHandlerManager';
import { GitWorkbench } from '../../packages/hapla-cli/src/modules/git/workbench';
import { git } from '../../packages/hapla-cli/src/modules/git/gitProcess';

assert(existsSync('/.dockerenv'), 'Run Git loading acceptance inside Docker');
assert.equal(process.env.HAPLA_ACCEPTANCE_STACK, 'dev-hapla');
const api = process.env.HAPLA_SERVER_URL!;
assert.equal(new URL(api).hostname, 'server');
const origin = process.env.HAPLA_ACCEPTANCE_WEB_URL ?? 'http://web:8080';
const output = process.env.HAPLA_ACCEPTANCE_OUTPUT ?? '/repo/artifacts/git-workbench-loading';
mkdirSync(output, { recursive: true });
const profile = process.env.PROFILE ?? 'desktop';
const log = (value: object) => { const line = JSON.stringify(value); appendFileSync(join(output, 'actions.ndjson'), line + '\n'); console.log(line); };
const secret = randomBytes(32), token = await authGetToken(secret);
const client = await ApiClient.create({ token, encryption: { type: 'legacy', secret } });
const root = `/workspace/git-loading-${randomUUID()}`;
mkdirSync(root, { recursive: true });
await git(root, ['init', '-b', 'main']);
await git(root, ['config', 'user.name', 'Hapla acceptance']);
await git(root, ['config', 'user.email', 'acceptance@hapla.test']);
writeFileSync(join(root, 'tracked.txt'), 'original\n');
await git(root, ['add', '.']); await git(root, ['commit', '-m', 'Real fixture history']);
writeFileSync(join(root, 'tracked.txt'), 'changed in actual Git repository\n');
const nonGit = root + '-non-git'; mkdirSync(nonGit);
const machineId = randomUUID();
const machine = await client.getOrCreateMachine({ machineId, metadata: { host: 'git-loading', platform: 'linux', happyCliVersion: 'acceptance', homeDir: '/workspace' } as any });
const sockets: Socket[] = [];
const connect = async (scope: 'machine' | 'session', id: string) => {
    const socket = io(api, { path: '/v1/updates', transports: ['websocket'], auth: { token, clientType: scope + '-scoped', ...(scope === 'machine' ? { machineId: id } : { sessionId: id }), haplaClient: 'cli-coding-acceptance' } });
    sockets.push(socket);
    await new Promise<void>((resolve, reject) => { socket.once('connect', resolve); socket.once('connect_error', reject); });
    return socket;
};
const socket = await connect('machine', machineId);
const manager = new RpcHandlerManager({ scopePrefix: machineId, encryptionKey: machine.encryptionKey, encryptionVariant: machine.encryptionVariant, logger: () => {} });
socket.on('rpc-request', async (data, ack) => ack(await manager.handleRequest(data)));
manager.onSocketConnect(socket);
let mode = 'real';
const calls: string[] = [];
let release: (() => void) | undefined;
let gate: Promise<void> = Promise.resolve();
manager.registerHandler('git-workbench', async (request: any) => {
    const current = mode; calls.push(current + ':' + request.operation);
    if (current === 'unsupported') throw new Error('RPC method not available');
    if (current === 'timeout' || (current === 'slow-status' && request.operation === 'status')) await gate;
    return new GitWorkbench(current === 'non-git' ? nonGit : root, request.sessionId).execute(request);
});
const heartbeat = setInterval(() => {
    socket.emit('machine-alive', { machineId, time: Date.now() });
    for (const value of sockets.slice(1)) value.emit('session-alive', { sid: (value.auth as any).sessionId, time: Date.now(), thinking: false });
}, 1000);
socket.emit('machine-alive', { machineId, time: Date.now() });
const session = await client.getOrCreateSession({ tag: randomUUID(), metadata: { name: 'Git loading acceptance', path: root, host: 'git-loading', homeDir: '/workspace', version: 'acceptance', os: 'linux', flavor: 'codex', machineId } as any, state: null });
assert(session);
// New sessions start active. Archive this fixture so the first cases exercise
// an idle workspace through its machine, then heartbeat it for the legacy case.
assert((await fetch(api + '/v1/sessions/' + session.id + '/archive', { method: 'POST', headers: { authorization: 'Bearer ' + token } })).ok);
const pw = await import(process.env.HAPLA_PLAYWRIGHT_MODULE || '/opt/hapla-browser/node_modules/playwright/index.mjs');
const browser = await pw[profile === 'iphone' ? 'webkit' : 'chromium'].launch({ headless: true, ...(profile === 'iphone' ? {} : { executablePath: process.env.CHROMIUM_PATH, args: ['--no-sandbox'] }) });
const context = await browser.newContext({ ...(profile === 'desktop' ? { viewport: { width: 1440, height: 1000 } } : pw.devices[profile === 'iphone' ? 'iPhone 13' : 'Pixel 7']), locale: 'en-US', recordVideo: { dir: join(output, 'video') } });
await context.addInitScript(({ token, secret }) => localStorage.setItem('auth_credentials', JSON.stringify({ token, secret })), { token, secret: secret.toString('base64url') });
const page = await context.newPage(); page.setDefaultTimeout(45_000);
const errors: string[] = [], results: string[] = [];
let sessionReads = 0;
page.on('websocket', value => value.on('framesent', frame => {
    if (typeof frame.payload === 'string' && frame.payload.includes(session.id + ':git-workbench')) sessionReads++;
}));
page.on('pageerror', error => errors.push(error.message));
const click = (target: any) => profile === 'desktop' ? target.click() : target.tap();
const open = async () => { await page.goto(origin + '/session/' + session.id + '/git'); await page.locator('.hapla-git').waitFor(); };
const tab = (name: string) => click(page.locator('.hapla-git-source').getByRole('button', { name, exact: true }));
const settled = async () => { await page.locator('.hapla-git-branch').getByText('main', { exact: true }).waitFor(); await page.getByText('changed in actual Git repository', { exact: false }).first().waitFor(); };
const passed = async (name: string) => { results.push(name); log({ name, passed: true }); await page.screenshot({ path: join(output, name + '.png'), scale: 'css' }); };
try {
    log({ name: 'start-real-repository' }); await open(); log({ name: 'page-open' }); await settled();
    assert((await page.locator('.hapla-git-workspace').innerText()).includes(root));
    await tab('Commit'); await page.getByRole('option', { name: /Real fixture history/ }).waitFor({ state: 'attached' });
    await passed('real-repository-and-history');

    mode = 'unsupported'; await open();
    await page.getByRole('alert').getByText(/Update Hapla CLI/).waitFor();
    assert.equal(await page.locator('.hapla-git-diff-skeleton').count(), 0);
    assert.equal(await page.getByRole('button', { name: 'Push branch', exact: true }).isDisabled(), true);
    await page.getByRole('textbox', { name: 'Commit message', exact: true }).fill('Keep my draft through retry');
    for (const name of ['Staged', 'Against base', 'Commit', 'Turn']) {
        await tab(name);
        assert.match(await page.getByRole('alert').innerText(), /Update Hapla CLI/);
        assert.equal(await page.locator('.hapla-git-diff-skeleton').count(), 0);
    }
    assert.match(await page.locator('.hapla-git-checkpoints').innerText(), /Not loaded/);
    await passed('unsupported-persists-across-tabs');
    mode = 'real'; await click(page.getByRole('button', { name: 'Retry', exact: true }));
    await page.locator('.hapla-git-branch').getByText('main', { exact: true }).waitFor();
    assert.equal(await page.getByRole('textbox', { name: 'Commit message', exact: true }).inputValue(), 'Keep my draft through retry');
    await tab('Unstaged + new files'); await settled();
    await passed('retry-real-data-preserves-draft');

    mode = 'non-git'; await open();
    await page.getByRole('alert').getByText(/not a Git repository/).waitFor();
    assert.equal(await page.locator('.hapla-git-diff-skeleton').count(), 0);
    assert.equal(await page.getByRole('button', { name: 'Push branch', exact: true }).isDisabled(), true);
    await passed('non-repository-is-an-error');

    mode = 'slow-status'; gate = new Promise(resolve => { release = resolve; }); await open();
    await tab('Commit'); await page.getByRole('option', { name: /Real fixture history/ }).waitFor({ state: 'attached' });
    assert.equal(await page.locator('.hapla-git-branch').getByText('main', { exact: true }).count(), 0);
    await passed('history-loads-while-status-waits');
    release!(); await page.locator('.hapla-git-branch').getByText('main', { exact: true }).waitFor();

    mode = 'timeout'; gate = new Promise(resolve => { release = resolve; }); await open();
    await page.getByRole('alert').getByText(/Git request timed out/).waitFor();
    assert.equal(await page.locator('.hapla-git-diff-skeleton').count(), 0);
    assert.equal(await page.getByRole('button', { name: 'Push branch', exact: true }).isDisabled(), true);
    await passed('real-read-timeout-stops-skeleton');
    mode = 'real'; release!(); gate = Promise.resolve();

    // An old live session has no Git registration; a new daemon serves the
    // same owned repository without restarting that active conversation.
    const legacy = await connect('session', session.id);
    legacy.emit('session-alive', { sid: session.id, time: Date.now(), thinking: false });
    // Heartbeats persist through a batched activity cache. Wait for the API's
    // active flag before reloading, so the browser cannot race through the
    // inactive-machine route and accidentally skip the compatibility path.
    let active = false;
    const deadline = Date.now() + 20_000;
    do {
        const response = await fetch(api + '/v1/sessions', { headers: { authorization: 'Bearer ' + token } });
        const data = await response.json();
        active = data.sessions.some((value: any) => value.id === session.id && value.active === true);
        if (!active) await new Promise(resolve => setTimeout(resolve, 500));
    } while (!active && Date.now() < deadline);
    assert(active, 'Legacy session heartbeat is persisted before opening the browser');
    const before = calls.length, beforeReads = sessionReads; await open(); await settled();
    assert(sessionReads > beforeReads, 'Browser first attempts the live legacy session route');
    assert(calls.slice(before).includes('real:status'), 'Legacy live session falls back to daemon');
    await passed('legacy-live-session-daemon-fallback');

    await tab('Turn');
    await page.getByText(/This conversation is still running an older worker process/).first().waitFor();
    assert(await page.getByRole('button', { name: 'Save checkpoint', exact: true }).isDisabled());
    assert.equal(await page.getByText('Checkpoints appear after your next Codex turn.', { exact: true }).count(), 0);
    await passed('legacy-session-explains-missing-turn-capture');

    await git(root, ['add', '.']); await git(root, ['commit', '-m', 'Saved fixture changes']);
    const savedHead = (await git(root, ['rev-parse', 'HEAD'])).trim();
    await open();
    await page.getByText('No uncommitted changes', { exact: true }).waitFor();
    await click(page.getByRole('button', { name: 'View latest commit', exact: true }));
    await settled();
    assert.equal(await page.getByRole('combobox', { name: 'Commit', exact: true }).inputValue(), savedHead);
    await passed('clean-worktree-opens-actual-latest-commit');

    legacy.disconnect();
    assert((await fetch(api + '/v1/sessions/' + session.id + '/archive', { method: 'POST', headers: { authorization: 'Bearer ' + token } })).ok);
    const continued = await client.getOrCreateSession({ tag: randomUUID(), conversationId: session.conversationId, metadata: { ...session.metadata, conversationRootSessionId: session.id }, state: null });
    assert(continued);
    const current = await connect('session', continued.id);
    const currentManager = new RpcHandlerManager({ scopePrefix: continued.id, encryptionKey: continued.encryptionKey, encryptionVariant: continued.encryptionVariant, logger: () => {} });
    current.on('rpc-request', async (data, ack) => ack(await currentManager.handleRequest(data)));
    currentManager.onSocketConnect(current);
    currentManager.registerHandler('git-workbench', request => new GitWorkbench(root, session.id).execute(request));
    current.emit('session-alive', { sid: continued.id, time: Date.now(), thinking: false });
    let continuedReads = 0;
    page.on('websocket', value => value.on('framesent', frame => {
        if (typeof frame.payload === 'string' && frame.payload.includes(continued.id + ':git-workbench')) continuedReads++;
    }));
    await open(); await tab('Turn');
    await page.getByText('Checkpoints appear after your next Codex turn.', { exact: true }).waitFor();
    assert(await page.getByRole('button', { name: 'Save checkpoint', exact: true }).isEnabled());
    assert(continuedReads > 0, 'Original URL sends Git requests to the continued runtime');
    assert.equal(new URL(page.url()).pathname, '/session/' + session.id + '/git');
    await passed('original-url-uses-continued-runtime');
    assert.deepEqual(errors, []);
    writeFileSync(join(output, 'result.json'), JSON.stringify({ profile, passed: true, results, errors }, null, 2));
} catch (error) {
    log({ passed: false, error: String(error), url: page.url(), alerts: await page.getByRole('alert').allTextContents(), calls, pageErrors: errors });
    await page.screenshot({ path: join(output, 'failure.png'), scale: 'css' });
    throw error;
} finally {
    release?.(); clearInterval(heartbeat); sockets.forEach(value => value.disconnect());
    await context.close(); await browser.close();
}
