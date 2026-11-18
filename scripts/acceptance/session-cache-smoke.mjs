#!/usr/bin/env node
/** Chromium isolation test. The actual frontend sync/store/reducer run against synthetic lazy HTTP history. */
import { build } from 'esbuild';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const output = process.argv.find((arg) => arg.startsWith('--output='))?.slice(9) ?? join(root, '.runtime/evidence/session-cache-50-fixture.json');
const browserPath = process.env.CHROMIUM_PATH ?? 'chromium';
const temporary = mkdtempSync(join(tmpdir(), 'hapla-session-cache-'));
const sources = join(root, 'packages/hapla-web/sources');
const noop = '() => {}';
const mocks = new Map([
    ['expo-constants', 'export default {};'],
    ['expo-crypto', 'export const getRandomBytes = (size) => crypto.getRandomValues(new Uint8Array(size));'],
    ['react-native', `export const Platform={OS:'web'}; export const AppState={currentState:'active',addEventListener:()=>({remove(){}})};`],
    [join(sources, 'sync/apiSocket'), `export const apiSocket={request:(path,init)=>fetch(path,init).catch(error=>{if(error.name==='AbortError')globalThis.fixtureRequestAborts=(globalThis.fixtureRequestAborts||0)+1;throw error}),onMessage:${noop},onReconnected:${noop}}; export const getHaplaClientId=()=> 'fixture';`],
    [join(sources, 'sync/encryption/encryption'), 'export class Encryption {}'],
    [join(sources, 'sync/encryption/artifactEncryption'), 'export class ArtifactEncryption {}'],
    [join(sources, 'sync/notifications'), 'export const scheduleNotificationAsync=async()=>null; export const cancelScheduledNotificationAsync=async()=>{}; export const SchedulableTriggerInputTypes={};'],
    [join(sources, 'sync/gitStatusSync'), `export const gitStatusSync={stop:${noop},start:${noop},invalidate:${noop}};`],
    [join(sources, 'sync/projectManager'), `export const projectManager={updateSessions:${noop},updateProjectGitStatusForSession:${noop}};`],
    [join(sources, 'sync/serverConfig'), "export const getServerUrl=()=>location.origin;"],
    [join(sources, 'utils/platform'), 'export const isRunningOnMac=()=>false;'],
    [join(sources, 'components/tools/knownTools'), 'export const isMutableTool=()=>false;'],
    [join(sources, 'utils/sessionUtils'), "export const getSessionName=s=>s.id; export const getSessionSubtitle=()=>'';export const getSessionAvatarId=()=> 'fixture';"],
    [join(sources, 'config'), 'export const config={};'],
    [join(sources, 'log'), `export const log={log:${noop}};`],
    [join(sources, 'sync/apiArtifacts'), 'export const fetchArtifact=async()=>null,fetchArtifacts=async()=>[],createArtifact=async()=>null,updateArtifact=async()=>null;'],
    [join(sources, 'sync/apiUploads'), 'export const uploadChatImages=async()=>[];'],
    [join(sources, 'sync/persistence'), `export const loadSettings=()=>({settings:{},version:0}),loadLocalSettings=()=>({}),loadProfile=()=>({}),loadSessionDrafts=()=>({}),loadSessionPermissionModes=()=>({}),loadSessionModelModes=()=>({}),loadSessionEffortLevels=()=>({}),loadPendingSettings=()=>({}); export const saveSettings=${noop},saveLocalSettings=${noop},saveProfile=${noop},saveSessionDrafts=${noop},saveSessionPermissionModes=${noop},saveSessionModelModes=${noop},saveSessionEffortLevels=${noop},savePendingSettings=${noop};`],
]);
let browser, socket, server;
const requests = [];
try {
    await build({
        entryPoints: [join(root, 'scripts/acceptance/fixtures/session-cache.ts')], outfile: join(temporary, 'fixture.js'), bundle: true,
        platform: 'browser', format: 'iife', target: 'chrome120', define: { 'process.env.NODE_ENV': '"production"', __DEV__: 'false' },
        tsconfig: join(root, 'packages/hapla-web/tsconfig.json'),
        plugins: [{ name: 'isolated-platform-services', setup(plugin) {
            plugin.onResolve({ filter: /.*/ }, (args) => {
                const name = args.path.startsWith('@/') ? join(sources, args.path.slice(2))
                    : args.path.startsWith('.') ? resolve(args.resolveDir, args.path) : args.path;
                if (mocks.has(name)) return { path: name, namespace: 'fixture-mock' };
            });
            plugin.onLoad({ filter: /.*/, namespace: 'fixture-mock' }, (args) => ({ contents: mocks.get(args.path), loader: 'js' }));
        } }],
    });
    server = createServer((request, response) => {
        const url = new URL(request.url, 'http://fixture');
        if (url.pathname.endsWith('/messages')) {
            const id = url.pathname.split('/')[3];
            const limit = Math.min(100, Number(url.searchParams.get('limit')));
            const after = url.searchParams.has('after_seq') ? Number(url.searchParams.get('after_seq')) : undefined;
            const before = Math.min(100001, Number(url.searchParams.get('before_seq') ?? 100001));
            const start = after === undefined ? Math.max(1, before - limit) : after + 1;
            const end = after === undefined ? before - 1 : Math.min(100000, after + limit);
            const messages = Array.from({ length: Math.max(0, end - start + 1) }, (_, index) => {
                const seq = start + index;
                return { id: `${id}:${seq}`, seq, localId: null, createdAt: seq, updatedAt: seq,
                    content: { role: 'user', content: { type: 'text', text: `${id}/${seq} ` + `${seq.toString(36)}.`.repeat(2000) } } };
            });
            requests.push({ path: request.url, sessionId: id, direction: after === undefined ? 'backward' : 'forward', count: messages.length, firstSeq: start, lastSeq: end });
            response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
            const finish = () => response.end(JSON.stringify({ messages, hasMore: after === undefined ? start > 1 : end < 100000 }));
            if (id === 'fixture-abort') setTimeout(finish, 200); else finish();
            return;
        }
        if (url.pathname === '/fixture.js') { response.writeHead(200, { 'Content-Type': 'text/javascript' }); response.end(readFileSync(join(temporary, 'fixture.js'))); return; }
        response.writeHead(200, { 'Content-Type': 'text/html' });
        response.end(`<!doctype html><meta charset="utf-8"><title>Session cache fixture</title><style>body{font:16px system-ui;background:#f4f4f5;color:#171719;margin:32px}button{padding:12px;margin-right:12px}p{padding:10px;background:white;max-width:850px}small{display:block;max-width:850px;margin:16px 0;color:#555}</style><h1>50 session cache lifecycle fixture</h1><small>Actual Sync, store, reducer, history planner and resource registry. Synthetic lazy HTTP history and decryption adapter; 12-row fixture renderer. This does not measure the production ChatList DOM.</small><button id="next">Next session</button><button id="leave">Leave session</button><p id="status"></p><section id="rows"></section><script src="/fixture.js"></script>`);
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    browser = spawn(browserPath, ['--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--remote-debugging-port=0', `--user-data-dir=${temporary}/profile`, 'about:blank'], { stdio: 'ignore' });
    const waitFor = async (fn) => { const until = Date.now() + 15000; while (Date.now() < until) { const result = await fn(); if (result) return result; await new Promise((resolve) => setTimeout(resolve, 20)); } throw new Error('Timed out waiting for browser fixture'); };
    const port = await waitFor(() => existsSync(`${temporary}/profile/DevToolsActivePort`) && readFileSync(`${temporary}/profile/DevToolsActivePort`, 'utf8').split('\n')[0]);
    const target = (await fetch(`http://127.0.0.1:${port}/json/list`).then((response) => response.json())).find((item) => item.type === 'page');
    socket = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
    let counter = 0;
    const pending = new Map();
    const errors = [];
    socket.addEventListener('message', (event) => {
        const message = JSON.parse(event.data);
        if (message.id) { const item = pending.get(message.id); pending.delete(message.id); if (message.error) item.reject(new Error(message.error.message)); else item.resolve(message.result); }
        else if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text);
    });
    const send = (method, params = {}) => new Promise((resolve, reject) => { const id = ++counter; pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params })); });
    const evaluate = async (expression) => { const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text); return result.result.value; };
    await send('Runtime.enable'); await send('Page.enable'); await send('HeapProfiler.enable');
    await send('Page.navigate', { url: origin });
    await waitFor(() => evaluate('Boolean(window.fixture)'));
    const click = async (id) => {
        const point = await evaluate(`(()=>{const r=document.getElementById(${JSON.stringify(id)}).getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
        await send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point });
        await send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point });
        await waitFor(async () => !(await evaluate('fixture.stats().busy')));
        const error = await evaluate('window.fixtureError'); if (error) throw new Error(error);
    };
    const sample = async () => { await send('HeapProfiler.collectGarbage'); await send('HeapProfiler.collectGarbage'); return { heap: await send('Runtime.getHeapUsage'), dom: await send('Memory.getDOMCounters'), app: await evaluate('fixture.stats()') }; };
    // Prewarm module paths and all light metadata. Heavy session data is then released for both measurements.
    for (let index = 0; index < 5; index++) await click('next');
    await click('leave');
    await evaluate('fixture.history()');
    await evaluate('fixture.sleepingHistory()');
    await evaluate('fixture.abortProbe()');
    const historyRequests = requests.filter((request) => request.sessionId.startsWith('runtime-'));
    const baseline = await sample();
    for (let index = 0; index < 50; index++) await click('next');
    await click('leave');
    const final = await sample();
    const heapGrowth = (final.heap.usedSize - baseline.heap.usedSize) / baseline.heap.usedSize;
    const empty = final.app.bodySessions.length === 0 && final.app.streamSessions.length === 0 && final.app.fileSessions.length === 0 && final.app.blobCount === 0 && final.app.resources.resources === 0 && final.app.decryption.messages === 0 && final.app.requestAborts >= 1;
    const cursor = final.app.cursorEvidence;
    const historyOk = cursor.initialRuntimes.length === 1 && cursor.initialCount === 80 && cursor.catchupCount === 80 && cursor.restored && cursor.archivedRestored
        && cursor.archivedResident.join() === 'runtime-new,runtime-middle' && cursor.latestResident.join() === 'runtime-new'
        && historyRequests.every((request) => request.count <= 100) && historyRequests.length <= 8;
    const result = {
        ok: heapGrowth < 0.15 && empty && historyOk && final.app.sleepingHistoryLoaded && final.dom.nodes <= baseline.dom.nodes + 10 && errors.length === 0,
        fixture: 'Actual Sync + Zustand store + reducer + caches; synthetic 100000-event lazy HTTP histories and decryption adapter; DOM renderer capped at 12 rows (production ChatList excluded).',
        baseline, final, heapGrowth, historyRequests, totalHistoryRecordsServed: historyRequests.reduce((sum, request) => sum + request.count, 0), totalRequests: requests.length, errors,
    };
    mkdirSync(dirname(output), { recursive: true }); writeFileSync(output, JSON.stringify(result, null, 2));
    const screenshot = await send('Page.captureScreenshot', { format: 'png' }); writeFileSync(output.replace(/\.json$/, '.png'), Buffer.from(screenshot.data, 'base64'));
    console.log(JSON.stringify({ ok: result.ok, heapGrowth, baselineHeap: baseline.heap.usedSize, finalHeap: final.heap.usedSize, baselineNodes: baseline.dom.nodes, finalNodes: final.dom.nodes, historyRequests: historyRequests.length, historyRecords: result.totalHistoryRecordsServed, output }, null, 2));
    if (!result.ok) process.exitCode = 1;
} finally {
    socket?.close(); browser?.kill('SIGTERM'); server?.close();
    await new Promise((resolve) => setTimeout(resolve, 100));
    rmSync(temporary, { recursive: true, force: true });
}
