import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { randomBytes, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { authGetToken } from '../../packages/hapla-cli/src/api/auth';
import { encryptLegacy } from '../../packages/hapla-cli/src/api/encryption';

assert(existsSync('/.dockerenv'), 'Run navigation acceptance inside Docker');
assert.equal(process.env.HAPLA_ACCEPTANCE_STACK, 'dev-hapla');
const api = process.env.HAPLA_SERVER_URL!;
assert.equal(new URL(api).hostname, 'server');
const origin = process.env.HAPLA_ACCEPTANCE_WEB_URL ?? 'http://web:8080';
const output = process.env.HAPLA_ACCEPTANCE_OUTPUT ?? '/repo/artifacts/session-navigation';
mkdirSync(output, { recursive: true });
const log = (value: object) => { const line = JSON.stringify(value); appendFileSync(join(output, 'actions.ndjson'), line + '\n'); console.log(line); };
const secret = randomBytes(32), token = await authGetToken(secret);
const ids: string[] = [];
for (const name of ['Navigation fixture A', 'Navigation fixture B']) {
    const metadata = { name, path: '/workspace/navigation-fixture', host: 'navigation-fixture', homeDir: '/workspace', version: '1.0.0', os: 'linux', flavor: 'codex', machineId: randomUUID() };
    const response = await fetch(api + '/v1/sessions', { method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, body: JSON.stringify({ tag: randomUUID(), metadata: Buffer.from(encryptLegacy(metadata, secret)).toString('base64'), agentState: null }) });
    assert(response.ok, 'Create isolated navigation fixture');
    ids.push((await response.json()).session.id);
}
const pw = await import(process.env.HAPLA_PLAYWRIGHT_MODULE || '/opt/hapla-browser/node_modules/playwright/index.mjs');
const profile = process.env.PROFILE ?? 'desktop';
const browser = await pw[profile === 'iphone' ? 'webkit' : 'chromium'].launch({ headless: true, ...(profile === 'iphone' ? {} : { args: ['--no-sandbox'], executablePath: process.env.CHROMIUM_PATH }) });
const context = await browser.newContext({ ...(profile === 'desktop' ? { viewport: { width: 1440, height: 1000 } } : pw.devices[profile === 'iphone' ? 'iPhone 13' : 'Pixel 7']), recordVideo: { dir: join(output, 'video') }, locale: 'en-US' });
await context.addInitScript(({ token, secret }) => localStorage.setItem('auth_credentials', JSON.stringify({ token, secret })), { token, secret: secret.toString('base64url') });
const page = await context.newPage(); page.setDefaultTimeout(15_000);
const errors: string[] = [], results: { name: string; passed: boolean; error?: string }[] = [];
page.on('pageerror', error => errors.push(error.message));
const click = (locator: any) => profile === 'desktop' ? locator.click() : locator.tap();
const open = async (id: string) => { await page.goto(origin + '/session/' + id); await page.getByRole('button', { name: 'Back', exact: true }).waitFor(); };
const backToList = async () => {
    await click(page.getByRole('button', { name: 'Back', exact: true }));
    await page.waitForURL(url => url.pathname === '/', { timeout: 5000 });
    await page.getByText('Navigation fixture A', { exact: true }).first().waitFor();
    assert.equal(await page.locator('[id^="hapla-composer-"]').count(), 0, 'Session content closes');
};
const run = async (name: string, action: () => Promise<void>) => {
    try { await action(); results.push({ name, passed: true }); log({ name, passed: true }); }
    catch (error) { const message = error instanceof Error ? error.message : String(error); results.push({ name, passed: false, error: message }); log({ name, passed: false, url: page.url(), error: message }); }
    await page.screenshot({ path: join(output, name + '.png'), scale: 'css' });
};
try {
    await run('direct-link', async () => { await open(ids[0]); await backToList(); });
    await run('reload', async () => { await open(ids[0]); await page.reload(); await backToList(); });
    await run('external-history', async () => { await page.goto(origin + '/settings'); await open(ids[0]); await backToList(); });
    await run('list-selection', async () => {
        await page.goto(origin + '/'); await click(page.getByText('Navigation fixture A', { exact: true }).first());
        await page.waitForURL('**/session/' + ids[0]); await backToList();
        await click(page.getByText('Navigation fixture B', { exact: true }).first());
        await page.waitForURL('**/session/' + ids[1]); await backToList();
    });
    await run('workbench-return', async () => {
        await open(ids[0]);
        await click(page.getByRole('button', { name: 'Coder 模式', exact: true }));
        await click(page.getByRole('button', { name: 'Changes', exact: true }));
        await page.waitForURL('**/session/' + ids[0] + '/git');
        await click(page.getByRole('button', { name: 'Back to conversation', exact: true }));
        await page.waitForURL('**/session/' + ids[0]);
        await backToList();
    });
    await run('workbench-direct-link', async () => {
        await page.goto(origin + '/session/' + ids[0] + '/git');
        await click(page.getByRole('button', { name: 'Back to conversation', exact: true }));
        await page.waitForURL('**/session/' + ids[0]);
        await backToList();
    });
    if (profile === 'desktop') await run('switch-conversations', async () => {
        await open(ids[0]); await click(page.getByText('Navigation fixture B', { exact: true }).first());
        await page.waitForURL('**/session/' + ids[1]); await backToList();
    });
    else await run('landscape', async () => {
        await page.setViewportSize({ width: 844, height: 390 }); await open(ids[0]); await backToList();
    });
    const result = { profile, results, errors, passed: results.every(result => result.passed) && errors.length === 0 };
    writeFileSync(join(output, 'result.json'), JSON.stringify(result, null, 2));
    assert(result.passed, 'Navigation browser cases must pass');
} finally { await context.close(); await browser.close(); }
