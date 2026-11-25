import assert from 'node:assert/strict';
import { existsSync, readFileSync, mkdirSync, appendFileSync, writeFileSync } from 'node:fs';
import { decrypt } from '../../packages/hapla-cli/src/api/encryption';
assert.equal(process.env.HAPLA_ACCEPTANCE_STACK, 'dev-hapla'); assert(existsSync('/.dockerenv'));
const c = JSON.parse(readFileSync(process.env.HAPLA_ACCEPTANCE_CREDENTIALS || '/repo/.runtime/dev-credentials.json', 'utf8'));
const pw = await import(process.env.HAPLA_PLAYWRIGHT_MODULE || 'playwright-core');
const profile = process.env.PROFILE || 'desktop';
const origin = new URL(process.env.HAPLA_ACCEPTANCE_WEB_URL || 'http://web:8080').origin;
const api = process.env.HAPLA_SERVER_URL || 'http://server:3005';
const out = process.env.HAPLA_ACCEPTANCE_OUTPUT || '/repo/artifacts/first-question'; mkdirSync(out, { recursive: true });
const log = (value: object) => { const row = JSON.stringify({ at: new Date().toISOString(), profile, ...value }); appendFileSync(out + '/actions.ndjson', row + '\n'); console.log(row); };
const browser = await pw[profile === 'iphone' ? 'webkit' : 'chromium'].launch(profile === 'iphone' ? { env: { ...process.env, HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '', http_proxy: '', https_proxy: '' } } : { executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', args: ['--no-sandbox', '--no-proxy-server'] });
const viewport = profile === 'desktop' ? { width: 1440, height: 1000 } : profile === 'iphone' ? { width: 390, height: 844 } : { width: 360, height: 800 };
const context = await browser.newContext({ ...(profile === 'desktop' ? {} : pw.devices[profile === 'iphone' ? 'iPhone 13' : 'Pixel 7']), viewport, locale: 'zh-CN', recordVideo: { dir: out + '/video', size: viewport } });
await context.addInitScript(({ token, secret, origin }: any) => { if (location.origin === origin) localStorage.setItem('auth_credentials', JSON.stringify({ token, secret })); }, { ...c, origin });
const page = await context.newPage(); page.setDefaultTimeout(20000);
const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
async function sessions() { const r = await fetch(api + '/v1/sessions', { headers: { authorization: 'Bearer ' + c.token } }); assert(r.ok); return (await r.json()).sessions; }
async function state(id: string) { const row = (await sessions()).find((s: any) => s.id === id); return row?.agentState ? decrypt(Buffer.from(c.secret, 'base64url'), 'legacy', Buffer.from(row.agentState, 'base64')) : {}; }
async function shot(name: string) { await page.screenshot({ path: out + '/' + name + '.png', animations: 'disabled', scale: 'css' }); }
async function click(locator: any) { if (profile === 'desktop') await locator.click(); else await locator.tap(); }
async function image() {
    return Buffer.from(await page.evaluate(() => {
        const canvas = document.createElement('canvas'); canvas.width = 480; canvas.height = 240;
        const ctx = canvas.getContext('2d')!; ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, 480, 240);
        ctx.fillStyle = '#112244'; ctx.font = 'bold 64px sans-serif'; ctx.fillText('HAPLA 42', 45, 138);
        return canvas.toDataURL('image/png').split(',')[1];
    }), 'base64');
}
try {
    for (let attempt = 0; attempt < 30; attempt++) { const r = await page.goto(origin + '/new'); if (r && r.status() < 500) break; await page.waitForTimeout(500); } const prompt = page.getByRole('textbox', { name: 'Session prompt', exact: true }); await prompt.waitFor();
    await click(page.getByRole('button', { name: '选择工作目录', exact: true }));
    await page.getByRole('textbox', { name: '目录路径', exact: true }).fill('/workspace'); await click(page.getByRole('button', { name: '使用此路径', exact: true }));
    const before = new Set((await sessions()).map((s: any) => s.id));
    await prompt.fill('第一行');
    if (profile !== 'desktop') {
        await prompt.press('End'); await prompt.press('Enter'); await prompt.type('第二行');
        assert.equal(await prompt.inputValue(), '第一行\n第二行'); assert(new URL(page.url()).pathname.endsWith('/new'));
        assert.equal((await sessions()).length, before.size); log({ type: 'passed', name: 'phone-return-inserts-newline' });
    } else {
        await prompt.press('Shift+Enter'); assert.equal(await prompt.inputValue(), '第一行\n');
    }
    await prompt.evaluate(element => {
        element.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
        element.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '中文' }));
        element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true, cancelable: true }));
    });
    await page.waitForTimeout(150); assert(new URL(page.url()).pathname.endsWith('/new')); assert.equal((await sessions()).length, before.size);
    log({ type: 'passed', name: 'IME-confirmation-does-not-submit' });
    await prompt.fill('请读出图片中印着的全部文字，只回复图片文字。');
    const png = await image();
    // Exercise the actual native DOM paste listener with a browser File payload.
    await prompt.evaluate((element, data) => {
        const raw = atob(data); const bytes = Uint8Array.from(raw, character => character.charCodeAt(0));
        const transfer = new DataTransfer(); transfer.items.add(new File([bytes], 'first-question.png', { type: 'image/png' }));
        element.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: transfer }));
    }, png.toString('base64'));
    await page.getByRole('button', { name: 'Remove image 1', exact: true }).waitFor();
    const thumbnail = page.locator('img[src^="data:image/"]').first(); await thumbnail.waitFor();
    assert((await thumbnail.getAttribute('src'))!.length > 100); await shot('01-first-image-prepared');
    log({ type: 'passed', name: 'paste-produces-nonempty-thumbnail' });
    // Check the real file chooser too, then remove the extra image before send.
    const chooser = page.waitForEvent('filechooser'); await click(page.getByRole('button', { name: 'Attach image', exact: true }));
    await (await chooser).setFiles({ name: 'second-image.png', mimeType: 'image/png', buffer: png });
    await page.getByRole('button', { name: 'Remove image 2', exact: true }).waitFor(); await click(page.getByRole('button', { name: 'Remove image 2', exact: true }));
    log({ type: 'passed', name: 'image-picker-and-remove' });
    let uploads = 0;
    await page.route('**/v1/uploads/images', async route => {
        uploads++; const body = route.request().postDataJSON(); assert(body.images[0].data.length > 100);
        if (uploads === 1) await route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"acceptance upload failure"}' });
        else await route.continue();
    });
    await click(page.getByRole('button', { name: 'Start session', exact: true }));
    await page.getByText('Failed to upload images: 503', { exact: true }).waitFor();
    await click(page.getByRole('button', { name: /^(OK|确定|好|好的|确认)$/ }).last());
    assert.equal(await prompt.inputValue(), '请读出图片中印着的全部文字，只回复图片文字。');
    await page.getByRole('button', { name: 'Remove image 1', exact: true }).waitFor();
    const created = (await sessions()).filter((s: any) => !before.has(s.id)); assert.equal(created.length, 1);
    await shot('02-upload-failure-keeps-draft'); log({ type: 'passed', name: 'upload-failure-keeps-draft-and-image' });
    await click(page.getByRole('button', { name: 'Start session', exact: true }));
    await page.waitForURL(/\/session\/[^/]+$/, { timeout: 100000 }); const id = page.url().split('/session/')[1];
    assert.equal(id, created[0].id); assert.equal((await sessions()).filter((s: any) => !before.has(s.id)).length, 1); assert.equal(uploads, 2);
    const deadline = Date.now() + 120000;
    while (Date.now() < deadline) { const current = await state(id); if (current.codexInputs?.receipts?.some((r: any) => r.status === 'completed')) break; await page.waitForTimeout(300); }
    const final = await state(id); assert(final.codexInputs?.receipts?.some((r: any) => r.status === 'completed'), 'Native image turn must complete');
    await page.getByText(/HAPLA\s*42/, { exact: false }).last().waitFor();
    log({ type: 'passed', name: 'retry-reuses-session-and-native-Codex-reads-image', sessionId: id }); await shot('03-image-answer');
    const composer = page.locator('[id^="hapla-composer-"] textarea'); await composer.fill('保留第一行');
    if (profile !== 'desktop') { await composer.press('End'); await composer.press('Enter'); await composer.type('保留第二行'); assert.equal(await composer.inputValue(), '保留第一行\n保留第二行'); }
    else { await composer.press('Shift+Enter'); assert.equal(await composer.inputValue(), '保留第一行\n'); }
    assert.equal((await state(id)).codexInputs?.receipts?.filter((r: any) => r.status === 'completed').length, final.codexInputs.receipts.filter((r: any) => r.status === 'completed').length);
    assert.deepEqual(errors, []); log({ type: 'complete', errors: 0, sessionId: id }); writeFileSync(out + '/result.json', JSON.stringify({ profile, sessionId: id, uploads, errors }, null, 2));
} catch (error) { await shot('failure').catch(() => {}); writeFileSync(out + '/failure-body.txt', await page.locator('body').innerText().catch(() => '')); throw error; }
finally { await context.close(); await browser.close(); }
