import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync, mkdirSync, appendFileSync, writeFileSync, existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { WebSocketServer } from 'ws';
import nacl from 'tweetnacl';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { startHaplaServer } from '../../packages/hapla-cli/src/claude/utils/startHaplaServer';
import type { ApiSessionClient } from '../../packages/hapla-cli/src/api/apiSession';

assert.equal(process.env.HAPLA_ACCEPTANCE_STACK, 'dev-hapla');
assert(existsSync('/.dockerenv'), 'Run inside dev Docker');
const credentials = JSON.parse(readFileSync(process.env.HAPLA_ACCEPTANCE_CREDENTIALS || '/repo/.runtime/dev-credentials.json', 'utf8'));
const pw = await import(process.env.HAPLA_PLAYWRIGHT_MODULE || 'playwright-core');
const origin = new URL(process.env.HAPLA_ACCEPTANCE_WEB_URL || 'http://app.preview.localhost').origin;
const api = process.env.HAPLA_SERVER_URL || 'http://server:3005';
const out = process.env.HAPLA_ACCEPTANCE_OUTPUT || '/repo/artifacts/preview-manager';
const profile = process.env.PROFILE || 'desktop';
const run = `proxy-${profile}-${Date.now().toString(36)}`;
mkdirSync(out, { recursive: true });
const log = (value: object) => { const row = JSON.stringify({ at: new Date().toISOString(), run, profile, ...value }); appendFileSync(out + '/actions.ndjson', row + '\n'); console.log(row); };
const browser = await pw[profile === 'iphone' ? 'webkit' : 'chromium'].launch(profile === 'iphone' ? { env: { ...process.env, HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '', http_proxy: '', https_proxy: '' } } : { executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', args: ['--no-sandbox', '--no-proxy-server', ...(process.env.HAPLA_PREVIEW_TEST_RESOLVER ? ['--host-resolver-rules=' + process.env.HAPLA_PREVIEW_TEST_RESOLVER] : [])] });
const device = profile === 'desktop' ? {} : pw.devices[profile === 'iphone' ? 'iPhone 13' : 'Pixel 7'];
const viewport = profile === 'desktop' ? { width: 1440, height: 1000 } : profile === 'iphone' ? { width: 390, height: 844 } : { width: 360, height: 800 };
const errors: string[] = [];
const contexts: any[] = [];
async function context(auth?: { token: string; secret: string }) {
    const context = await browser.newContext({ ...device, viewport, locale: 'zh-CN', ignoreHTTPSErrors: process.env.HAPLA_ACCEPTANCE_IGNORE_HTTPS_ERRORS === '1', recordVideo: { dir: out + '/video', size: viewport } });
    contexts.push(context);
    await context.exposeBinding('recordProxyAction', (_source: any, action: any) => log({ type: 'ui', ...action }));
    await context.addInitScript(() => {
        document.addEventListener('pointerdown', event => { const node = (event.target as Element)?.closest('button,[role=button],a,input,select'); if (node) (window as any).recordProxyAction({ event: 'pointer', pointerType: event.pointerType, label: node.getAttribute('aria-label') || node.textContent?.trim().slice(0, 60) }); }, true);
        document.addEventListener('input', event => { const node = event.target as HTMLInputElement; if (node.type !== 'password') (window as any).recordProxyAction({ event: 'input', label: node.getAttribute('aria-label') || node.closest('label')?.firstChild?.textContent, length: node.value?.length }); }, true);
    });
    if (auth) await context.addInitScript(({ auth, origin }: any) => { if (location.origin === origin && !sessionStorage.getItem('proxy-fixture-seeded')) { localStorage.setItem('auth_credentials', JSON.stringify(auth)); sessionStorage.setItem('proxy-fixture-seeded', '1'); } }, { auth, origin });
    context.on('page', page => {
        page.on('pageerror', error => errors.push(error.message));
        page.on('requestfailed', request => log({ type: 'request-failed', path: new URL(request.url()).pathname, error: request.failure()?.errorText }));
        page.on('response', response => { if (response.status() >= 400) log({ type: 'http-error', path: new URL(response.url()).pathname, status: response.status() }); });
        page.on('dialog', dialog => dialog.accept());
    });
    return context;
}
async function apiGet(path: string, token = credentials.token) { const r = await fetch(api + path, { headers: { authorization: 'Bearer ' + token } }); assert(r.ok); return r.json(); }
async function fixture(label: string, port = 0) {
    const server = createServer(async (req, res) => {
        const path = new URL(req.url!, 'http://upstream').pathname;
        if (path.endsWith('/api')) { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ label, cookie: req.headers.cookie || '', auth: req.headers.authorization || '' })); return; }
        if (path.endsWith('/events')) { res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' }); res.write('data: SSE_READY\n\n'); const timer = setInterval(() => res.write('data: heartbeat\n\n'), 500); res.once('close', () => clearInterval(timer)); return; }
        if (path.endsWith('/module.js')) { res.setHeader('content-type', 'application/javascript'); res.end('export default "MODULE_OK"'); return; }
        if (path.endsWith('/app.js')) { res.setHeader('content-type', 'application/javascript'); res.end(`document.getElementById('storage').textContent=localStorage.getItem('auth_credentials')?'CREDENTIAL_LEAK':'ORIGIN_ISOLATED';fetch('/api',{headers:{Authorization:'Bearer service-owned-token'}}).then(r=>r.json()).then(v=>{document.getElementById('api').textContent=v.label;document.getElementById('headers').textContent=v.auth!=='Bearer service-owned-token'||v.cookie.includes('hapla_')?'CREDENTIAL_LEAK':'HEADERS_STRIPPED'});import('/module.js').then(m=>document.getElementById('module').textContent=m.default);const ws=new WebSocket(location.origin.replace(/^http/,'ws')+location.pathname+'socket');ws.onopen=()=>ws.send('WS_OK');ws.onmessage=e=>document.getElementById('socket').textContent=e.data;ws.onclose=()=>document.getElementById('socket').dataset.closed='true';const events=new EventSource(location.pathname+'events');events.onmessage=e=>{if(e.data==='SSE_READY')document.getElementById('events').textContent=e.data};events.onerror=()=>document.getElementById('events').dataset.closed='true';`); return; }
        res.setHeader('content-type', 'text/html; charset=utf-8'); res.end(`<!doctype html><html><head><meta charset="utf-8"></head><body><h1>${label}</h1><p id="api"></p><p id="module"></p><p id="socket"></p><p id="events"></p><p id="storage"></p><p id="headers"></p><a href="/login">登录页面</a></body><script src="/app.js"></script></html>`);
    });
    const ws = new WebSocketServer({ server }); ws.on('connection', client => client.on('message', (data, binary) => client.send(data, { binary })));
    await new Promise<void>(resolve => server.listen(port, '0.0.0.0', resolve));
    return { port: (server.address() as any).port, close: async () => { for (const client of ws.clients) client.terminate(); await new Promise<void>(resolve => ws.close(() => resolve())); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}
let upstream = await fixture('SERVICE_A');
const owner = await context({ token: credentials.token, secret: credentials.secret });
const page = await owner.newPage(); page.setDefaultTimeout(20000);
let handle = '';
async function action(name: string, operation: () => Promise<void>) { log({ type: 'start', name }); await operation(); log({ type: 'passed', name }); }
async function press(locator: any) { if (profile === 'desktop') await locator.click(); else await locator.tap(); }
async function navigate(tab: any, url: string) {
    for (let attempt = 0; attempt < 30; attempt++) {
        const response = await tab.goto(url);
        if (!response || response.status() >= 500) { await tab.waitForTimeout(500); continue; }
        if (await tab.getByLabel('系统密码', { exact: true }).count()) {
            const file = process.env.HAPLA_ACCEPTANCE_SITE_PASSWORD_FILE;
            assert(file, 'Dev site gate requires a private acceptance password file');
            await tab.getByLabel('系统密码', { exact: true }).fill(readFileSync(file, 'utf8'));
            await press(tab.getByRole('button', { name: '进入', exact: true }));
            await tab.getByLabel('系统密码', { exact: true }).waitFor({ state: 'hidden' });
        }
        return;
    }
    throw Error('Dev Web did not become ready');
}
async function ready(url: string) { await navigate(page, url); }

async function shot(name: string) { await page.screenshot({ path: out + '/' + name + '.png', animations: 'disabled', scale: 'css' }); }
async function opened(from: any) { const pending = from.context().waitForEvent('page'); await press(from.getByRole('link', { name: run, exact: true })); const tab = await pending; tab.setDefaultTimeout(20000); return tab; }
async function content(tab: any, label: string) {
    for (let attempt = 0; attempt < 60; attempt++) {
        if (await tab.getByRole('heading', { name: label, exact: true }).count()) break;
        const text = await tab.locator('body').innerText().catch(() => '');
        if (text.includes('工作台暂时离线')) { log({ type: 'retry', reason: 'workbench-reconnect' }); await tab.reload(); }
        await tab.waitForTimeout(250);
    }
    await tab.getByRole('heading', { name: label, exact: true }).waitFor();
    await tab.locator('#api').filter({ hasText: label }).waitFor();
    await tab.locator('#module').filter({ hasText: 'MODULE_OK' }).waitFor();
    await tab.locator('#socket').filter({ hasText: 'WS_OK' }).waitFor();
    await tab.locator('#events').filter({ hasText: 'SSE_READY' }).waitFor();
    assert.equal(await tab.locator('#storage').textContent(), 'ORIGIN_ISOLATED');
    assert.equal(await tab.locator('#headers').textContent(), 'HEADERS_STRIPPED');
    assert.notEqual(new URL(tab.url()).origin, origin);
    const address = new URL(tab.url());
    const cookie = (await tab.context().cookies(tab.url())).find((value: any) => value.name === 'hapla_preview_grant'); assert(cookie);
    const probe = await fetch(api + `/preview/${address.pathname.split('/')[2]}/api`, { headers: { host: address.host, 'x-forwarded-host': address.host, 'x-forwarded-proto': address.protocol.slice(0, -1), cookie: `hapla_preview_grant=${cookie.value}`, authorization: 'Bearer ' + credentials.token } });
    assert(probe.ok, `Credential stripping probe failed (${probe.status})`); assert.equal((await probe.json()).auth, '');

}
async function confirm() {
    const button = page.getByRole('button', { name: /^(确认|Confirm|OK|确定)$/ });
    await button.last().waitFor();
    await press(button.last());
}
try {
    await action('01-create-private-rule', async () => {
        await ready(origin + '/previews'); await press(page.getByRole('button', { name: '新建代理', exact: true }));
        await page.getByLabel('名称', { exact: true }).fill(run);
        await page.getByLabel('工作台', { exact: true }).selectOption(credentials.machineId);
        await page.getByLabel('目标服务地址', { exact: true }).fill(`http://127.0.0.1:${upstream.port}/`);
        await press(page.getByRole('button', { name: '保存规则', exact: true }));
        await page.getByRole('status').filter({ hasText: '已保存' }).waitFor();
        const rows = (await apiGet('/v1/previews')).registrations; handle = rows.find((row: any) => row.name === run).handle;
        assert.equal(await page.getByLabel('固定入口', { exact: true }).inputValue(), origin + '/preview/' + handle + '/');
        await shot('01-manager-desktop'); const tab = await opened(page); await content(tab, 'SERVICE_A'); await tab.close();
    });
    await action('02-private-denies-other-and-anonymous', async () => {
        const anon = await context(); const tab = await anon.newPage();
        const response = await tab.goto(origin + '/preview/' + handle + '/'); assert.equal(response.status(), 401);
        await tab.getByRole('heading', { name: '代理访问验证' }).waitFor(); await tab.close();
        const responseOther = await fetch(api + '/preview/' + handle + '/', { headers: { cookie: 'hapla_preview_auth=' + credentials.otherToken } }); assert.equal(responseOther.status, 403);
    });
    await action('03-change-upstream-keeps-url', async () => {
        const replacement = await fixture('SERVICE_B'); await upstream.close(); upstream = replacement;
        await page.getByLabel('目标服务地址', { exact: true }).fill(`http://127.0.0.1:${upstream.port}/base/`);
        await press(page.getByRole('button', { name: '保存规则', exact: true })); await page.getByRole('status').filter({ hasText: '已保存' }).waitFor();
        assert.equal(await page.getByLabel('固定入口', { exact: true }).inputValue(), origin + '/preview/' + handle + '/');
        const tab = await opened(page); await content(tab, 'SERVICE_B'); await tab.close();
    });
    await action('04-global-user-share-readonly', async () => {
        await page.getByLabel('访问范围', { exact: true }).selectOption('users'); await press(page.getByRole('button', { name: '保存规则', exact: true }));
        await page.getByRole('status').filter({ hasText: '已保存' }).waitFor();
        const seed = randomBytes(32), pair = nacl.sign.keyPair.fromSeed(seed), challenge = randomBytes(32);
        const response = await fetch(api + '/v1/auth', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + credentials.token }, body: JSON.stringify({ publicKey: Buffer.from(pair.publicKey).toString('base64'), challenge: challenge.toString('base64'), signature: Buffer.from(nacl.sign.detached(challenge, pair.secretKey)).toString('base64') }) }); assert(response.ok);
        const auth = { token: (await response.json()).token, secret: seed.toString('base64url') };
        const other = await context(auth), otherPage = await other.newPage(); await navigate(otherPage, origin + '/previews');
        await press(otherPage.getByRole('button', { name: '共享给我的', exact: true })); await otherPage.getByRole('link', { name: run, exact: true }).waitFor();
        assert.equal(await otherPage.getByRole('button', { name: '编辑 ' + run, exact: true }).count(), 0);
        const visible = (await apiGet('/v1/previews?scope=visible', auth.token)).registrations.find((row: any) => row.handle === handle);
        assert.equal(visible.canManage, false); for (const field of ['target', 'machineId', 'revision', 'shareKeyHash']) assert.equal(visible[field], undefined);
        const tab = await opened(otherPage); await content(tab, 'SERVICE_B');
        const current = (await apiGet('/v1/previews')).registrations.find((row: any) => row.handle === handle);
        const forbidden = await fetch(api + '/v1/previews', { method: 'POST', headers: { authorization: 'Bearer ' + auth.token, 'content-type': 'application/json' }, body: JSON.stringify({ ...current, target: 'http://127.0.0.1:1/' }) }); assert.equal(forbidden.status, 409);
        const deniedDelete = await fetch(api + '/v1/previews/' + handle, { method: 'DELETE', headers: { authorization: 'Bearer ' + auth.token } }); assert.equal(deniedDelete.status, 404);
        const upstreamMcp = await startHaplaServer({ sessionId: credentials.sessionId, authToken: credentials.token, getMetadata: () => ({ machineId: credentials.machineId }), sendClaudeSessionMessage: () => { throw Error('No test messages expected'); } } as unknown as ApiSessionClient);
        const mcp = new Client({ name: 'preview-manager-acceptance', version: '1' });
        try {
            await mcp.connect(new StdioClientTransport({ command: process.execPath, args: ['/repo/packages/hapla-cli/dist/codex/haplaMcpStdioBridge.mjs', '--url', upstreamMcp.url], stderr: 'pipe' }));
            assert((await mcp.listTools()).tools.some(tool => tool.name === 'register_web_preview'));
            const result = await mcp.callTool({ name: 'register_web_preview', arguments: { handle, name: run, target: current.target } }); assert(!result.isError);
            const updated = JSON.parse((result.content as any)[0].text); assert.equal(updated.handle, handle); assert.equal(updated.access, 'users');
        } finally { await mcp.close(); upstreamMcp.stop(); }
        // The concurrent MCP write makes this editor's revision stale. A rejected
        // save must retain its unsaved rule, then an explicit refresh/edit retries.
        await page.getByLabel('名称', { exact: true }).fill(run + '-unsaved');
        await press(page.getByRole('button', { name: '保存规则', exact: true }));
        await page.getByRole('alert').filter({ hasText: '配置已更新' }).waitFor();
        assert.equal(await page.getByLabel('名称', { exact: true }).inputValue(), run + '-unsaved');
        await press(page.getByRole('button', { name: '刷新列表', exact: true }));
        await page.getByRole('link', { name: run, exact: true }).waitFor();
        await press(page.getByRole('button', { name: '编辑 ' + run, exact: true }));
        await otherPage.goto(origin + '/settings/account');
        await press(otherPage.getByText(/^(Logout|登出)$/i).first());
        await press(otherPage.getByText(/^(Logout|登出)$/i).last());
        await otherPage.waitForFunction(() => !localStorage.getItem('auth_credentials'));
        await tab.locator('#socket[data-closed="true"]').waitFor();
        await tab.locator('#events[data-closed="true"]').waitFor();
        assert.equal((await tab.reload()).status(), 401);
        await tab.close(); await otherPage.close();
    });
    let share = '';
    let anonymousTab: any;
    await action('05-public-key-share-and-origin-isolation', async () => {
        await page.getByLabel('访问范围', { exact: true }).selectOption('key'); await press(page.getByRole('button', { name: '保存规则', exact: true }));
        await press(page.getByRole('button', { name: '生成共享密钥', exact: true }));
        share = await page.getByLabel('带密钥的共享链接', { exact: true }).inputValue();
        assert(new URL(share).hash.includes('hapla-key=')); assert.equal(new URL(share).search, '');
        await press(page.getByRole('button', { name: '收起密钥', exact: true })); await shot('05-key-management');
        const anon = await context(); anonymousTab = await anon.newPage(); await anonymousTab.goto(share); await content(anonymousTab, 'SERVICE_B');
    });
    await action('06-revoke-key-invalidates-existing-grant', async () => {
        await press(page.getByRole('button', { name: '重新生成密钥', exact: true })); await confirm();
        const rotated = await page.getByLabel('带密钥的共享链接', { exact: true }).inputValue();
        assert.notEqual(rotated, share); await press(page.getByRole('button', { name: '收起密钥', exact: true }));
        await anonymousTab.locator('#socket[data-closed="true"]').waitFor();
        await anonymousTab.locator('#events[data-closed="true"]').waitFor();
        assert.equal((await anonymousTab.reload()).status(), 401);
        const invalid = await (await context()).newPage(); await invalid.goto(share); await invalid.getByRole('alert').filter({ hasText: '密钥无效' }).waitFor(); await invalid.close();
        const valid = await (await context()).newPage(); await valid.goto(rotated); await content(valid, 'SERVICE_B'); anonymousTab = valid;
        await press(page.getByRole('button', { name: '撤销密钥', exact: true })); await confirm();
        await page.getByRole('status').filter({ hasText: '已撤销密钥' }).waitFor();
        await anonymousTab.locator('#socket[data-closed="true"]').waitFor();
        await anonymousTab.locator('#events[data-closed="true"]').waitFor();
        const response = await anonymousTab.reload(); assert.equal(response.status(), 401);
        const old = await (await context()).newPage(); await old.goto(share); await old.getByRole('alert').filter({ hasText: '密钥无效' }).waitFor(); await old.close();
    });
    await action('07-responsive-layout-and-persistence', async () => {
        await page.reload(); await press(page.getByRole('button', { name: '编辑 ' + run, exact: true }));
        await page.getByLabel('访问范围', { exact: true }).selectOption('private'); await press(page.getByRole('button', { name: '保存规则', exact: true }));
        await page.getByRole('status').filter({ hasText: '已保存' }).waitFor();
        await page.setViewportSize({ width: 390, height: 844 }); await shot('07-manager-phone');
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
        await press(page.getByRole('button', { name: '关闭代理配置', exact: true })); await press(page.getByRole('button', { name: '我创建的', exact: true }));
        await page.getByRole('searchbox', { name: '搜索代理', exact: true }).fill(run); assert.equal(await page.locator('.pm-row').count(), 1);
    });
    await action('08-delete-owned-proxy', async () => {
        await press(page.getByRole('button', { name: '编辑 ' + run, exact: true }));
        await press(page.getByRole('button', { name: '删除代理', exact: true })); await confirm();
        await page.getByRole('status').filter({ hasText: '代理已删除' }).waitFor();
        assert.equal((await apiGet('/v1/previews')).registrations.some((row: any) => row.handle === handle), false);
    });
    assert.deepEqual(errors, []); log({ type: 'complete', cases: 8, errors: 0 });
    writeFileSync(out + '/result.json', JSON.stringify({ run, profile, cases: 8, errors, handle, origin }, null, 2));
} catch (error) {
    await shot('failure').catch(() => {}); writeFileSync(out + '/failure-body.txt', await page.locator('body').innerText().catch(() => ''));
    throw error;
} finally {
    if (handle) await fetch(api + '/v1/previews/' + handle, { method: 'DELETE', headers: { authorization: 'Bearer ' + credentials.token } }).catch(() => undefined);
    for (const context of contexts) await context.close(); await browser.close(); await upstream.close();
}
