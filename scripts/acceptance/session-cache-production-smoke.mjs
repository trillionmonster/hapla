#!/usr/bin/env node
/** Actual production navigation/FlatList/Sync acceptance with synthetic encrypted API records. */
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync, mkdtempSync, rmSync, openSync, closeSync, writeSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
const args = Object.fromEntries(process.argv.slice(2).map((arg) => { const [key, ...value] = arg.replace(/^--/, '').split('='); return [key, value.join('=') || true]; }));
const origin = String(args.url ?? 'http://127.0.0.1:12446');
const home = resolve(String(args.home ?? '.runtime/reliability-isolated/a1'));
const manifest = JSON.parse(readFileSync(resolve(String(args.manifest ?? '.runtime/evidence/session-cache-production-seed.json')), 'utf8'));
const output = resolve(String(args.output ?? '.runtime/evidence/session-cache-production.json'));
const maximumHeapGrowth = Number(args['max-heap-growth'] ?? 0.29);
if (!Number.isFinite(maximumHeapGrowth) || maximumHeapGrowth < 0) throw new Error('Invalid max-heap-growth');
const credentials = JSON.parse(readFileSync(`${home}/access.key`, 'utf8'));
const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
let buffer = 0, bits = 0; const bytes = [];
for (const char of readFileSync(`${home}/recovery-key.txt`, 'utf8').toUpperCase().replace(/[^A-Z2-7]/g, '')) {
    buffer = (buffer << 5) | alphabet.indexOf(char); bits += 5;
    if (bits >= 8) { bits -= 8; bytes.push((buffer >> bits) & 255); }
}
if (bytes.length !== 32) throw new Error('Invalid acceptance recovery key');
const auth = { token: credentials.token, secret: Buffer.from(bytes).toString('base64url') };
const profile = mkdtempSync(join(tmpdir(), 'hapla-cache-production-'));
const browser = spawn(process.env.CHROMIUM_PATH ?? 'chromium', [
    '--headless=new', '--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--window-size=1440,1000', 'about:blank',
], { stdio: 'ignore' });
const requests = [], errors = [], domSamples = [], pageBodies = [];
let socket, send, evaluate, snapshotFd;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(fn, label, timeout = 20000) {
    const until = Date.now() + timeout;
    while (Date.now() < until) { const result = await fn(); if (result) return result; await pause(50); }
    throw new Error(`Timed out: ${label}`);
}
try {
    const port = await waitFor(() => existsSync(`${profile}/DevToolsActivePort`) && readFileSync(`${profile}/DevToolsActivePort`, 'utf8').split('\n')[0], 'DevTools port');
    const target = (await fetch(`http://127.0.0.1:${port}/json/list`).then((response) => response.json())).find((target) => target.type === 'page');
    socket = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
    let sequence = 0; const pending = new Map();
    const completedResponses = new Map();
    socket.addEventListener('message', (event) => {
        const message = JSON.parse(event.data);
        if (message.id) { const item = pending.get(message.id); if (!item) return; clearTimeout(item.timer); pending.delete(message.id); message.error ? item.reject(new Error(message.error.message)) : item.resolve(message.result ?? {}); }
        else if (message.method === 'HeapProfiler.addHeapSnapshotChunk' && snapshotFd !== undefined) writeSync(snapshotFd, message.params.chunk);
        else if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text);
        else if (message.method === 'Network.requestWillBeSent') {
            const data = message.params; const url = new URL(data.request.url);
            if (/\/v3\/sessions\/[^/]+\/messages$/.test(url.pathname) && data.request.method === 'GET') {
                const entry = { id: data.requestId, path: url.pathname + url.search, sessionId: url.pathname.split('/')[3], at: Date.now(), status: null, count: null };
                requests.push(entry); completedResponses.set(data.requestId, entry);
            }
        } else if (message.method === 'Network.responseReceived') {
            const entry = completedResponses.get(message.params.requestId); if (entry) entry.status = message.params.response.status;
        } else if (message.method === 'Network.loadingFinished') {
            const entry = completedResponses.get(message.params.requestId);
            if (entry) void send('Network.getResponseBody', { requestId: entry.id }).then((result) => {
                const body = JSON.parse(result.base64Encoded ? Buffer.from(result.body, 'base64').toString() : result.body);
                entry.count = body.messages?.length; entry.hasMore = body.hasMore;
            }).catch(() => {});
        }
    });
    socket.addEventListener('close', () => { for (const item of pending.values()) { clearTimeout(item.timer); item.reject(new Error('Acceptance browser connection closed')); } pending.clear(); });
    send = (method, params = {}) => new Promise((resolve, reject) => {
        const id = ++sequence;
        const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 30000);
        pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params }));
    });
    evaluate = async (expression) => { const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text); return result.result.value; };
    await send('Runtime.enable'); await send('Page.enable'); await send('Network.enable'); await send('HeapProfiler.enable');
    await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
    await send('Page.addScriptToEvaluateOnNewDocument', { source: `
        localStorage.setItem('auth_credentials',${JSON.stringify(JSON.stringify(auth))});
        (()=>{ const urls=new Set(); let created=0, revoked=0; const create=URL.createObjectURL.bind(URL), revoke=URL.revokeObjectURL.bind(URL);
        URL.createObjectURL=(blob)=>{const url=create(blob);urls.add(url);created++;return url};URL.revokeObjectURL=(url)=>{if(urls.delete(url))revoked++;return revoke(url)};
        window.__cacheAcceptance=()=>({liveBlobUrls:urls.size,createdBlobUrls:created,revokedBlobUrls:revoked}); })();
    ` });
    await send('Page.navigate', { url: origin });
    await waitFor(async () => (await evaluate('document.body?.innerText ?? ""')).includes('CACHE_PROD'), 'real decrypted session list', 40000);
    await pause(1000);
    const layout = async () => evaluate(`(()=>({url:location.pathname,buttons:[...document.querySelectorAll('[role="button"],a')].map(e=>({text:e.innerText?.slice(0,90),label:e.getAttribute('aria-label'),href:e.getAttribute('href'),x:Math.round(e.getBoundingClientRect().x),y:Math.round(e.getBoundingClientRect().y)})).filter(e=>e.y>=0&&e.y<1000).slice(0,60)}))()`);
    if (args.probe) { console.log(JSON.stringify(await layout(), null, 2)); await send('HeapProfiler.collectGarbage'); }
    else if (args['history-session']) {
        const sessionId = String(args['history-session']);
        const required = String(args['history-markers'] ?? '').split('||').filter(Boolean);
        const forbidden = String(args['history-forbidden'] ?? '').split('||').filter(Boolean);
        if (!required.length) throw new Error('history-markers is required for real conversation verification');
        await send('Page.navigate', { url: `${origin}/session/${encodeURIComponent(sessionId)}` });
        await waitFor(() => evaluate(`!!document.querySelector('[aria-label="从这条消息重新编辑并保留原分支"]')`), 'real conversation initial hot page');
        const clicks = [];
        for (let attempt = 0; attempt < 6; attempt++) {
            const body = await evaluate('document.body?.innerText ?? ""');
            if (required.every(marker => body.includes(marker))) break;
            const point = await evaluate(`(()=>{const e=document.querySelector('[aria-label="加载更早记录"]');if(!e)return null;e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
            if (point) {
                await send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point });
                await send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point });
                clicks.push({ at: Date.now(), ...point });
            }
            await pause(750);
        }
        const body = await evaluate('document.body?.innerText ?? ""');
        const missing = required.filter(marker => !body.includes(marker));
        const forbiddenMatches = forbidden.filter(marker => body.includes(marker));
        const result = { ok: !missing.length && !forbiddenMatches.length && !errors.length, fixture: false,
            scenario: 'Read-only real conversation history through the production page and explicit older-page button; no new model turn was sent.',
            sessionId, required, missing, forbiddenMatches, clicks, requests, errors, body: body.slice(-12000) };
        mkdirSync(dirname(output), { recursive: true }); writeFileSync(output, JSON.stringify(result, null, 2));
        console.log(JSON.stringify({ ok: result.ok, historySession: sessionId, clicks: clicks.length, missing, forbiddenMatches, output }));
        if (!result.ok) process.exitCode = 1;
    } else {
        const clickPoint = async (point) => { await send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point }); await send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point }); };
        async function openSession(session) {
            const prefixes = (session.clickNames ?? [session.name]).map((name) => `${name},`);
            let point;
            for (let attempt = 0; attempt < 60; attempt++) {
                point = await evaluate(`(()=>{const e=[...document.querySelectorAll('[role="button"]')].find(e=>${JSON.stringify(prefixes)}.some(prefix=>e.getAttribute('aria-label')?.startsWith(prefix)));if(!e)return null;e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return {x:r.x+Math.min(r.width/2,100),y:r.y+r.height/2}})()`);
                if (point && point.y > 0 && point.y < 1000) break;
                // Advance the actual virtualized sidebar, keeping the production navigation handler intact.
                await evaluate(`(()=>{const e=[...document.querySelectorAll('div')].filter(e=>{const r=e.getBoundingClientRect();return r.x<350&&r.width>100&&r.width<700&&e.scrollHeight>e.clientHeight+20&&/(auto|scroll)/.test(getComputedStyle(e).overflowY)}).sort((a,b)=>b.clientHeight-a.clientHeight)[0];if(e){if(e.scrollTop+e.clientHeight>=e.scrollHeight-2)e.scrollTop=0;else e.scrollTop+=650}})()`);
                await pause(100);
            }
            if (!point) throw new Error(`Sidebar session missing: ${session.name}`);
            await clickPoint(point);
            await waitFor(() => evaluate(`${JSON.stringify(session.routeIds ?? [session.id])}.some(id=>location.pathname.includes(id))`), `navigate ${session.name}`);
            const marker = `[${session.name} #${session.count}]`;
            await waitFor(async () => (await evaluate('document.body?.innerText ?? ""')).includes(marker), `load ${session.name}`, 30000);
            await pause(100);
        }
        const mainSessions = [...manifest.sessions].reverse().map((session) => session.index === 0 && manifest.archives.length ? { ...manifest.archives.at(-1), clickNames: [session.name, ...manifest.archives.map(item=>item.name)], routeIds: [session.id, ...manifest.archives.map(item=>item.id)] } : session);
        const leaveSession = async () => {
            const point = await evaluate(`(()=>{const e=document.querySelector('[aria-label="New session"]');if(!e)return null;const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
            if (!point) throw new Error('Actual New session navigation control missing');
            await clickPoint(point);
            await waitFor(() => evaluate(`location.pathname==='/new'`), 'leave through actual New session navigation');
            await pause(300);
        };
        const sample = async () => {
            await pause(250); await send('HeapProfiler.collectGarbage'); await send('HeapProfiler.collectGarbage');
            return { heap: await send('Runtime.getHeapUsage'), dom: await send('Memory.getDOMCounters'), liveDom: await evaluate(`({nodes:document.querySelectorAll('*').length,textareas:document.querySelectorAll('textarea').length,messageActions:document.querySelectorAll('[aria-label="从这条消息重新编辑并保留原分支"]').length})`), blobs: await evaluate('window.__cacheAcceptance()'), path: await evaluate('location.pathname') };
        };
        for (const session of mainSessions.slice(0, 5)) { await openSession(session); await leaveSession(); }
        const baseline = await sample();
        for (let index = 0; index < mainSessions.length; index++) {
            await openSession(mainSessions[index]);
            const dom = await send('Memory.getDOMCounters');
            domSamples.push({ index, nodes: dom.nodes, documents: dom.documents });
            await leaveSession();
            if ((index + 1) % 10 === 0) console.log(JSON.stringify({ productionSessionsVisited: index + 1 }));
        }
        const final = await sample();
        const growth = (final.heap.usedSize - baseline.heap.usedSize) / baseline.heap.usedSize;
        const checkpoint = { ok: false, phase: 'memory measured; anchor and generation checks pending', baseline, final, heapGrowth: growth, domSamples };
        writeFileSync(output, JSON.stringify(checkpoint, null, 2));
        console.log(JSON.stringify({ memoryCheckpoint: true, heapGrowth: growth, baselineHeap: baseline.heap.usedSize, finalHeap: final.heap.usedSize, baselineNodes: baseline.dom.nodes, finalNodes: final.dom.nodes }));
        if (args.heap) {
            // Snapshots contain test-account state and remain private local diagnostics.
            const snapshotPath = output.replace(/\.json$/, '.heapsnapshot');
            snapshotFd = openSync(snapshotPath, 'w', 0o600);
            try { await send('HeapProfiler.takeHeapSnapshot', { reportProgress: false }); }
            finally { closeSync(snapshotFd); snapshotFd = undefined; }
        }
        const historySession = manifest.sessions.find((session) => session.count === 100000);
        await openSession(historySession);
        const messageViewport = () => evaluate(`(()=>{const nodes=[...document.querySelectorAll('[aria-label="从这条消息重新编辑并保留原分支"]')].map(e=>e.parentElement);return nodes.map(e=>{const r=e.getBoundingClientRect();return {marker:e.textContent.match(/\\[[^\\]]+\\]/)?.[0],top:r.top,bottom:r.bottom,left:r.left}}).filter(e=>e.marker?.startsWith('[CACHE_PROD')&&e.left>300&&e.top<850&&e.bottom>120)})()`);
        const didScroll = await evaluate(`(()=>{const candidates=[...document.querySelectorAll('div')].filter(e=>{const r=e.getBoundingClientRect();return r.x>300&&r.width>400&&r.height>300&&e.scrollHeight>e.clientHeight+200&&/(auto|scroll)/.test(getComputedStyle(e).overflowY)});const e=candidates.sort((a,b)=>b.clientHeight-a.clientHeight)[0];if(!e)return null;e.scrollTop=5000;return {height:e.clientHeight,scrollHeight:e.scrollHeight,offset:e.scrollTop}})()`);
        await pause(750);
        const beforeAnchor = await messageViewport();
        const beforeImage = await send('Page.captureScreenshot', { format: 'png' }); writeFileSync(output.replace(/\.json$/, '-anchor-before.png'), Buffer.from(beforeImage.data, 'base64'));
        await leaveSession(); await openSession(historySession); await pause(800);
        const afterAnchor = await messageViewport();
        const restoredMarkers = beforeAnchor.map((entry)=>entry.marker).filter((marker)=>afterAnchor.some((entry)=>entry.marker===marker));
        const anchorAcceptance = { didScroll, before: beforeAnchor, after: afterAnchor, restoredMarkers, ok: !!didScroll && didScroll.offset > 1000 && restoredMarkers.length > 0 };
        const afterImage = await send('Page.captureScreenshot', { format: 'png' }); writeFileSync(output.replace(/\.json$/, '-anchor-after.png'), Buffer.from(afterImage.data, 'base64'));
        await leaveSession();
        const latestGeneration = mainSessions.find((session) => session.name === manifest.archives.at(-1)?.name);
        const olderGeneration = manifest.archives.at(-2);
        let generationAcceptance = { ok: false, note: 'Multiple generation scenario missing from manifest' };
        if (latestGeneration && olderGeneration) {
            await openSession(latestGeneration);
            const requestStart = requests.length;
            const scrolls = [];
            for (let attempt = 0; attempt < 50 && !requests.some((entry, index) => index >= requestStart && entry.sessionId === olderGeneration.id); attempt++) {
                await pause(300);
                await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 1000, y: 400, deltaX: 0, deltaY: 1000 });
                scrolls.push(await evaluate(`(()=>{const e=[...document.querySelectorAll('div')].filter(e=>{const r=e.getBoundingClientRect();return r.x>300&&r.width>400&&r.height>300&&e.scrollHeight>e.clientHeight+200&&/(auto|scroll)/.test(getComputedStyle(e).overflowY)}).sort((a,b)=>b.clientHeight-a.clientHeight)[0];if(!e)return null;e.scrollTop=e.scrollHeight;return {offset:e.scrollTop,height:e.clientHeight,total:e.scrollHeight}})()`));
            }
            await pause(500);
            const generationRequests = requests.slice(requestStart);
            generationAcceptance = {
                ok: generationRequests.some(entry => entry.sessionId === olderGeneration.id && entry.count <= 80)
                    && generationRequests.every(entry => entry.sessionId === olderGeneration.id && (entry.count === null || entry.count <= 80)),
                entrySessionId: latestGeneration.id, olderSessionId: olderGeneration.id,
                requests: generationRequests, scrolls,
                note: 'Actual production FlatList is scrolled through its dynamically measured cells; requests record whether onEndReached opened the previous transport generation.',
            };
            await leaveSession();
        }
        const historyRequests = requests.filter((request) => request.sessionId === historySession.id);
        const result = {
            ok: growth <= maximumHeapGrowth && final.liveDom.nodes <= baseline.liveDom.nodes * 1.15 && final.blobs.liveBlobUrls === baseline.blobs.liveBlobUrls && errors.length === 0
                && requests.every((request) => request.count === null || request.count <= 100) && anchorAcceptance.ok && generationAcceptance.ok,
            acceptance: { maximumHeapGrowth, basis: 'User accepted up to 29% GC heap growth. Live document DOM must remain bounded; CDP detached-node counters remain reported as diagnostics.' },
            fixture: 'Production web export, actual FlatList/Sync/decryption/HTTP and sidebar navigation. Synthetic encrypted messages were seeded via real isolated API; no model turns are claimed.',
            baseline, final, heapGrowth: growth, sessionCount: mainSessions.length, domSamples, historyRequests,
            totalRecordsFetched: requests.reduce((sum, request) => sum + (request.count ?? 0), 0), requests, errors,
            anchorAcceptance, generationAcceptance,
        };
        mkdirSync(dirname(output), { recursive: true }); writeFileSync(output, JSON.stringify(result, null, 2));
        console.log(JSON.stringify({ ok: result.ok, heapGrowth: growth, baselineHeap: baseline.heap.usedSize, finalHeap: final.heap.usedSize, baselineNodes: baseline.dom.nodes, finalNodes: final.dom.nodes, fetchedRecords: result.totalRecordsFetched, output }, null, 2));
        if (!result.ok) process.exitCode = 1;
    }
    mkdirSync(dirname(output), { recursive: true });
    const screenshot = await send('Page.captureScreenshot', { format: 'png' }); writeFileSync(output.replace(/\.json$/, '.png'), Buffer.from(screenshot.data, 'base64'));
} catch (error) {
    mkdirSync(dirname(output), { recursive: true });
    const existing = existsSync(output) ? JSON.parse(readFileSync(output, 'utf8')) : {};
    const evidence = { ...existing, ok: false, error: String(error), requests, errors };
    if (evaluate) evidence.page = await evaluate(`({path:location.pathname,text:document.body.innerText.slice(0,3500)})`).catch(() => null);
    writeFileSync(output, JSON.stringify(evidence, null, 2));
    if (send) { const image = await send('Page.captureScreenshot', { format: 'png' }).catch(() => null); if (image) writeFileSync(output.replace(/\.json$/, '.png'), Buffer.from(image.data, 'base64')); }
    console.error(String(error)); process.exitCode = 1;
} finally {
    if (snapshotFd !== undefined) closeSync(snapshotFd);
    socket?.close();
    if (browser.exitCode === null) {
        const exited = new Promise((resolve) => browser.once('exit', resolve));
        browser.kill('SIGTERM');
        await Promise.race([exited, pause(3000)]);
    }
    rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
