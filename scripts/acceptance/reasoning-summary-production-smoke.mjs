#!/usr/bin/env node
/** Public-summary schema replay through real encryption/HTTP/socket/Sync/production UI; no model invocation. */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { existsSync, readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
const require = createRequire(import.meta.url), nacl = require('tweetnacl'), { io } = require('socket.io-client');
const args = Object.fromEntries(process.argv.slice(2).map(arg => { const [key, ...value] = arg.replace(/^--/, '').split('='); return [key, value.join('=') || true]; }));
const api = String(args.api ?? 'http://127.0.0.1:12445'), web = String(args.url ?? 'http://127.0.0.1:12446');
const home = resolve(String(args.home ?? '.runtime/reliability-isolated/a1'));
const output = resolve(String(args.output ?? '.runtime/evidence/reasoning-summary-production.json'));
const credentials = JSON.parse(readFileSync(`${home}/access.key`, 'utf8'));
if (!credentials.secret) throw new Error('This bounded replay requires the isolated legacy-encryption acceptance account');
const key = Buffer.from(credentials.secret, 'base64');
const encrypt = value => { const nonce = randomBytes(24); return Buffer.concat([nonce, nacl.secretbox(Buffer.from(JSON.stringify(value)), nonce, key)]).toString('base64'); };
const auth = JSON.stringify({ token: credentials.token, secret: key.toString('base64url') });
const headers = { Authorization: `Bearer ${credentials.token}`, 'Content-Type': 'application/json' };
async function post(path, body) {
    const response = await fetch(`${api}${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
    if (!response.ok) throw new Error(`Replay API ${response.status} at ${path}`);
    return response.json();
}
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(check, label, timeout = 20000) {
    const end = Date.now() + timeout;
    while (Date.now() < end) { const value = await check(); if (value) return value; await pause(50); }
    throw new Error(`Timed out: ${label}`);
}
mkdirSync(dirname(output), { recursive: true });
const tag = `public-summary-schema-replay-${Date.now()}`;
const created = await post('/v1/sessions', { tag, metadata: encrypt({ name: 'SCHEMA_REPLAY public summary', path: '/isolated-schema-replay/no-model', host: 'acceptance-fixture', flavor: 'codex' }), agentState: encrypt({}), dataEncryptionKey: null });
const sid = created.session.id, turn = `${tag}-turn`, item = `${tag}-item`;
const replay = (id, ev, turnId = turn) => ({ role: 'session', content: { id, time: Date.now(), role: 'agent', turn: turnId, ev }, meta: { sentFrom: 'cli' } });
async function persist(id, content) { return post(`/v3/sessions/${sid}/messages`, { messages: [{ localId: `${tag}:${id}`, content: encrypt(content) }] }); }
await persist('baseline-user', { role: 'user', content: { type: 'text', text: 'SCHEMA_REPLAY: synthetic public-summary protocol events for UI acceptance. No model was invoked.' } });
await persist('baseline-answer', replay('baseline-answer', { t: 'text', text: 'REPLAY_BASELINE_READY: ordinary text without a summary flag.' }, 'baseline'));
const transport = io(api, { path: '/v1/updates', auth: { token: credentials.token, clientType: 'session-scoped', sessionId: sid }, transports: ['websocket'] });
const profile = mkdtempSync(join(tmpdir(), 'hapla-summary-replay-'));
const browser = spawn(process.env.CHROMIUM_PATH ?? 'chromium', ['--headless=new', '--no-sandbox', '--disable-dev-shm-usage', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--window-size=1440,1000', 'about:blank'], { stdio: 'ignore' });
let socket, send, evaluate;
const errors = [], requests = [], screenshots = {}, stages = [];
const partial = '公开摘要回放：正在核对输入与结果。';
const finalText = '公开摘要回放：输入与结果已核对，保留一张完整摘要卡。';
try {
    await new Promise((resolve, reject) => { transport.once('connect', resolve); transport.once('connect_error', reject); });
    const port = await waitFor(() => existsSync(`${profile}/DevToolsActivePort`) && readFileSync(`${profile}/DevToolsActivePort`, 'utf8').split('\n')[0], 'private browser');
    const target = (await fetch(`http://127.0.0.1:${port}/json/list`).then(response => response.json())).find(target => target.type === 'page');
    socket = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
    let sequence = 0; const pending = new Map();
    socket.addEventListener('message', event => {
        const message = JSON.parse(event.data);
        if (message.id) { const item = pending.get(message.id); if (!item) return; clearTimeout(item.timer); pending.delete(message.id); message.error ? item.reject(new Error(message.error.message)) : item.resolve(message.result ?? {}); }
        else if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text);
        else if (message.method === 'Network.requestWillBeSent') { const { request } = message.params; const url = new URL(request.url); if (url.pathname.includes(`/sessions/${sid}/messages`)) requests.push({ path: url.pathname + url.search, method: request.method }); }
    });
    socket.addEventListener('close', () => { for (const item of pending.values()) { clearTimeout(item.timer); item.reject(new Error('Private replay browser closed')); } pending.clear(); });
    send = (method, params = {}) => new Promise((resolve, reject) => { const id = ++sequence; const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 20000); pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params })); });
    evaluate = async expression => { const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text); return result.result.value; };
    await send('Page.enable'); await send('Runtime.enable'); await send('Network.enable');
    await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
    await send('Page.addScriptToEvaluateOnNewDocument', { source: `localStorage.setItem('auth_credentials',${JSON.stringify(auth)});` });
    await send('Page.navigate', { url: `${web}/session/${sid}` });
    await waitFor(() => evaluate(`document.body?.innerText.includes('REPLAY_BASELINE_READY')`), 'decrypted baseline history');
    const inspect = () => evaluate(`(()=>{const cards=[...document.querySelectorAll('[aria-label="推理摘要"]')];const text=document.body?.innerText||'';return {cards:cards.length,updating:cards.some(e=>e.textContent.includes('更新中')),expanded:cards.map(e=>e.getAttribute('aria-expanded')),partialVisible:text.includes(${JSON.stringify(partial)}),finalOccurrences:text.split(${JSON.stringify(finalText)}).length-1}})()`);
    const capture = async name => { const result = await send('Page.captureScreenshot', { format: 'png' }); const path = output.replace(/\.json$/, `-${name}.png`); writeFileSync(path, Buffer.from(result.data, 'base64')); screenshots[name] = path; };
    const stage = async name => { const value = { name, ...await inspect() }; stages.push(value); return value; };
    const baseline = await stage('no-summary'); await capture('no-summary');
    if (baseline.cards !== 0) throw new Error('Ordinary events created an empty summary card');
    await evaluate(`window.__summaryTimeline=[];window.__summaryObserver=new MutationObserver(()=>{const cards=[...document.querySelectorAll('[aria-label="推理摘要"]')];const value={at:Date.now(),cards:cards.length,updating:cards.some(e=>e.textContent.includes('更新中'))};const last=window.__summaryTimeline.at(-1);if(!last||last.cards!==value.cards||last.updating!==value.updating)window.__summaryTimeline.push(value)});window.__summaryObserver.observe(document.body,{childList:true,subtree:true,characterData:true});`);
    const stream = (text, seq) => transport.emit('session-stream', { sid, payload: encrypt({ id: item, turnId: turn, kind: 'reasoning-summary', text, seq, updatedAt: Date.now() }) });
    stream(partial, 1);
    await waitFor(async () => { const state = await inspect(); return state.cards === 1 && state.updating; }, 'public summary streaming card');
    const clickSummary = async () => { const point = await evaluate(`(()=>{const e=document.querySelector('[aria-label="推理摘要"]');e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`); await send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point }); await send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point }); };
    await clickSummary();
    await waitFor(async () => (await inspect()).partialVisible, 'expanded streaming public text');
    await stage('stream-expanded'); await capture('stream-expanded');
    const finalEnvelope = replay(item, { t: 'text', text: finalText, summary: true });
    await persist('summary-final', finalEnvelope);
    await waitFor(async () => { const state = await inspect(); return state.cards === 1 && !state.updating && state.finalOccurrences === 1; }, 'atomic final merge');
    await persist('summary-final', finalEnvelope); // Actual HTTP localId retry must remain idempotent.
    stream(partial, 99); // Late ephemeral snapshot cannot revive a committed item.
    await pause(500);
    const final = await stage('final-after-duplicate-and-late-stream'); await capture('final-expanded');
    if (final.cards !== 1 || final.updating || final.finalOccurrences !== 1) throw new Error('Summary final duplicated or late stream revived it');
    await clickSummary();
    await waitFor(async () => { const state = await inspect(); return state.cards === 1 && state.finalOccurrences === 0; }, 'collapse final summary');
    await stage('final-collapsed'); await capture('final-collapsed');
    await clickSummary();
    await waitFor(async () => (await inspect()).finalOccurrences === 1, 're-expand final summary');
    await stage('final-reexpanded');
    const timeline = await evaluate('window.__summaryTimeline');
    await send('Page.reload');
    await waitFor(async () => (await inspect()).cards === 1, 'durable summary after reload');
    await clickSummary();
    await waitFor(async () => { const state = await inspect(); return state.cards === 1 && !state.updating && state.finalOccurrences === 1; }, 'unique persisted summary after reload');
    await stage('reloaded-final'); await capture('reloaded-final');
    const result = { ok: errors.length === 0 && timeline.every(state => state.cards <= 1), fixture: 'Explicit public-summary schema replay. A new isolated acceptance session was seeded over encrypted real HTTP and session-scoped Socket.IO. The exported production app, decryption, Sync, store, reducer and summary component ran unchanged. No model was invoked.', sessionId: sid, itemId: item, turnId: turn, stages, timeline, screenshots, requests, errors };
    writeFileSync(output, JSON.stringify(result, null, 2));
    console.log(JSON.stringify({ ok: result.ok, sessionId: sid, stages: stages.map(stage => ({ name: stage.name, cards: stage.cards, updating: stage.updating, finalOccurrences: stage.finalOccurrences })), output }));
    if (!result.ok) process.exitCode = 1;
} catch (error) {
    const result = { ok: false, fixture: 'Public-summary schema replay; no model invocation', sessionId: sid, error: String(error), stages, screenshots, requests, errors };
    writeFileSync(output, JSON.stringify(result, null, 2)); console.error(String(error)); process.exitCode = 1;
} finally {
    transport.disconnect();
    // Browser.close lets this private browser finish profile writes before removal.
    if (send && socket?.readyState === WebSocket.OPEN) await send('Browser.close').catch(() => {});
    socket?.close();
    if (browser.exitCode === null && browser.signalCode === null) {
        const exited = new Promise(resolve => browser.once('exit', resolve));
        await Promise.race([exited, pause(3000)]);
        if (browser.exitCode === null && browser.signalCode === null) {
            browser.kill('SIGTERM');
            await Promise.race([exited, pause(3000)]);
        }
    }
    for (let attempt = 0; attempt < 10; attempt++) {
        try { rmSync(profile, { recursive: true, force: true }); break; }
        catch (error) {
            if (!['ENOTEMPTY', 'EBUSY'].includes(error.code) || attempt === 9) throw error;
            await pause(300);
        }
    }
}
