#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync, mkdirSync, openSync, writeSync, closeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const args = Object.fromEntries(
    process.argv.slice(2).map((entry) => {
        const [key, ...value] = entry.replace(/^--/, '').split('=');
        return [key, value.length ? value.join('=') : true];
    }),
);

const url = String(args.url || 'http://127.0.0.1:12345');
const width = Number(args.width || 390);
const height = Number(args.height || 844);
const screenshot = String(args.screenshot || '/tmp/hapla-web-smoke.png');
const browserPath = String(
    args.browser ||
        process.env.CHROMIUM_PATH ||
        'chromium',
);
const suppliedProfile = typeof args.profile === 'string' ? args.profile : undefined;
const profile = suppliedProfile || mkdtempSync(join(tmpdir(), 'hapla-web-smoke-'));
const shouldAccept = args.accept === true || args.accept === 'true';
const afterUrl = typeof args['after-url'] === 'string' ? args['after-url'] : undefined;
const targetUrl = typeof args['target-url'] === 'string' ? args['target-url'] : undefined;
const clickText = typeof args.click === 'string' ? args.click : undefined;
const waitBeforeClickText = typeof args['wait-before-click-text'] === 'string' ? args['wait-before-click-text'] : undefined;
const waitBeforeFinalClickText = typeof args['wait-before-final-click-text'] === 'string' ? args['wait-before-final-click-text'] : undefined;
const clickOccurrence = Math.max(1, Number(args['click-occurrence'] || 1));
const clickPointValue = typeof args['click-point'] === 'string'
    ? args['click-point'].split(',').map(Number)
    : undefined;
const touchPointValue = typeof args['touch-point'] === 'string'
    ? args['touch-point'].split(',').map(Number)
    : undefined;
const afterClickPointValue = typeof args['after-click-point'] === 'string'
    ? args['after-click-point'].split(',').map(Number)
    : undefined;
const afterWheelValue = typeof args['after-wheel'] === 'string'
    ? args['after-wheel'].split(',').map(Number)
    : undefined;
const afterWheelCount = Math.max(1, Number(args['after-wheel-count'] || 1));
const afterDragValue = typeof args['after-drag'] === 'string'
    ? args['after-drag'].split(',').map(Number)
    : undefined;
const restoreAccount = args['restore-account'] === true || args['restore-account'] === 'true';
const recoveryKey = process.env.HAPLA_SMOKE_RECOVERY_KEY;
const afterClickText = typeof args['after-click'] === 'string' ? args['after-click'] : undefined;
const downloadText = typeof args.download === 'string' ? args.download : undefined;
const downloadDir = downloadText
    ? String(args['download-dir'] || mkdtempSync(join(tmpdir(), 'hapla-web-download-')))
    : undefined;
const promptValue = typeof args['prompt-value'] === 'string' ? args['prompt-value'] : undefined;
const promptConfirm = typeof args['prompt-confirm'] === 'string' ? args['prompt-confirm'] : 'OK';
const waitAfterPromptText = typeof args['wait-after-prompt-text'] === 'string' ? args['wait-after-prompt-text'] : undefined;
const waitAfterPromptCount = Number(args['wait-after-prompt-count'] || 1);
const projectPath = typeof args['project-path'] === 'string' ? args['project-path'] : undefined;
const environmentKey = typeof args['env-key'] === 'string' ? args['env-key'] : undefined;
const environmentValue = typeof args['env-value'] === 'string' ? args['env-value'] : undefined;
const uploadFiles = typeof args['upload-files-json'] === 'string' ? JSON.parse(args['upload-files-json']) : [];
const messageText = typeof args.message === 'string' ? args.message : undefined;
const waitText = typeof args['wait-text'] === 'string' ? args['wait-text'] : undefined;
const waitTextCount = Number(args['wait-text-count'] || 1);
const waitIframe = typeof args['wait-iframe'] === 'string' ? args['wait-iframe'] : undefined;
const waitMedia = typeof args['wait-media'] === 'string' ? args['wait-media'] : undefined;
const exerciseMedia = typeof args['exercise-media'] === 'string' ? args['exercise-media'] : undefined;
const nativeMedia = typeof args['native-media'] === 'string' ? args['native-media'] : undefined;
const verifyPreviewRelease = args['verify-preview-release'] === true || args['verify-preview-release'] === 'true';
const failPreviewOnce = args['fail-preview-once'] === true || args['fail-preview-once'] === 'true';
const sampleMemory = args['sample-memory'] === true || args['sample-memory'] === 'true';
const performanceSamples = [];
let memorySampleTimer;
let memorySamplePending = false;
const exerciseStaticPreview = args['exercise-static-preview'] === true || args['exercise-static-preview'] === 'true';
const exerciseHtml = args['exercise-html'] === true || args['exercise-html'] === 'true';
const iframeClickText = typeof args['iframe-click'] === 'string' ? args['iframe-click'] : undefined;
const iframeWaitText = typeof args['iframe-wait'] === 'string' ? args['iframe-wait'] : undefined;
const iframeWaitSelector = typeof args['iframe-wait-selector'] === 'string' ? args['iframe-wait-selector'] : undefined;
const iframeWaitValue = typeof args['iframe-wait-value'] === 'string' ? args['iframe-wait-value'] : undefined;
const iframeSubmitText = typeof args['iframe-submit'] === 'string' ? args['iframe-submit'] : undefined;
const waitAfterIframeText = typeof args['wait-after-iframe-text'] === 'string' ? args['wait-after-iframe-text'] : undefined;
const forbiddenText = typeof args['forbid-text'] === 'string'
    ? args['forbid-text'].split('||').filter(Boolean)
    : [];
const requiredText = typeof args['require-text'] === 'string'
    ? args['require-text'].split('||').filter(Boolean)
    : [];
const requiredOrder = typeof args['require-order'] === 'string'
    ? args['require-order'].split('||').filter(Boolean)
    : [];
const repeatClicks = typeof args['repeat-click'] === 'string'
    ? args['repeat-click'].split('||').filter(Boolean)
    : [];
const repeatClickCount = Math.max(0, Number(args['repeat-click-count'] || 0));
const holdMs = Math.max(0, Number(args['hold-ms'] || 0));
const screencastDir = typeof args['screencast-dir'] === 'string' ? args['screencast-dir'] : undefined;
const heapSnapshot = typeof args['heap-snapshot'] === 'string' ? args['heap-snapshot'] : undefined;
if (screencastDir) mkdirSync(screencastDir, { recursive: true, mode: 0o700 });
let heapFd;
const screencastFrames = [];
const networkEvidence = [];
const externalRequestAttempts = [];
const outputFile = typeof args.output === 'string' ? args.output : undefined;
const waitTimeout = Number(args['wait-timeout'] || 90_000);
const observeStreamStart = typeof args['observe-stream-start'] === 'string' ? args['observe-stream-start'] : undefined;
const observeStreamEnd = typeof args['observe-stream-end'] === 'string' ? args['observe-stream-end'] : undefined;
const expectedActivities = typeof args['expect-activities'] === 'string'
    ? args['expect-activities'].split('||').filter(Boolean)
    : [];
const activityScreenshotText = typeof args['activity-screenshot-text'] === 'string' ? args['activity-screenshot-text'] : undefined;
const activityScreenshotPath = typeof args['activity-screenshot'] === 'string' ? args['activity-screenshot'] : undefined;
const clickDuringRun = typeof args['click-during-run'] === 'string' ? args['click-during-run'] : undefined;
const stopDuringRun = args['stop-during-run'] === true || args['stop-during-run'] === 'true';
const stopAfterActivity = typeof args['stop-after-activity'] === 'string' ? args['stop-after-activity'] : undefined;
const stopAfterText = typeof args['stop-after-text'] === 'string' ? args['stop-after-text'] : undefined;
const simulateOffline = args['simulate-offline'] === true || args['simulate-offline'] === 'true';
const recoverOnline = args['recover-online'] === true || args['recover-online'] === 'true';
const offlineCycles = Math.max(1, Number(args['offline-cycles'] || 1));
const scrollBottom = args['scroll-bottom'] === true || args['scroll-bottom'] === 'true';
const exportRecoveryKey = typeof args['export-recovery-key'] === 'string' ? args['export-recovery-key'] : undefined;
const colorScheme = args['color-scheme'] === 'dark' ? 'dark' : args['color-scheme'] === 'light' ? 'light' : undefined;
const disableNativeSavePicker = args['disable-native-save-picker'] === true || args['disable-native-save-picker'] === 'true';
const allowEmptyBody = args['allow-empty-body'] === true || args['allow-empty-body'] === 'true';
const exerciseNewSessionEntry = args['exercise-new-session-entry'] === true || args['exercise-new-session-entry'] === 'true';
const exerciseDeleteCurrentSession = args['exercise-delete-current-session'] === true || args['exercise-delete-current-session'] === 'true';
if (!existsSync(browserPath)) {
    throw new Error(`Chromium not found: ${browserPath}`);
}

const activePortFile = join(profile, 'DevToolsActivePort');
if (existsSync(activePortFile)) unlinkSync(activePortFile);

const browser = spawn(
    browserPath,
    [
        '--headless=new',
        '--no-sandbox',
        '--disable-gpu',
        '--disable-dev-shm-usage',
        '--disable-background-networking',
        '--disable-component-update',
        '--disable-default-apps',
        '--disable-extensions',
        '--disable-sync',
        ...(disableNativeSavePicker ? ['--disable-features=FileSystemAccessAPI'] : []),
        '--metrics-recording-only',
        '--no-first-run',
        '--remote-debugging-port=0',
        `--user-data-dir=${profile}`,
        'about:blank',
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] },
);
const browserExited = new Promise((resolve) => browser.once('exit', resolve));

let browserStderr = '';
browser.stderr.on('data', (chunk) => {
    browserStderr += chunk.toString();
});

const sleep = (duration) => new Promise((resolve) => setTimeout(resolve, duration));

async function waitFor(getValue, timeoutMs, label) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const value = await getValue();
        if (value) return value;
        await sleep(100);
    }
    const diagnostics = [
        runtimeErrors.length ? `runtime errors: ${runtimeErrors.join(' | ')}` : '',
        failedRequests.length ? `failed requests: ${failedRequests.join(' | ')}` : '',
    ].filter(Boolean).join('; ');
    throw new Error(`Timed out waiting for ${label}${diagnostics ? ` (${diagnostics})` : ''}`);
}

let socket;
let nextId = 0;
const pending = new Map();
const runtimeErrors = [];
const failedRequests = [];
const loadedScripts = [];
const mediaResponses = [];
const downloads = [];
const authTraffic = [];
const deletionTraffic = [];
const executionContexts = [];
const attachedTargets = [];
let initialCdpMetrics = null;
let stopObservation = null;

function pickPerformanceMetrics(metrics = []) {
    const wanted = new Set([
        'Timestamp', 'Documents', 'Frames', 'JSEventListeners', 'Nodes',
        'LayoutCount', 'RecalcStyleCount', 'LayoutDuration', 'RecalcStyleDuration',
        'ScriptDuration', 'TaskDuration', 'JSHeapUsedSize', 'JSHeapTotalSize',
    ]);
    return Object.fromEntries(metrics.filter((item) => wanted.has(item.name)).map((item) => [item.name, item.value]));
}

function request(method, params = {}, sessionId) {
    if (socket?.readyState !== WebSocket.OPEN) return Promise.reject(new Error(`Browser disconnected before ${method}`));
    const id = ++nextId;
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Browser command timed out: ${method}`)); }, method === 'HeapProfiler.takeHeapSnapshot' ? 60000 : 30000);
        pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); }, method });
        socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
}

async function evaluate(expression) {
    const response = await request('Runtime.evaluate', {
        expression,
        awaitPromise: true,
        returnByValue: true,
    });
    if (response.exceptionDetails) {
        throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text || 'Browser evaluation failed');
    }
    return response.result.value;
}

async function clickControl(requestedText, occurrence = 1) {
    const target = await evaluate(`(() => {
        const expected = ${JSON.stringify(requestedText)};
        const normalized = expected.toLocaleLowerCase();
        const hitPoint = (item) => {
            const style = getComputedStyle(item);
            const rect = item.getBoundingClientRect();
            if (style.visibility === 'hidden' || style.display === 'none' || Number(style.opacity) <= 0
                || rect.width <= 0 || rect.height <= 0
                || rect.bottom <= 0 || rect.right <= 0 || rect.top >= innerHeight || rect.left >= innerWidth) return null;
            const xs = [0.5, 0.25, 0.75];
            const ys = [0.5, 0.75, 0.25, 0.9, 0.1];
            for (const xRatio of xs) {
                for (const yRatio of ys) {
                    const x = Math.max(1, Math.min(innerWidth - 2, rect.left + rect.width * xRatio));
                    const y = Math.max(1, Math.min(innerHeight - 2, rect.top + rect.height * yRatio));
                    const top = document.elementFromPoint(x, y);
                    if (top && (top === item || item.contains(top) || top.contains(item))) return { x, y };
                }
            }
            return null;
        };
        const available = (item) => {
            const style = getComputedStyle(item);
            const rect = item.getBoundingClientRect();
            return style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity) > 0
                && rect.width > 0 && rect.height > 0;
        };
        const interactive = [...document.querySelectorAll('[role="button"], button, a, [tabindex]')]
            .filter(available);
        const fallback = [...document.querySelectorAll('body *')]
            .filter(available);
        const candidates = [...interactive, ...fallback]
            .filter((item) => {
                return item.textContent?.trim() || item.getAttribute('aria-label');
            });
        const exact = candidates.filter((item) => item.textContent?.trim().toLocaleLowerCase() === normalized || item.getAttribute('aria-label')?.toLocaleLowerCase() === normalized);
        const partial = candidates.filter((item) => item.textContent?.trim().toLocaleLowerCase().includes(normalized) || item.getAttribute('aria-label')?.toLocaleLowerCase().includes(normalized));
        const matches = exact.length > 0 ? exact : partial;
        const visibleMatches = matches.filter((item) => hitPoint(item));
        const pool = visibleMatches.length > 0 ? visibleMatches : matches;
        const node = pool[${Math.max(0, occurrence - 1)}];
        if (!node) return null;
        node.scrollIntoView({ block: 'center', inline: 'center' });
        return hitPoint(node);
    })()`);
    if (!target) return false;
    await request('Input.dispatchMouseEvent', {
        type: 'mousePressed',
        x: target.x,
        y: target.y,
        button: 'left',
        buttons: 1,
        clickCount: 1,
    });
    await request('Input.dispatchMouseEvent', {
        type: 'mouseReleased',
        x: target.x,
        y: target.y,
        button: 'left',
        buttons: 0,
        clickCount: 1,
    });
    return true;
}

async function focusSelector(selector) {
    const target = await evaluate(`(() => {
        const node = document.querySelector(${JSON.stringify(selector)});
        if (!node) return null;
        node.scrollIntoView({ block: 'center', inline: 'center' });
        const rect = node.getBoundingClientRect();
        return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    })()`);
    if (!target) return false;
    await request('Input.dispatchMouseEvent', {
        type: 'mousePressed', x: target.x, y: target.y, button: 'left', buttons: 1, clickCount: 1,
    });
    await request('Input.dispatchMouseEvent', {
        type: 'mouseReleased', x: target.x, y: target.y, button: 'left', buttons: 0, clickCount: 1,
    });
    return true;
}

async function clickPoint(x, y) {
    await request('Input.dispatchMouseEvent', {
        type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1,
    });
    await request('Input.dispatchMouseEvent', {
        type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1,
    });
}

async function touchPoint(x, y) {
    await request('Input.dispatchTouchEvent', {
        type: 'touchStart',
        touchPoints: [{ x, y, radiusX: 1, radiusY: 1, force: 1 }],
    });
    await request('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}

async function touchControl(accessibilityLabel) {
    const target = await evaluate(`(() => {
        const label = ${JSON.stringify(accessibilityLabel)};
        const candidates = [...document.querySelectorAll('[aria-label]')]
            .filter((item) => item.getAttribute('aria-label') === label);
        const item = candidates.find((candidate) => {
            const style = getComputedStyle(candidate);
            const rect = candidate.getBoundingClientRect();
            return style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity) > 0
                && rect.width > 0 && rect.height > 0
                && rect.bottom > 0 && rect.right > 0 && rect.top < innerHeight && rect.left < innerWidth;
        });
        if (!item) return null;
        const rect = item.getBoundingClientRect();
        return {
            x: rect.left + rect.width / 2,
            y: rect.top + rect.height / 2,
            disabled: item.matches(':disabled') || item.getAttribute('aria-disabled') === 'true',
            width: rect.width,
            height: rect.height,
        };
    })()`);
    if (!target || target.disabled) return { touched: false, target };
    await touchPoint(target.x, target.y);
    return { touched: true, target };
}

async function typeIntoSelector(selector, value) {
    if (!(await focusSelector(selector))) return false;
    return typeIntoFocusedControl(value);
}

async function typeIntoFocusedControl(value) {
    await request('Input.dispatchKeyEvent', {
        type: 'rawKeyDown', key: 'a', code: 'KeyA', modifiers: 2,
        windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65, commands: ['SelectAll'],
    });
    await request('Input.dispatchKeyEvent', {
        type: 'keyUp', key: 'a', code: 'KeyA', modifiers: 2,
        windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65,
    });
    await request('Input.insertText', { text: value });
    return true;
}

async function focusPromptControl() {
    const target = await evaluate(`(() => {
        const active = document.activeElement;
        const title = [...document.querySelectorAll('body *')].find((item) => item.textContent?.trim() === '从这里重新编辑');
        let modal = title;
        while (modal && !modal.querySelector?.('input:not([type="file"]), textarea')) modal = modal.parentElement;
        const input = modal?.querySelector?.('input:not([type="file"]), textarea')
            || (((active instanceof HTMLInputElement && active.type !== 'file') || active instanceof HTMLTextAreaElement) ? active : null);
        if (!input) return null;
        input.scrollIntoView({ block: 'center', inline: 'center' });
        const rect = input.getBoundingClientRect();
        return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    })()`);
    if (!target) return false;
    await request('Input.dispatchMouseEvent', { type: 'mousePressed', x: target.x, y: target.y, button: 'left', buttons: 1, clickCount: 1 });
    await request('Input.dispatchMouseEvent', { type: 'mouseReleased', x: target.x, y: target.y, button: 'left', buttons: 0, clickCount: 1 });
    return true;
}

async function pressEnter() {
    await request('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter' });
    await request('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter' });
}

try {
    const activePort = await waitFor(
        () => {
            if (!existsSync(activePortFile)) return undefined;
            return Number(readFileSync(activePortFile, 'utf8').split('\n')[0]);
        },
        15_000,
        'Chromium DevTools port',
    );

    await waitFor(
        async () => {
            try {
                const targets = await fetch(`http://127.0.0.1:${activePort}/json/list`).then((res) => res.json());
                return targets.some((entry) => entry.type === 'page');
            } catch {
                return undefined;
            }
        },
        10_000,
        'browser page target',
    );

    // Persistent acceptance profiles can contain crash-restored tabs from a
    // previous run. Always create and own one fresh target so input never lands
    // in an unrelated background page.
    const target = await fetch(`http://127.0.0.1:${activePort}/json/new?about%3Ablank`, { method: 'PUT' })
        .then((res) => {
            if (!res.ok) throw new Error(`Unable to create browser target: ${res.status}`);
            return res.json();
        });
    const oldTargets = await fetch(`http://127.0.0.1:${activePort}/json/list`).then((res) => res.json());
    await Promise.all(oldTargets
        .filter((entry) => entry.type === 'page' && entry.id !== target.id)
        .map((entry) => fetch(`http://127.0.0.1:${activePort}/json/close/${entry.id}`).catch(() => undefined)));

    socket = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
        socket.addEventListener('open', resolve, { once: true });
        socket.addEventListener('error', reject, { once: true });
    });

    socket.addEventListener('close', () => { for (const item of pending.values()) item.reject(new Error('Browser target disconnected')); pending.clear(); });
    socket.addEventListener('message', (event) => {
        const message = JSON.parse(event.data);
        if (message.id) {
            const item = pending.get(message.id);
            if (!item) return;
            pending.delete(message.id);
            if (message.error) item.reject(new Error(`${item.method}: ${message.error.message}`));
            else item.resolve(message.result || {});
            return;
        }

        if (message.method === 'Page.screencastFrame') {
            if (screencastDir && screencastFrames.length < 1800 && (!screencastFrames.length || message.params.metadata.timestamp - screencastFrames.at(-1).timestamp >= 0.2)) {
                const path = join(screencastDir, String(screencastFrames.length).padStart(6, '0') + '.jpg');
                writeFileSync(path, Buffer.from(message.params.data, 'base64'), { mode: 0o600 });
                screencastFrames.push({ path, timestamp: message.params.metadata.timestamp });
            }
            void request('Page.screencastFrameAck', { sessionId: message.params.sessionId }).catch(() => undefined);
        }
        if (message.method === 'HeapProfiler.addHeapSnapshotChunk' && heapFd !== undefined) writeSync(heapFd, message.params.chunk);
        if (message.method === 'Runtime.exceptionThrown') {
            runtimeErrors.push(message.params.exceptionDetails?.text || 'Uncaught browser exception');
        }
        if (message.method === 'Runtime.executionContextCreated') {
            executionContexts.push(message.params.context);
        }
        if (message.method === 'Runtime.executionContextDestroyed') {
            const index = executionContexts.findIndex((context) => context.id === message.params.executionContextId);
            if (index >= 0) executionContexts.splice(index, 1);
        }
        if (message.method === 'Target.attachedToTarget') {
            attachedTargets.push({ sessionId: message.params.sessionId, targetInfo: message.params.targetInfo });
        }
        if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') {
            runtimeErrors.push(
                message.params.args.map((item) => item.value || item.description || '').join(' '),
            );
        }
        if (message.method === 'Network.loadingFailed' && !message.params.canceled) {
            failedRequests.push(`${message.params.errorText}${message.params.blockedReason ? ` [blocked:${message.params.blockedReason}]` : ''}: ${message.params.requestId}`);
        }
        if (message.method === 'Network.requestWillBeSent' && message.params.request.url.includes('/v1/auth/')) {
            const requestUrl = new URL(message.params.request.url);
            authTraffic.push({ phase: 'request', method: message.params.request.method, origin: requestUrl.origin, path: requestUrl.pathname });
        }
        if (message.method === 'Network.requestWillBeSent') {
            const requestUrl = new URL(message.params.request.url);
            if (requestUrl.protocol.startsWith('http') && requestUrl.origin !== new URL(url).origin && externalRequestAttempts.length < 500) externalRequestAttempts.push({ origin: requestUrl.origin, path: requestUrl.pathname });
            if (requestUrl.pathname === '/v1/sessions/deletion-scan'
                || requestUrl.pathname === '/v1/sessions/delete'
                || requestUrl.pathname.startsWith('/v1/conversations/')) {
                deletionTraffic.push({
                    phase: 'request',
                    method: message.params.request.method,
                    path: requestUrl.pathname,
                    cursorPresent: requestUrl.searchParams.has('cursor'),
                });
            }
        }
        if (message.method === 'Network.responseReceived') {
            const response = message.params.response;
            const mimeType = response.mimeType || '';
            if (networkEvidence.length < 5000) {
                const evidenceUrl = new URL(response.url);
                networkEvidence.push({ time: message.params.timestamp, origin: evidenceUrl.origin, path: evidenceUrl.pathname.replace(/(\/__hapla_workspace_stream\/)[a-f0-9]+/, '$1<grant>'), status: response.status, type: message.params.type, mimeType, bytes: response.encodedDataLength, fromServiceWorker: response.fromServiceWorker === true });
            }
            if (message.params.type === 'Media' || /^(audio|video)\//i.test(mimeType)) {
                mediaResponses.push({
                    url: response.url,
                    status: response.status,
                    mimeType,
                    acceptRanges: response.headers?.['accept-ranges'] ?? response.headers?.['Accept-Ranges'],
                    contentRange: response.headers?.['content-range'] ?? response.headers?.['Content-Range'],
                    contentLength: response.headers?.['content-length'] ?? response.headers?.['Content-Length'],
                });
            }
            if (response.url.includes('/v1/auth/')) {
                const responseUrl = new URL(response.url);
                const traffic = { phase: 'response', status: response.status, origin: responseUrl.origin, path: responseUrl.pathname };
                authTraffic.push(traffic);
                if (responseUrl.pathname === '/v1/auth/request/status') {
                    void request('Network.getResponseBody', { requestId: message.params.requestId }).then((body) => {
                        try {
                            const parsed = JSON.parse(body.body);
                            traffic.body = { status: parsed.status, supportsV2: parsed.supportsV2 };
                        } catch {
                            traffic.body = { unreadable: true };
                        }
                    }).catch(() => undefined);
                }
            }
            const responseUrl = new URL(response.url);
            if (responseUrl.pathname === '/v1/sessions/deletion-scan'
                || responseUrl.pathname === '/v1/sessions/delete'
                || responseUrl.pathname.startsWith('/v1/conversations/')) {
                const traffic = { phase: 'response', status: response.status, path: responseUrl.pathname };
                deletionTraffic.push(traffic);
                void request('Network.getResponseBody', { requestId: message.params.requestId }).then((body) => {
                    try {
                        const parsed = JSON.parse(body.body);
                        traffic.body = responseUrl.pathname === '/v1/sessions/deletion-scan'
                            ? {
                                sessionCount: Array.isArray(parsed.sessions) ? parsed.sessions.length : null,
                                hasNext: parsed.hasNext === true,
                                nextCursorPresent: typeof parsed.nextCursor === 'string',
                            }
                            : { success: parsed.success === true, deletedCount: parsed.deletedCount };
                    } catch {
                        traffic.body = { unreadable: true };
                    }
                }).catch(() => undefined);
            }
        }
        if (message.method === 'Browser.downloadWillBegin') {
            downloads.push({
                guid: message.params.guid,
                url: message.params.url,
                suggestedFilename: message.params.suggestedFilename,
                state: 'inProgress',
            });
        }
        if (message.method === 'Browser.downloadProgress') {
            const item = downloads.find((download) => download.guid === message.params.guid);
            if (item) Object.assign(item, {
                state: message.params.state,
                receivedBytes: message.params.receivedBytes,
                totalBytes: message.params.totalBytes,
            });
        }
        if (message.method === 'Debugger.scriptParsed' && message.params.url) {
            loadedScripts.push(message.params.url);
        }
    });

    await Promise.all([
        request('Page.enable'),
        request('Runtime.enable'),
        request('Network.enable'),
        request('Debugger.enable'),
        request('DOM.enable'),
        request('Performance.enable'),
        request('Accessibility.enable'),
        request('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }),
        ...(disableNativeSavePicker ? [request('Page.addScriptToEvaluateOnNewDocument', {
            source: `Object.defineProperty(globalThis, 'showSaveFilePicker', { configurable: true, get: () => undefined });`,
        })] : []),
        ...(downloadDir ? [request('Browser.setDownloadBehavior', {
            behavior: 'allow',
            downloadPath: downloadDir,
            eventsEnabled: true,
        })] : []),
        request('Emulation.setDeviceMetricsOverride', {
            width,
            height,
            deviceScaleFactor: 2,
            mobile: width < 768,
        }),
        request('Emulation.setTouchEmulationEnabled', {
            enabled: width < 768,
            maxTouchPoints: width < 768 ? 5 : 1,
        }),
        ...(colorScheme ? [request('Emulation.setEmulatedMedia', {
            features: [{ name: 'prefers-color-scheme', value: colorScheme }],
        })] : []),
    ]);

    await request('Page.navigate', { url });
    await waitFor(
        () => evaluate(`document.readyState === 'complete' && (${JSON.stringify(allowEmptyBody)} || document.body?.innerText?.trim().length > 0)`),
        60_000,
        'rendered application',
    );
    await sleep(2_000);
    await request('HeapProfiler.collectGarbage').catch(() => undefined);
    initialCdpMetrics = {
        performance: pickPerformanceMetrics((await request('Performance.getMetrics')).metrics),
        dom: await request('Memory.getDOMCounters'),
    };
    if (sampleMemory) memorySampleTimer = setInterval(async () => {
        if (memorySamplePending || performanceSamples.length >= 1200) return;
        memorySamplePending = true;
        try { performanceSamples.push({ at: Date.now(), ...pickPerformanceMetrics((await request('Performance.getMetrics')).metrics) }); }
        catch { /* Terminal disconnect is recorded by the main driver. */ }
        finally { memorySamplePending = false; }
    }, 200);

    if (restoreAccount) {
        if (!recoveryKey) throw new Error('HAPLA_SMOKE_RECOVERY_KEY is required with --restore-account');
        const restoreEntryClicked = await clickControl('Restore Account');
        if (!restoreEntryClicked) throw new Error('Restore Account entry button was not found');
        await waitFor(
            () => evaluate(`Boolean(document.querySelector('textarea[placeholder="XXXXX-XXXXX-XXXXX..."]'))`),
            10_000,
            'recovery key input',
        );
        const filled = await typeIntoSelector('textarea[placeholder="XXXXX-XXXXX-XXXXX..."]', recoveryKey);
        if (!filled) throw new Error('Recovery key input could not be filled');
        const restoreSubmitted = await clickControl('Restore Account');
        if (!restoreSubmitted) throw new Error('Restore Account submit button was not found');
        await waitFor(
            () => evaluate(`Boolean(localStorage.getItem('auth_credentials'))`),
            20_000,
            'restored account credentials',
        );
        await sleep(2_000);
    }

    let accepted = false;
    if (shouldAccept) {
        await waitFor(
            () => evaluate(`document.body?.innerText?.includes('Accept Connection')`),
            30_000,
            'Accept Connection control',
        );
        accepted = await clickControl('Accept Connection');
        if (!accepted) throw new Error('Accept Connection control was not found');
        await sleep(4_000);

        if (afterUrl) {
            await clickControl('OK');
            await request('Page.navigate', { url: afterUrl });
            await waitFor(
                () => evaluate(`document.readyState === 'complete' && document.body?.innerText?.trim().length > 0`),
                30_000,
                'post-accept application',
            );
            await sleep(3_000);
        }
    }

    let previewFailureRecovery = null;
    const injectedPreviewFailures = new Set();
    if (failPreviewOnce) await request('Network.setBlockedURLs', { urls: ['*__hapla_workspace_stream/*'] });
    if (targetUrl) {
        await request('Page.navigate', { url: targetUrl });
        await waitFor(
            () => evaluate(`document.readyState === 'complete' && document.body?.innerText?.trim().length > 0`),
            30_000,
            'target application',
        );
        await sleep(3_000);
    }
    if (failPreviewOnce) {
        await waitFor(() => evaluate(`Boolean(document.querySelector('[aria-label="重试媒体预览"]'))`), waitTimeout, 'visible preview error and retry');
        const errorText = await evaluate(`document.body.innerText`);
        for (const failure of failedRequests) {
            if (failure.includes('ERR_BLOCKED_BY_CLIENT') || failure.includes('[blocked:inspector]')) injectedPreviewFailures.add(failure);
        }
        const failureScreenshot = screenshot.replace(/\.png$/, '-failure.png');
        writeFileSync(failureScreenshot, Buffer.from((await request('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
        await request('Network.setBlockedURLs', { urls: [] });
        if (!await clickControl('重试媒体预览')) throw new Error('Preview retry was not clickable after injected media failure');
        previewFailureRecovery = { injected: 'CDP Network.setBlockedURLs for workspace stream only',
            visibleError: /无法加载/.test(errorText), retryClicked: true,
            expectedNetworkFailures: [...injectedPreviewFailures], failureScreenshot };
    }

    let newSessionEntryObservation = null;
    if (exerciseNewSessionEntry) {
        const firstStartedAt = Date.now();
        const firstTouch = await touchControl('New session');
        if (!firstTouch.touched) throw new Error('Visible enabled New session control was not available for first touch');
        await waitFor(() => evaluate(`location.pathname === '/new'`), 5_000, 'new session route after first touch');
        const firstLatencyMs = Date.now() - firstStartedAt;

        const backTouch = await waitFor(async () => {
            const result = await touchControl('Back');
            return result.touched ? result : null;
        }, 5_000, 'visible Back control after opening new session');
        await waitFor(() => evaluate(`location.pathname === '/'`), 5_000, 'home route after Back touch');

        const secondStartedAt = Date.now();
        const secondTouch = await touchControl('New session');
        if (!secondTouch.touched) throw new Error('New session control remained disabled after returning home');
        await waitFor(() => evaluate(`location.pathname === '/new'`), 5_000, 'new session route after immediate second touch');
        const secondLatencyMs = Date.now() - secondStartedAt;

        newSessionEntryObservation = {
            ok: true,
            input: 'touch',
            first: { touches: 1, latencyMs: firstLatencyMs, target: firstTouch.target },
            returnedWith: { touches: 1, target: backTouch.target },
            second: { touches: 1, latencyMs: secondLatencyMs, target: secondTouch.target },
        };
        await sleep(500);
    }

    if (waitBeforeClickText) {
        await waitFor(
            () => evaluate(`document.body?.innerText?.includes(${JSON.stringify(waitBeforeClickText)})`),
            waitTimeout,
            `pre-click page text ${JSON.stringify(waitBeforeClickText)}`,
        );
    }

    if (clickText) {
        const clickSteps = clickText.split('>>');
        for (const [index, requestedText] of clickSteps.entries()) {
            if (waitBeforeFinalClickText && index === clickSteps.length - 1) {
                await waitFor(
                    () => evaluate(`document.body?.innerText?.includes(${JSON.stringify(waitBeforeFinalClickText)})`),
                    waitTimeout,
                    `pre-final-click page text ${JSON.stringify(waitBeforeFinalClickText)}`,
                );
            }
            await waitFor(
                () => clickControl(requestedText, index === 0 ? clickOccurrence : 1),
                waitTimeout,
                `visible control ${JSON.stringify(requestedText)}`,
            );
            await sleep(4_000);
        }
    }

    let environmentObservation = null;
    if (environmentKey || environmentValue) {
        if (!environmentKey || environmentValue === undefined) {
            throw new Error('env-key and env-value must be provided together');
        }
        const keyFilled = await typeIntoSelector('input[placeholder="OPENAI_BASE_URL"]', environmentKey);
        const valueFilled = await typeIntoSelector('input[placeholder="value"]', environmentValue);
        if (!keyFilled || !valueFilled) throw new Error('Environment variable inputs were not found');
        const persistedBeforeSend = await evaluate(`(() => {
            const needle = ${JSON.stringify(environmentValue)};
            return [...Object.values(localStorage), ...Object.values(sessionStorage)]
                .some((value) => String(value).includes(needle));
        })()`);
        environmentObservation = {
            key: environmentKey,
            filledThroughKeyboard: true,
            secretPersistedBeforeSend: persistedBeforeSend,
            secretPersistedAfterSend: null,
        };
    }

    if (clickPointValue) {
        const [x, y] = clickPointValue;
        if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('click-point must be x,y');
        await clickPoint(x, y);
        await sleep(4_000);
    }

    if (touchPointValue) {
        const [x, y] = touchPointValue;
        if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('touch-point must be x,y');
        await touchPoint(x, y);
        await sleep(4_000);
    }


    if (projectPath) {
        const filled = await typeIntoSelector('input[placeholder="Enter project path"]', projectPath);
        if (!filled) throw new Error('Project path input was not found');
        await pressEnter();
        await waitFor(
            () => evaluate(`!document.querySelector('input[placeholder="Enter project path"]')`),
            10_000,
            'project path picker to close',
        );
        await sleep(2_000);
    }

    if (screencastDir) await request('Page.startScreencast', { format: 'jpeg', quality: 65, maxWidth: width, maxHeight: height, everyNthFrame: 3 });
    let streamObservation = null;
    let activityObservation = null;
    let activityScreenshotObservation = null;
    let branchSwitchDuringRun = null;
    if (uploadFiles.length) {
        if (!Array.isArray(uploadFiles) || uploadFiles.some((file) => typeof file !== 'string' || !existsSync(file))) throw new Error('Upload fixtures must be existing local paths');
        await waitFor(() => clickControl('添加附件'), waitTimeout, 'attachment picker');
        const document = await request('DOM.getDocument');
        const input = await request('DOM.querySelector', { nodeId: document.root.nodeId, selector: 'input[aria-label="选择附件文件"]' });
        if (!input.nodeId) throw new Error('Attachment file input was not found');
        await request('DOM.setFileInputFiles', { nodeId: input.nodeId, files: uploadFiles });
        await sleep(500);
    }
    if (messageText) {
        const filled = await typeIntoSelector(
            'textarea[placeholder="Type a message ..."], textarea[placeholder="What would you like to work on?"]',
            messageText,
        );
        if (!filled) throw new Error('Message input was not found');
        await waitFor(
            () => evaluate(`Boolean(document.querySelector('[aria-label="Send message"]:not([disabled]), [aria-label="Start session"]:not([disabled])'))`),
            10_000,
            'enabled send button',
        );
        const sent = await clickControl('Start session') || await clickControl('Send message');
        if (!sent) throw new Error('Enabled send button was not found');
        if (stopDuringRun) {
            const startedAt = Date.now();
            stopObservation = { ok: false, input: 'mouse', afterText: stopAfterText ?? null, timeline: [] };
            const sampleStopState = async (phase) => {
                const sample = await evaluate(`(() => {
                    const text = document.body?.innerText || '';
                    const isVisible = (node) => {
                        const rect = node.getBoundingClientRect();
                        const style = getComputedStyle(node);
                        return rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.top < innerHeight
                            && rect.right > 0 && rect.left < innerWidth && style.visibility !== 'hidden' && style.display !== 'none';
                    };
                    // Read the live status control, not matching text inside conversation history.
                    const statuses = [...new Set([...document.querySelectorAll('[aria-label^="Codex · "]')]
                        .filter(isVisible).map((node) => node.getAttribute('aria-label').trim().slice(0, 160)))].slice(0, 8);
                    const marker = ${JSON.stringify(stopAfterText ?? null)};
                    // CommandView renders output as siblings of its "$ command" row.
                    // A marker in the submitted prompt or echoed command is not output evidence.
                    const markerVisible = marker === null || [...document.querySelectorAll('body *')].some((node) => {
                        if (node.childElementCount > 0 || node.textContent?.trim() !== '$') return false;
                        const commandLine = node.parentElement;
                        const terminal = commandLine?.parentElement;
                        return [...(terminal?.children || [])].some((output) => {
                            if (output === commandLine || !output.textContent?.includes(marker)) return false;
                            return isVisible(output);
                        });
                    });
                    return {
                        statuses, markerVisible,
                        interrupted: statuses.includes('Codex · 已中断'),
                        failure: statuses.find((status) => /中断失败|运行状态异常|执行失败/.test(status))
                            || (/Codex interruption was not confirmed|Failed to abort|中断失败/.test(text) ? 'Stop request failed' : null),
                        running: statuses.some((status) => /Codex · (?:思考中|正在(?:初始化任务|分析问题|制定计划|搜索|读取|执行|运行测试|修改文件|调用工具|生成媒体|压缩上下文|审查更改|输出回复|处理))/.test(status)),
                    };
                })()`);
                const entry = { elapsedMs: Date.now() - startedAt, phase, statuses: sample.statuses, markerVisible: sample.markerVisible };
                const previous = stopObservation.timeline.at(-1);
                if (!previous || previous.phase !== phase || previous.markerVisible !== entry.markerVisible
                    || JSON.stringify(previous.statuses) !== JSON.stringify(entry.statuses)) {
                    stopObservation.timeline.push(entry);
                    if (stopObservation.timeline.length > 40) stopObservation.timeline.splice(1, 1);
                }
                return sample;
            };
            await waitFor(
                async () => (await sampleStopState('before-stop')).running,
                15_000,
                'visible Codex running state before stop',
            );
            if (stopAfterText) {
                await waitFor(async () => {
                    const sample = await sampleStopState('waiting-for-output');
                    if (sample.failure) throw new Error(sample.failure);
                    return sample.running && sample.markerVisible;
                }, waitTimeout, `visible command output ${JSON.stringify(stopAfterText)} before stop`);
            }
            if (stopAfterActivity) await waitFor(async () => {
                const sample = await sampleStopState('waiting-for-activity');
                return sample.statuses.some(status => status.includes(stopAfterActivity));
            }, waitTimeout, 'stop activity ' + stopAfterActivity);
            stopObservation.activity = stopAfterActivity ?? null;
            stopObservation.clickStartedAtUnixMs = Date.now();
            const stopped = await clickControl('Stop current response');
            if (!stopped) throw new Error('Stop current response control was not found');
            stopObservation.clickedAtMs = Date.now() - startedAt;
            const settled = await waitFor(
                async () => {
                    const sample = await sampleStopState('after-stop');
                    if (sample.failure) throw new Error(sample.failure);
                    return sample.interrupted;
                },
                30_000,
                'authoritative visible Codex · 已中断 status after stop',
            );
            stopObservation.ok = stopped && settled === true;
            stopObservation.completedAtMs = Date.now() - startedAt;
            stopObservation.completedAtUnixMs = Date.now();
            await sleep(1_000);
        } else if (clickDuringRun) {
            await waitFor(
                () => evaluate(`/Codex · (?:思考中|正在(?:初始化任务|分析问题|制定计划|搜索|读取|执行|运行测试|修改文件|调用工具|生成媒体|压缩上下文|审查更改|输出回复|处理))/.test(document.body?.innerText || '')`),
                15_000,
                'visible Codex running state',
            );
            const clicked = await clickControl(clickDuringRun);
            if (!clicked) throw new Error(`Running branch control was not found: ${clickDuringRun}`);
            await waitFor(
                () => evaluate(`document.body?.innerText?.includes('切换对话分支？')`),
                10_000,
                'stop-and-switch confirmation',
            );
            const confirmed = await clickControl('停止并切换');
            if (!confirmed) throw new Error('Stop-and-switch confirmation control was not found');
            await waitFor(
                () => evaluate(`[...document.querySelectorAll('[aria-pressed="true"]')].some((item) => item.textContent?.includes(${JSON.stringify(clickDuringRun)}))`),
                30_000,
                'selected target branch after stopping current run',
            );
            branchSwitchDuringRun = { ok: true, target: clickDuringRun };
            await sleep(1_000);
        } else if (observeStreamStart && observeStreamEnd) {
            const startedAt = Date.now();
            const samples = [];
            const activitySamples = [];
            let sawPartialReply = false;
            let sawThinking = false;
            let sawOutput = false;
            await waitFor(async () => {
                const sample = await evaluate(`(() => {
                    const text = document.body?.innerText || '';
                    const count = (needle) => text.split(needle).length - 1;
                    return {
                        length: text.length,
                        startCount: count(${JSON.stringify(observeStreamStart)}),
                        endCount: count(${JSON.stringify(observeStreamEnd)}),
                        thinking: text.includes('Codex · 思考中'),
                        output: text.includes('Codex · 正在输出'),
                        activities: [...new Set(text.match(/Codex · [^\\n]+/g) || [])],
                    };
                })()`);
                sawPartialReply ||= sample.startCount >= 2 && sample.endCount < 2;
                sawThinking ||= sample.thinking;
                sawOutput ||= sample.output;
                for (const activity of sample.activities) {
                    if (!activitySamples.includes(activity)) activitySamples.push(activity);
                }
                if (
                    activityScreenshotText
                    && activityScreenshotPath
                    && !activityScreenshotObservation
                    && sample.activities.some((activity) => activity.includes(activityScreenshotText))
                ) {
                    const captured = await request('Page.captureScreenshot', {
                        format: 'png',
                        captureBeyondViewport: false,
                    });
                    writeFileSync(activityScreenshotPath, Buffer.from(captured.data, 'base64'));
                    activityScreenshotObservation = { ok: true, text: activityScreenshotText, screenshot: activityScreenshotPath };
                }
                if (samples.length === 0 || samples.at(-1).length !== sample.length || samples.at(-1).output !== sample.output) {
                    samples.push({ ms: Date.now() - startedAt, ...sample });
                }
                return sample.endCount >= 2;
            }, waitTimeout, 'streamed assistant reply');
            streamObservation = {
                ok: sawPartialReply && sawOutput && samples.length >= 3,
                sawPartialReply,
                sawThinking,
                sawOutput,
                distinctRenderSamples: samples.length,
                samples: samples.slice(0, 24),
            };
            activityObservation = {
                samples: activitySamples,
                expected: expectedActivities,
                missing: expectedActivities.filter((activity) => !activitySamples.some((sample) => sample.includes(activity))),
            };
            activityObservation.ok = activityObservation.missing.length === 0 && activitySamples.length >= 2;
            await sleep(1_000);
        } else {
            await sleep(5_000);
        }
    }

    if (waitText) {
        await waitFor(
            () => evaluate(`((document.body?.innerText || '').split(${JSON.stringify(waitText)}).length - 1) >= ${waitTextCount}`),
            waitTimeout,
            `page text ${JSON.stringify(waitText)}`,
        );
        await sleep(1_000);
    }

    let sessionDeleteObservation = null;
    if (exerciseDeleteCurrentSession) {
        const target = await evaluate(`(() => {
            const parts = location.pathname.split('/');
            return parts[1] === 'session' && parts[2]
                ? { id: decodeURIComponent(parts[2]), url: location.href }
                : null;
        })()`);
        if (!target) throw new Error('Current page is not a session and cannot exercise deletion');

        const infoUrl = `${new URL(url).origin}/session/${encodeURIComponent(target.id)}/info`;
        await request('Page.navigate', { url: infoUrl });
        await waitFor(
            () => evaluate(`(document.body?.innerText || '').includes('Delete Session')`),
            30_000,
            'visible session delete entry',
        );
        const deleteEntryClicked = await clickControl('Delete Session');
        if (!deleteEntryClicked) throw new Error('Session delete entry was not clickable');
        await waitFor(
            () => evaluate(`(() => {
                const text = document.body?.innerText || '';
                return text.includes('Delete Session Permanently?') || text.includes('永久删除会话？');
            })()`),
            10_000,
            'delete confirmation dialog',
        );
        const deleteConfirmed = await clickControl('Delete Session');
        if (!deleteConfirmed) throw new Error('Delete confirmation button was not clickable');
        await waitFor(
            () => evaluate(`location.pathname === '/'`),
            30_000,
            'home route after confirmed deletion',
        );

        await request('Page.navigate', { url: target.url });
        const absentAfterReload = await waitFor(
            () => evaluate(`(() => {
                const text = document.body?.innerText || '';
                return text.includes('Session has been deleted') || text.includes('会话已被删除');
            })()`),
            30_000,
            'deleted session state after full reload',
        );

        sessionDeleteObservation = {
            ok: deleteEntryClicked && deleteConfirmed && absentAfterReload === true,
            input: 'visible-buttons',
            sessionId: target.id,
            confirmed: true,
            absentAfterReload: absentAfterReload === true,
        };
        await request('Page.navigate', { url });
        await waitFor(
            () => evaluate(`location.pathname === '/' && document.readyState === 'complete'`),
            30_000,
            'home page after deletion verification',
        );
        await sleep(2_000);
    }

    if (waitIframe) {
        await waitFor(
            () => evaluate(`[...document.querySelectorAll('iframe')].some((frame) => frame.title.includes(${JSON.stringify(waitIframe)}) && frame.srcdoc.length > 0)`),
            waitTimeout,
            `embedded frame ${JSON.stringify(waitIframe)}`,
        );
        await sleep(2_000);
    }

    let iframeClickExercise = null;
    if (iframeClickText) {
        const iframeDebug = [];
        const frameBox = await evaluate(`(() => {
            const frame = document.querySelector('iframe');
            if (!frame) return null;
            const box = frame.getBoundingClientRect();
            return { x: box.left, y: box.top };
        })()`);
        if (!frameBox) throw new Error('iframe was not found for click');
        let target = null;
        for (const context of executionContexts) {
            const found = await request('Runtime.evaluate', {
                contextId: context.id,
                expression: `(() => {
                    const expected = ${JSON.stringify(iframeClickText)};
                    const item = [...document.querySelectorAll('button,[role="button"]')].find((node) => (node.textContent || '').includes(expected));
                    if (!item) return null;
                    item.scrollIntoView({ block: 'center', inline: 'center' });
                    const box = item.getBoundingClientRect();
                    return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
                })()`,
                returnByValue: true,
            }).catch(() => null);
            iframeDebug.push({ contextId: context.id, name: context.name, found: Boolean(found?.result?.value) });
            if (found?.result?.value) {
                target = { contextId: context.id, ...found.result.value };
                break;
            }
        }
        if (!target) {
            const frameTree = await request('Page.getFrameTree');
            const childFrameIds = [];
            const collectFrames = (node) => {
                for (const child of node?.childFrames || []) {
                    childFrameIds.push(child.frame.id);
                    collectFrames(child);
                }
            };
            collectFrames(frameTree.frameTree);
            for (const frameId of childFrameIds) {
                const world = await request('Page.createIsolatedWorld', {
                    frameId,
                    worldName: `hapla-acceptance-${Date.now()}`,
                    grantUniveralAccess: false,
                }).catch(() => null);
                if (!world?.executionContextId) continue;
                const found = await request('Runtime.evaluate', {
                    contextId: world.executionContextId,
                    expression: `(() => {
                        const expected = ${JSON.stringify(iframeClickText)};
                        const item = [...document.querySelectorAll('button,[role="button"]')].find((node) => (node.textContent || '').includes(expected));
                        if (!item) return null;
                        item.scrollIntoView({ block: 'center', inline: 'center' });
                        const box = item.getBoundingClientRect();
                        return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
                    })()`,
                    returnByValue: true,
                }).catch(() => null);
                const debugText = await request('Runtime.evaluate', {
                    contextId: world.executionContextId,
                    expression: `({ title: document.title, text: (document.body?.innerText || '').slice(0, 120), buttons: document.querySelectorAll('button').length })`,
                    returnByValue: true,
                }).catch(() => null);
                iframeDebug.push({ frameId, contextId: world.executionContextId, document: debugText?.result?.value, found: Boolean(found?.result?.value) });
                if (found?.result?.value) {
                    target = { contextId: world.executionContextId, ...found.result.value };
                    break;
                }
            }
        }
        if (!target) {
            for (const attached of attachedTargets) {
                await request('Runtime.enable', {}, attached.sessionId).catch(() => undefined);
                const found = await request('Runtime.evaluate', {
                    expression: `(() => {
                        const expected = ${JSON.stringify(iframeClickText)};
                        const item = [...document.querySelectorAll('button,[role="button"]')].find((node) => (node.textContent || '').includes(expected));
                        if (!item) return null;
                        item.scrollIntoView({ block: 'center', inline: 'center' });
                        const box = item.getBoundingClientRect();
                        return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
                    })()`,
                    returnByValue: true,
                }, attached.sessionId).catch(() => null);
                iframeDebug.push({ attachedTarget: attached.targetInfo.type, url: attached.targetInfo.url, found: Boolean(found?.result?.value) });
                if (found?.result?.value) {
                    target = { sessionId: attached.sessionId, ...found.result.value };
                    break;
                }
            }
        }
        if (!target) throw new Error(`iframe control was not found: ${iframeClickText}; ${JSON.stringify(iframeDebug)}`);
        const clickX = frameBox.x + target.x;
        const clickY = frameBox.y + target.y;
        await clickPoint(clickX, clickY);
        await request('Input.dispatchTouchEvent', {
            type: 'touchStart',
            touchPoints: [{ x: clickX, y: clickY, radiusX: 1, radiusY: 1, force: 1 }],
        });
        await request('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
        if (target.sessionId) {
            await request('Input.dispatchMouseEvent', {
                type: 'mousePressed', x: target.x, y: target.y, button: 'left', buttons: 1, clickCount: 1,
            }, target.sessionId);
            await request('Input.dispatchMouseEvent', {
                type: 'mouseReleased', x: target.x, y: target.y, button: 'left', buttons: 0, clickCount: 1,
            }, target.sessionId);
        }
        if (iframeWaitText || (iframeWaitSelector && iframeWaitValue !== undefined)) {
            await waitFor(async () => {
                // A srcdoc frame may replace its execution context immediately
                // after the click. Re-resolve the live child frame instead of
                // polling the now-destroyed context captured above.
                const frameTree = await request('Page.getFrameTree').catch(() => null);
                const frameIds = [];
                const collect = (node) => {
                    for (const child of node?.childFrames || []) {
                        frameIds.push(child.frame.id);
                        collect(child);
                    }
                };
                collect(frameTree?.frameTree);
                for (const frameId of frameIds) {
                    const world = await request('Page.createIsolatedWorld', {
                        frameId,
                        worldName: `hapla-observe-${Date.now()}`,
                        grantUniveralAccess: false,
                    }).catch(() => null);
                    if (!world?.executionContextId) continue;
                    const observed = await request('Runtime.evaluate', {
                        contextId: world.executionContextId,
                        expression: iframeWaitSelector && iframeWaitValue !== undefined
                            ? `document.querySelector(${JSON.stringify(iframeWaitSelector)})?.textContent?.trim() === ${JSON.stringify(iframeWaitValue)}`
                            : `document.body?.innerText?.includes(${JSON.stringify(iframeWaitText)})`,
                        returnByValue: true,
                    }).catch(() => null);
                    if (observed?.result?.value === true) return true;
                }
                // Sandboxed srcdoc frames may be promoted to out-of-process
                // iframe targets. Their DOM is not observable through the
                // parent Page domain, so inspect the attached target session
                // as well before declaring the visible interaction a failure.
                for (const attached of attachedTargets) {
                    const observed = await request('Runtime.evaluate', {
                        expression: iframeWaitSelector && iframeWaitValue !== undefined
                            ? `document.querySelector(${JSON.stringify(iframeWaitSelector)})?.textContent?.trim() === ${JSON.stringify(iframeWaitValue)}`
                            : `document.body?.innerText?.includes(${JSON.stringify(iframeWaitText)})`,
                        returnByValue: true,
                    }, attached.sessionId).catch(() => null);
                    if (observed?.result?.value === true) return true;
                }
                return false;
            }, waitTimeout, iframeWaitSelector
                ? `iframe ${iframeWaitSelector} value ${JSON.stringify(iframeWaitValue)}`
                : `iframe text ${JSON.stringify(iframeWaitText)}`);
        }
        iframeClickExercise = {
            ok: true,
            input: 'mouse',
            clicked: iframeClickText,
            observed: iframeWaitSelector ? { selector: iframeWaitSelector, value: iframeWaitValue } : iframeWaitText,
        };
        await sleep(1_000);
    }

    if (waitMedia) {
        const selector = waitMedia === 'audio' ? 'audio' : waitMedia === 'video' ? 'video' : waitMedia === 'image' ? 'img' : waitMedia;
        await waitFor(
            () => evaluate(`(() => {
                const media = document.querySelector(${JSON.stringify(selector)});
                if (!media) return false;
                if (media instanceof HTMLImageElement) return media.complete && media.naturalWidth > 0 && media.naturalHeight > 0;
                if (media instanceof HTMLMediaElement) return media.readyState >= HTMLMediaElement.HAVE_METADATA;
                return true;
            })()`),
            waitTimeout,
            `${waitMedia} media to load and decode`,
        );
        await sleep(1_000);
    }

    let mediaExercise = null;
    if (exerciseMedia) {
        mediaExercise = await evaluate(`(async () => {
            const selector = ${JSON.stringify(exerciseMedia)} === 'audio' ? 'audio[controls]' : 'video[controls]';
            const media = document.querySelector(selector);
            if (!media) return { ok: false, reason: 'controlled media element not found' };
            try {
                await media.play();
                await new Promise((resolve) => setTimeout(resolve, 350));
                const playedTime = media.currentTime;
                const duration = media.duration;
                if (Number.isFinite(duration) && duration > 0.2) media.currentTime = Math.min(duration * 0.5, duration - 0.05);
                await new Promise((resolve) => setTimeout(resolve, 120));
                const seekTime = media.currentTime;
                media.pause();
                return { ok: playedTime > 0, playedTime, seekTime, duration, controls: media.controls, paused: media.paused };
            } catch (error) {
                return { ok: false, reason: error instanceof Error ? error.message : String(error) };
            }
        })()`);
    }

    let nativeMediaExercise = null;
    if (nativeMedia) {
        const selector = nativeMedia === 'audio' ? 'audio[controls]' : nativeMedia === 'video' ? 'video[controls]' : nativeMedia;
        if (nativeMedia === 'video') {
            const hasControlledVideo = await evaluate(`Boolean(document.querySelector(${JSON.stringify(selector)}))`);
            if (!hasControlledVideo) {
                const opened = await clickControl('Open video');
                if (!opened) throw new Error('Video card was not available to open');
                await waitFor(
                    () => evaluate(`Boolean(document.querySelector(${JSON.stringify(selector)}))`),
                    10_000,
                    'video viewer with native controls',
                );
                await sleep(500);
            }
        }
        const rect = await evaluate(`(() => {
            const media = document.querySelector(${JSON.stringify(selector)});
            if (!(media instanceof HTMLMediaElement)) return null;
            media.scrollIntoView({ block: 'center', inline: 'center' });
            const box = media.getBoundingClientRect();
            return { x: box.left, y: box.top, width: box.width, height: box.height };
        })()`);
        if (!rect) throw new Error(`Native media element was not found: ${nativeMedia}`);

        // Drive Chromium's visible native controls with mouse input. JavaScript
        // below is observation-only: playback and seeking are never invoked via
        // HTMLMediaElement methods or property assignments.
        const playX = nativeMedia === 'audio' ? rect.x + 24 : rect.x + rect.width / 2;
        const playY = nativeMedia === 'audio' ? rect.y + rect.height / 2 : rect.y + rect.height / 2;
        await clickPoint(playX, playY);
        await sleep(900);
        const played = await evaluate(`(() => {
            const media = document.querySelector(${JSON.stringify(selector)});
            return media instanceof HTMLMediaElement
                ? { currentTime: media.currentTime, duration: media.duration, paused: media.paused, controls: media.controls }
                : null;
        })()`);

        const seekX = rect.x + rect.width * (nativeMedia === 'audio' ? 0.68 : 0.66);
        const seekY = nativeMedia === 'audio' ? rect.y + rect.height / 2 : rect.y + rect.height - 14;
        await clickPoint(seekX, seekY);
        await sleep(450);
        const sought = await evaluate(`(() => {
            const media = document.querySelector(${JSON.stringify(selector)});
            return media instanceof HTMLMediaElement
                ? { currentTime: media.currentTime, duration: media.duration, paused: media.paused, controls: media.controls }
                : null;
        })()`);

        await clickPoint(playX, playY);
        await sleep(250);
        const final = await evaluate(`(() => {
            const media = document.querySelector(${JSON.stringify(selector)});
            return media instanceof HTMLMediaElement
                ? { currentTime: media.currentTime, duration: media.duration, paused: media.paused, controls: media.controls }
                : null;
        })()`);
        nativeMediaExercise = {
            ok: Boolean(
                played?.controls
                && played.currentTime > 0
                && sought?.currentTime > played.currentTime
                && Number.isFinite(sought.duration)
            ),
            input: 'mouse',
            played,
            sought,
            final,
        };
    }

    let staticPreviewExercise = null;
    if (exerciseStaticPreview) {
        await waitFor(() => evaluate(`Boolean(document.querySelector('iframe[title^="Preview "]')?.srcdoc)`), waitTimeout, 'static file preview');
        await sleep(1500);
        const frame = await evaluate(`(() => {
            const frame = document.querySelector('iframe[title^="Preview "]');
            const parsed = new DOMParser().parseFromString(frame.srcdoc, 'text/html');
            return { sandbox: frame.getAttribute('sandbox'), title: frame.title,
                csp: parsed.querySelector('meta[http-equiv="Content-Security-Policy"]')?.content,
                scripts: parsed.querySelectorAll('script').length,
                dangerousElements: parsed.querySelectorAll('iframe,object,embed,foreignObject,base').length,
                eventAttributes: [...parsed.querySelectorAll('*')].flatMap(el => [...el.attributes]).filter(a => /^on/i.test(a.name)).length,
                content: parsed.body.textContent.slice(0, 2000),
                parentChanged: Boolean(document.body.dataset.pwned || document.documentElement.dataset.pwned || document.body.dataset.attacked || localStorage.getItem('attacked')) };
        })()`);
        const tree = await request('Page.getFrameTree');
        const child = tree.frameTree.childFrames?.find(node => node.frame.url === 'about:srcdoc');
        let access = null;
        if (child) {
            const world = await request('Page.createIsolatedWorld', { frameId: child.frame.id, worldName: 'hapla-static-preview-observation', grantUniveralAccess: false });
            const observed = await request('Runtime.evaluate', { contextId: world.executionContextId, returnByValue: true,
                expression: `(() => { const result = {}; for (const [name, read] of Object.entries({ parent: () => parent.document.body, cookie: () => document.cookie, storage: () => localStorage.length })) { try { read(); result[name] = 'accessible'; } catch (error) { result[name] = error.name; } } return result; })()` });
            access = observed.result.value;
        }
        if (!access) {
            for (const attached of attachedTargets.filter(target => target.targetInfo.type === 'iframe')) {
                await request('Runtime.enable', {}, attached.sessionId).catch(() => undefined);
                const observed = await request('Runtime.evaluate', { returnByValue: true,
                    expression: `(() => { if (!location.href.startsWith('about:srcdoc')) return null; const result = {}; for (const [name, read] of Object.entries({ parent: () => parent.document.body, cookie: () => document.cookie, storage: () => localStorage.length })) { try { read(); result[name] = 'accessible'; } catch (error) { result[name] = error.name; } } return result; })()` }, attached.sessionId).catch(() => null);
                if (observed?.result?.value) { access = observed.result.value; break; }
            }
        }
        const maliciousNetwork = [...externalRequestAttempts, ...networkEvidence].filter(item => /example\.invalid|evil\.invalid|preview-attack|preview-escape/.test(JSON.stringify(item)));
        staticPreviewExercise = { frame, access, maliciousNetwork,
            ok: frame.sandbox === '' && frame.scripts === 0 && frame.dangerousElements === 0 && frame.eventAttributes === 0
                && frame.csp?.includes("script-src 'none'") && frame.csp?.includes("connect-src 'none'") && !frame.parentChanged
                && access?.parent === 'SecurityError' && access?.cookie === 'SecurityError' && access?.storage === 'SecurityError'
                && maliciousNetwork.length === 0 };
    }

    let htmlExercise = null;
    if (exerciseHtml) {
        const target = await evaluate(`(() => {
            const frame = document.querySelector('iframe[title="HTML 沙箱展示验收"]');
            if (!frame?.contentWindow) return null;
            frame.contentWindow.postMessage({ source: 'hapla-host-acceptance', command: 'verify' }, '*');
            return { permitsSameOrigin: frame.sandbox.contains('allow-same-origin') };
        })()`);
        if (!target) {
            htmlExercise = { ok: false, reason: 'sandbox HTML frame was not ready' };
        } else {
            const responded = await waitFor(
                () => evaluate(`document.body?.innerText?.includes('iframe 内交互正常 ✓')`),
                5_000,
                'sandbox iframe interaction response',
            );
            htmlExercise = { ok: responded === true, parentAccessible: target.permitsSameOrigin, state: 'iframe 内交互正常 ✓' };
        }
    }

    if (iframeSubmitText) {
        const submitted = await evaluate(`(() => {
            const frame = document.querySelector('iframe');
            if (!frame?.contentWindow) return false;
            window.dispatchEvent(new MessageEvent('message', {
                source: frame.contentWindow,
                origin: 'null',
                data: {
                    jsonrpc: '2.0',
                    id: 'hapla-browser-smoke-submit',
                    method: 'hapla/submit',
                    params: { text: ${JSON.stringify(iframeSubmitText)}, images: [], skill: { name: 'imagegen' } },
                },
            }));
            return true;
        })()`);
        if (!submitted) throw new Error('Embedded frame was not ready to submit an intent');
        if (waitAfterIframeText) {
            await waitFor(
                () => evaluate(`document.body?.innerText?.includes(${JSON.stringify(waitAfterIframeText)})`),
                waitTimeout,
                `post-frame page text ${JSON.stringify(waitAfterIframeText)}`,
            );
        }
        await sleep(2_000);
    }

    if (afterClickText) {
        for (const requestedText of afterClickText.split('>>')) {
            const clicked = await clickControl(requestedText);
            if (!clicked) throw new Error(`Post-wait control was not found: ${requestedText}`);
            await sleep(4_000);
        }
    }

    if (afterClickPointValue) {
        const [x, y] = afterClickPointValue;
        if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('after-click-point must be x,y');
        await clickPoint(x, y);
        await sleep(4_000);
    }

    let scrollObservation = null;
    if (afterWheelValue) {
        const [x, y, deltaY] = afterWheelValue;
        if (![x, y, deltaY].every(Number.isFinite)) throw new Error('after-wheel must be x,y,deltaY');
        const inspectScroll = () => evaluate(`(() => ({
            status: [...document.querySelectorAll('body *')]
                .map((node) => node.textContent?.trim() || '')
                .find((text) => /(?:加载更早记录|上滑加载更早记录|已缓存 \\d+ 条事件)/.test(text)) || null,
            reeditControls: [...document.querySelectorAll('[role="button"],button')]
                .filter((node) => (node.textContent || '').includes('从这里重编辑')).length,
            scrollables: [...document.querySelectorAll('body *')]
                .filter((node) => node.scrollHeight > node.clientHeight + 20)
                .map((node) => ({
                    tag: node.tagName,
                    role: node.getAttribute('role'),
                    top: Math.round(node.scrollTop),
                    height: Math.round(node.clientHeight),
                    scrollHeight: Math.round(node.scrollHeight),
                }))
                .sort((left, right) => right.scrollHeight - left.scrollHeight)
                .slice(0, 5),
        }))()`);
        const before = await inspectScroll();
        const snapshots = [];
        for (let index = 0; index < afterWheelCount; index += 1) {
            await request('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY });
            await request('Input.synthesizeScrollGesture', {
                x,
                y,
                xDistance: 0,
                yDistance: -deltaY,
                speed: 800,
                gestureSourceType: 'touch',
            }).catch(() => undefined);
            await sleep(750);
            snapshots.push(await inspectScroll());
        }
        const after = snapshots.at(-1) || before;
        scrollObservation = {
            ok: JSON.stringify(before) !== JSON.stringify(after),
            input: 'mouseWheel+touchGesture',
            deltaY,
            count: afterWheelCount,
            before,
            after,
            snapshots,
        };
    }

    if (afterDragValue) {
        const [x1, y1, x2, y2] = afterDragValue;
        if (![x1, y1, x2, y2].every(Number.isFinite)) throw new Error('after-drag must be x1,y1,x2,y2');
        await request('Input.dispatchMouseEvent', { type: 'mousePressed', x: x1, y: y1, button: 'left', buttons: 1, clickCount: 1 });
        for (let step = 1; step <= 12; step += 1) {
            await request('Input.dispatchMouseEvent', {
                type: 'mouseMoved',
                x: x1 + ((x2 - x1) * step / 12),
                y: y1 + ((y2 - y1) * step / 12),
                button: 'left',
                buttons: 1,
            });
        }
        await request('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x2, y: y2, button: 'left', buttons: 0, clickCount: 1 });
        await sleep(2_000);
    }

    if (downloadText) {
        const clicked = await clickControl(downloadText);
        if (!clicked) throw new Error(`Download control was not found: ${downloadText}`);
        await waitFor(
            () => downloads.some((download) => download.state === 'completed'),
            waitTimeout,
            `completed browser download ${JSON.stringify(downloadText)}`,
        );
        await sleep(500);
    }

    if (promptValue) {
        await waitFor(
            () => evaluate(`document.body?.innerText?.includes('从这里重新编辑') || document.body?.innerText?.includes('Create branch')`),
            10_000,
            'prompt modal',
        );
        const filled = await focusPromptControl() && await typeIntoFocusedControl(promptValue);
        if (!filled) throw new Error('Prompt input was not found');
        const confirmed = await clickControl(promptConfirm);
        if (!confirmed) throw new Error(`Prompt confirmation control was not found: ${promptConfirm}`);
        if (waitAfterPromptText) {
            await waitFor(
                () => evaluate(`((document.body?.innerText || '').split(${JSON.stringify(waitAfterPromptText)}).length - 1) >= ${waitAfterPromptCount}`),
                waitTimeout,
                `post-prompt page text ${JSON.stringify(waitAfterPromptText)}`,
            );
        }
        await sleep(2_000);
    }

    if (scrollBottom) {
        await evaluate(`(() => {
            const candidates = [...document.querySelectorAll('body *')]
                .filter((node) => node.scrollHeight > node.clientHeight + 20)
                .sort((left, right) => right.scrollHeight - left.scrollHeight);
            const target = candidates[0] || document.scrollingElement;
            if (!target) return false;
            target.scrollTop = target.scrollHeight;
            target.dispatchEvent(new Event('scroll', { bubbles: true }));
            return true;
        })()`);
        await sleep(4_000);
    }

    let offlineObservation = null;
    if (simulateOffline) {
        const cycles = [];
        for (let cycle = 0; cycle < offlineCycles; cycle += 1) {
            await request('Network.emulateNetworkConditions', {
                offline: true,
                latency: 0,
                downloadThroughput: 0,
                uploadThroughput: 0,
            });
            const visible = await waitFor(
                () => evaluate(`document.body?.innerText?.includes('连接已断开 · 正在重试')`),
                15_000,
                `visible disconnected state (cycle ${cycle + 1})`,
            );
            const abortVisible = await evaluate(`Boolean(
                [...document.querySelectorAll('button, [role="button"]')].find((node) =>
                    node.getAttribute('aria-label') === 'Stop current response' &&
                    node.getClientRects().length > 0
                )
            )`);
            let recovered = null;
            if (recoverOnline) {
                await request('Network.emulateNetworkConditions', {
                    offline: false,
                    latency: 0,
                    downloadThroughput: -1,
                    uploadThroughput: -1,
                });
                recovered = await waitFor(
                    () => evaluate(`!(document.body?.innerText || '').includes('连接已断开 · 正在重试')`),
                    20_000,
                    `connection recovery after network restore (cycle ${cycle + 1})`,
                );
                await sleep(500);
            }
            cycles.push({
                disconnectedStatusVisible: visible === true,
                abortControlVisible: abortVisible === true,
                recoveredOnline: recovered === null ? null : recovered === true,
            });
        }
        offlineObservation = {
            ok: cycles.every((cycle) => cycle.disconnectedStatusVisible
                && !cycle.abortControlVisible
                && (!recoverOnline || cycle.recoveredOnline)),
            cycles,
        };
    }

    let previewRelease = null;
    if (verifyPreviewRelease) {
        const observed = await evaluate(`(() => {
            const media = document.querySelector('video,audio,iframe[src*="/__hapla_workspace_stream/"],iframe[srcdoc],img[src*="/__hapla_workspace_stream/"]');
            if (!media) return null;
            window.__haplaPreviewWeak = new WeakRef(media);
            return { source: media.src, kind: media.tagName, requiresRevocation: media.src.includes('/__hapla_workspace_stream/') };
        })()`);
        if (!observed) throw new Error('Workspace media was not rendered before release verification');
        await request('HeapProfiler.collectGarbage');
        const loaded = { performance: pickPerformanceMetrics((await request('Performance.getMetrics')).metrics), dom: await request('Memory.getDOMCounters') };
        if (!await clickControl('New session')) throw new Error('New session navigation was not available');
        await waitFor(() => evaluate(`location.pathname === '/new'`), 10000, 'leave file preview');
        await sleep(1500);
        await request('HeapProfiler.collectGarbage');
        const released = await evaluate(`(() => {
            const media = window.__haplaPreviewWeak.deref();
            return { collected: !media,
                mediaRemaining: document.querySelectorAll('video,audio,iframe[src*="/__hapla_workspace_stream/"],iframe[srcdoc],img[src*="/__hapla_workspace_stream/"]').length,
                detachedState: media ? { sourceAttribute: media.getAttribute('src'),
                    hasSrcdoc: media.hasAttribute('srcdoc'),
                    paused: media.paused ?? null, readyState: media.readyState ?? null,
                    bufferedRanges: media.buffered?.length ?? null,
                    naturalWidth: media.naturalWidth ?? null, naturalHeight: media.naturalHeight ?? null,
                    childWindowClosed: media instanceof HTMLIFrameElement ? media.contentWindow === null : null } : null };
        })()`);
        const expiredStatus = observed.requiresRevocation
            ? await evaluate(`fetch(${JSON.stringify(observed.source)}).then(response => response.status)`)
            : null;
        const mediaResourcesReleased = released.collected || (released.detachedState?.sourceAttribute === null
            && ((released.detachedState?.paused === true && released.detachedState?.readyState === 0
                && released.detachedState?.bufferedRanges === 0)
                || (observed.kind === 'IMG' && released.detachedState?.naturalWidth === 0 && released.detachedState?.naturalHeight === 0)
                || (observed.kind === 'IFRAME' && released.detachedState?.childWindowClosed === true && !released.detachedState?.hasSrcdoc)));
        previewRelease = { ok: mediaResourcesReleased && released.mediaRemaining === 0 && (!observed.requiresRevocation || expiredStatus === 410),
            mediaResourcesReleased,
            criteria: 'No media in the active DOM; stream grant revoked; node collected or source cleared plus no buffered media, no decoded image dimensions or no child browsing context. Detached-node collection is reported separately from resource release.',
            kind: observed.kind, requiresRevocation: observed.requiresRevocation, loaded, released, expiredStatus };
        await evaluate(`delete window.__haplaPreviewWeak`);
    }

    if (exportRecoveryKey) {
        const secret = await evaluate(`(() => {
            const displayed = document.body?.innerText?.match(/\\b(?:[A-Z2-7]{5}-){10}[A-Z2-7]{2}\\b/)?.[0];
            if (displayed) return displayed;
            const raw = localStorage.getItem('auth_credentials');
            if (!raw) return null;
            try { return JSON.parse(raw).secret || null; } catch { return null; }
        })()`);
        if (!secret) throw new Error('Stored recovery secret was not available');
        writeFileSync(exportRecoveryKey, secret, { mode: 0o600 });
    }

    if (repeatClicks.length > 0 && repeatClickCount > 0) {
        for (let iteration = 0; iteration < repeatClickCount; iteration += 1) {
            for (const label of repeatClicks) {
                const clicked = await clickControl(label);
                if (!clicked) throw new Error(`Repeated control was not found: ${label}`);
                await sleep(100);
            }
        }
        await sleep(1_000);
    }

    if (holdMs > 0) await sleep(holdMs);

    await request('HeapProfiler.collectGarbage').catch(() => undefined);
    if (screencastDir) await request('Page.stopScreencast');
    if (heapSnapshot) {
        heapFd = openSync(heapSnapshot, 'w', 0o600);
        try { await request('HeapProfiler.takeHeapSnapshot', { reportProgress: false, captureNumericValue: true }); }
        finally { closeSync(heapFd); heapFd = undefined; }
    }
    const finalCdpMetrics = {
        performance: pickPerformanceMetrics((await request('Performance.getMetrics')).metrics),
        dom: await request('Memory.getDOMCounters'),
    };
    if (environmentObservation && environmentValue !== undefined) {
        environmentObservation.secretPersistedAfterSend = await evaluate(`(() => {
            const needle = ${JSON.stringify(environmentValue)};
            return [...Object.values(localStorage), ...Object.values(sessionStorage)]
                .some((value) => String(value).includes(needle));
        })()`);
    }

    const page = await evaluate(`({
        url: location.href,
        title: document.title,
        text: document.body?.innerText?.slice(0, 1600) || '',
        width: innerWidth,
        height: innerHeight,
        viewport: { devicePixelRatio, visualScale: visualViewport?.scale ?? null },
        scaleDiagnostics: (() => {
            const target = document.querySelector('[aria-label="normal mode"]');
            const chain = [];
            let item = target;
            while (item && chain.length < 8) {
                const style = getComputedStyle(item);
                const rect = item.getBoundingClientRect();
                chain.push({ tag: item.tagName, width: rect.width, height: rect.height, transform: style.transform, zoom: style.zoom, minHeight: style.minHeight, heightStyle: style.height });
                item = item.parentElement;
            }
            return chain;
        })(),
        scrollWidth: document.documentElement.scrollWidth,
        scrollHeight: document.documentElement.scrollHeight,
        domNodeCount: document.querySelectorAll('*').length,
        hasStoredAuth: Boolean(localStorage.getItem('auth_credentials')),
        buttons: [...document.querySelectorAll('[role="button"], button, a, [tabindex]')]
            .map((item) => item.textContent?.trim()).filter(Boolean).slice(0, 30),
        interactives: [...document.querySelectorAll('[role="button"], button, a, input, textarea, [tabindex]')]
            .map((item) => {
                const rect = item.getBoundingClientRect();
                const computed = getComputedStyle(item);
                return ({
                tag: item.tagName,
                role: item.getAttribute('role'),
                label: item.getAttribute('aria-label'),
                placeholder: item.getAttribute('placeholder'),
                href: item instanceof HTMLAnchorElement ? item.href : null,
                download: item instanceof HTMLAnchorElement ? item.download : null,
                text: item.textContent?.trim().slice(0, 80) || '',
                disabled: item.hasAttribute('disabled'),
                rect: { width: Math.round(rect.width), height: Math.round(rect.height) },
                computed: { minWidth: computed.minWidth, minHeight: computed.minHeight, flexShrink: computed.flexShrink },
            })}).slice(0, 60),
        iframes: [...document.querySelectorAll('iframe')].map((frame) => ({
            title: frame.title,
            srcdocBytes: new TextEncoder().encode(frame.srcdoc).byteLength,
            sandbox: frame.getAttribute('sandbox'),
            permitsSameOrigin: frame.sandbox.contains('allow-same-origin'),
        })),
        media: [...document.querySelectorAll('audio, video, img')].map((item) => ({
            tag: item.tagName,
            controls: Boolean(item.controls),
            src: (item.currentSrc || item.src || '').slice(0, 160),
            complete: item instanceof HTMLImageElement ? item.complete : undefined,
            naturalWidth: item instanceof HTMLImageElement ? item.naturalWidth : undefined,
            naturalHeight: item instanceof HTMLImageElement ? item.naturalHeight : undefined,
            readyState: item instanceof HTMLMediaElement ? item.readyState : undefined,
            duration: item instanceof HTMLMediaElement && Number.isFinite(item.duration) ? item.duration : undefined,
            videoWidth: item instanceof HTMLVideoElement ? item.videoWidth : undefined,
            videoHeight: item instanceof HTMLVideoElement ? item.videoHeight : undefined,
            buffered: item instanceof HTMLMediaElement
                ? [...Array(item.buffered.length)].map((_, index) => ({ start: item.buffered.start(index), end: item.buffered.end(index) }))
                : undefined,
        })),
        richContent: {
            headings: document.querySelectorAll('h1,h2,h3,h4,h5,h6').length,
            tables: document.querySelectorAll('table').length,
            codeBlocks: document.querySelectorAll('pre code').length,
            links: document.querySelectorAll('a[href]').length,
            blockquotes: document.querySelectorAll('blockquote').length,
            svg: document.querySelectorAll('svg').length,
        },
        branches: [...document.querySelectorAll('[aria-selected], [aria-pressed][aria-label*="分支"]')].map((item) => ({
            selected: item.getAttribute('aria-selected') ?? item.getAttribute('aria-pressed'),
            text: item.textContent?.trim() || '',
        })),
        accessibility: (() => {
            const visible = (item) => {
                const style = getComputedStyle(item);
                const rect = item.getBoundingClientRect();
                return style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity) > 0
                    && rect.width > 0 && rect.height > 0
                    && rect.bottom > 0 && rect.right > 0 && rect.top < innerHeight && rect.left < innerWidth;
            };
            const controls = [...document.querySelectorAll('button, a, input, textarea, [role="button"]')].filter(visible);
            const small = controls.filter((item) => { const rect = item.getBoundingClientRect(); return rect.width < 44 || rect.height < 44; });
            return {
                unnamedControls: controls.filter((item) => !((item.getAttribute('aria-label') || item.getAttribute('title') || item.textContent || item.getAttribute('placeholder') || '').trim())).length,
                smallTouchTargets: small.length,
                smallTouchTargetDetails: small.slice(0, 10).map((item) => { const rect = item.getBoundingClientRect(); return { name: (item.getAttribute('aria-label') || item.textContent || '').trim().slice(0, 60), width: Math.round(rect.width), height: Math.round(rect.height) }; }),
            };
        })(),
        performance: (() => {
            const navigation = performance.getEntriesByType('navigation')[0];
            const resources = performance.getEntriesByType('resource');
            return {
                domContentLoadedMs: navigation ? Math.round(navigation.domContentLoadedEventEnd) : null,
                loadMs: navigation ? Math.round(navigation.loadEventEnd) : null,
                resourceCount: resources.length,
                transferBytes: resources.reduce((sum, item) => sum + (item.transferSize || 0), 0),
                encodedBodyBytes: resources.reduce((sum, item) => sum + (item.encodedBodySize || 0), 0),
            };
        })(),
    })`);

    const image = await request('Page.captureScreenshot', {
        format: 'png',
        captureBeyondViewport: false,
    });
    writeFileSync(screenshot, Buffer.from(image.data, 'base64'));

    const heavyModules = loadedScripts.filter((scriptUrl) =>
        /McpAppSurface|xterm|mermaid/i.test(scriptUrl),
    );
    const fullPageText = await evaluate(`document.body?.innerText || ''`);
    const forbiddenMatches = forbiddenText.filter((value) => fullPageText.includes(value));
    const missingRequiredText = requiredText.filter((value) => !fullPageText.includes(value));
    const orderPositions = requiredOrder.map((value) => ({ value, index: fullPageText.indexOf(value) }));
    const requiredOrderOk = orderPositions.every((item) => item.index >= 0)
        && orderPositions.every((item, index) => index === 0 || item.index > orderPositions[index - 1].index);
    const result = {
        ok:
            runtimeErrors.length === 0 &&
            failedRequests.every(failure => injectedPreviewFailures.has(failure)) &&
            page.scrollWidth <= page.width &&
            forbiddenMatches.length === 0 &&
            missingRequiredText.length === 0 &&
            (requiredOrder.length === 0 || requiredOrderOk),
        accepted,
        page,
        runtimeErrors,
        failedRequests,
        previewFailureRecovery,
        mediaResponses,
        downloads: downloads.map((download) => ({ ...download, downloadDir })),
        authTraffic,
        networkEvidence,
        externalRequestAttempts,
        screencastFrames,
        heapSnapshot,
        deletionTraffic,
        forbiddenMatches,
        missingRequiredText,
        requiredOrder: { ok: requiredOrder.length === 0 || requiredOrderOk, positions: orderPositions },
        agentStatuses: [...new Set(fullPageText.match(/Codex · [^\n]+/g) ?? [])],
        environmentObservation,
        cdpMetrics: { initial: initialCdpMetrics, final: finalCdpMetrics },
        performanceSamples,
        browserPid: browser.pid,
        heavyModules,
        mediaExercise,
        nativeMediaExercise,
        htmlExercise,
        staticPreviewExercise,
        previewRelease,
        iframeClickExercise,
        streamObservation,
        activityObservation,
        activityScreenshotObservation,
        branchSwitchDuringRun,
        stopObservation,
        offlineObservation,
        newSessionEntryObservation,
        sessionDeleteObservation,
        scrollObservation,
        screenshot,
    };
    if (verifyPreviewRelease && !previewRelease?.ok) result.ok = false;
    if (exerciseStaticPreview && !staticPreviewExercise?.ok) result.ok = false;
    if (exerciseMedia && !mediaExercise?.ok) result.ok = false;
    if (nativeMedia && !nativeMediaExercise?.ok) result.ok = false;
    if (exerciseHtml && (!htmlExercise?.ok || htmlExercise.parentAccessible)) result.ok = false;
    if (iframeClickText && !iframeClickExercise?.ok) result.ok = false;
    if (observeStreamStart && observeStreamEnd && !streamObservation?.ok) result.ok = false;
    if (expectedActivities.length > 0 && !activityObservation?.ok) result.ok = false;
    if (activityScreenshotText && !activityScreenshotObservation?.ok) result.ok = false;
    if (clickDuringRun && !branchSwitchDuringRun?.ok) result.ok = false;
    if (stopDuringRun && !stopObservation?.ok) result.ok = false;
    if (simulateOffline && !offlineObservation?.ok) result.ok = false;
    if (exerciseNewSessionEntry && !newSessionEntryObservation?.ok) result.ok = false;
    if (exerciseDeleteCurrentSession && !sessionDeleteObservation?.ok) result.ok = false;
    if (environmentObservation?.secretPersistedBeforeSend || environmentObservation?.secretPersistedAfterSend) result.ok = false;
    const serializedResult = `${JSON.stringify(result, null, 2)}\n`;
    if (outputFile) writeFileSync(outputFile, serializedResult, { mode: 0o600 });
    process.stdout.write(serializedResult);
    if (!result.ok) process.exitCode = 1;
} catch (error) {
    // Acceptance failures need inspectable UI evidence as much as successful
    // runs do. Keep the artifact local and deliberately omit the active URL:
    // connection links may contain recovery/authentication material.
    let failurePage;
    if (socket?.readyState === WebSocket.OPEN) {
        try {
            const image = await request('Page.captureScreenshot', {
                format: 'png',
                captureBeyondViewport: false,
            });
            writeFileSync(screenshot, Buffer.from(image.data, 'base64'));
        } catch {
            // The browser may have exited; the original error remains primary.
        }
        try {
            failurePage = await evaluate(`({
                title: document.title,
                text: (document.body?.innerText || '').slice(0, 4000),
                width: innerWidth,
                height: innerHeight,
                scrollWidth: document.documentElement.scrollWidth,
                scrollHeight: document.documentElement.scrollHeight,
            })`);
        } catch {
            // A disconnected target cannot provide page diagnostics.
        }
    }
    const failureResult = {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        page: failurePage,
        downloads, networkEvidence, mediaResponses, attachedTargets,
        runtimeErrors,
        failedRequests,
        stopObservation,
        screenshot: existsSync(screenshot) ? screenshot : null,
    };
    const serializedFailure = `${JSON.stringify(failureResult, null, 2)}\n`;
    if (outputFile) writeFileSync(outputFile, serializedFailure, { mode: 0o600 });
    process.stdout.write(serializedFailure);
    process.exitCode = 1;
} finally {
    if (memorySampleTimer) clearInterval(memorySampleTimer);
    if (socket?.readyState === WebSocket.OPEN) {
        await Promise.race([request('Browser.close').catch(() => undefined), sleep(1_000)]);
    }
    if (browser.exitCode === null) browser.kill('SIGTERM');
    await Promise.race([browserExited, sleep(5_000)]);
    if (!suppliedProfile) {
        for (let attempt = 0; attempt < 12; attempt += 1) {
            try {
                rmSync(profile, {
                    recursive: true,
                    force: true,
                    maxRetries: 8,
                    retryDelay: 125,
                });
                break;
            } catch (error) {
                if (attempt === 11) throw error;
                await sleep(250 * (attempt + 1));
            }
        }
    }
    if (process.exitCode && browserStderr) {
        process.stderr.write(browserStderr.slice(-4_000));
    }
}
