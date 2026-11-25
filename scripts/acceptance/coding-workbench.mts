import assert from 'node:assert/strict';
import { existsSync, mkdirSync, appendFileSync, writeFileSync, readFileSync, openSync, rmSync } from 'node:fs';
import { randomBytes, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { authGetToken } from '../../packages/hapla-cli/src/api/auth';
import { writeCredentialsLegacy, writeSettings } from '../../packages/hapla-cli/src/persistence';
import { decrypt } from '../../packages/hapla-cli/src/api/encryption';
import { git } from '../../packages/hapla-cli/src/modules/git/gitProcess';
import { startResponsesFixture } from './fixtures/responses.mts';

assert(existsSync('/.dockerenv'), 'Acceptance must run inside Docker');
assert.equal(process.env.HAPLA_ACCEPTANCE_STACK, 'dev-hapla');
assert.equal(new URL(process.env.HAPLA_SERVER_URL!).hostname, 'server');
const api = process.env.HAPLA_SERVER_URL!; const origin = process.env.HAPLA_ACCEPTANCE_WEB_URL ?? 'http://web:8080';
const output = process.env.HAPLA_ACCEPTANCE_OUTPUT ?? '/repo/artifacts/coding-workbench'; mkdirSync(output, { recursive: true });
const log = (value: object) => { const line = JSON.stringify({ at: new Date().toISOString(), ...value }); appendFileSync(join(output, 'actions.ndjson'), line + '\n'); console.log(line); };
const profile = process.env.PROFILE ?? 'desktop';
const observations: any[] = [];
const provider = await startResponsesFixture(value => { observations.push(value); log(value); });
mkdirSync(process.env.CODEX_HOME!, { recursive: true });
writeFileSync(join(process.env.CODEX_HOME!, 'config.toml'), `model = "gpt-5.4"\nmodel_provider = "hapla_fixture"\nmodel_context_window = 262144\n[model_providers.hapla_fixture]\nname = "Hapla deterministic fixture"\nbase_url = "${provider.url}"\nwire_api = "responses"\nrequires_openai_auth = false\n`);
await waitFor(async () => fetch(api + '/health').then(response => response.ok).catch(() => false), value => value, 'development server health');
const secret = randomBytes(32); const token = await authGetToken(secret);
await writeCredentialsLegacy({ secret, token }); await writeSettings({ machineId: randomUUID(), machineIdConfirmedByServer: true });
const root = `/workspace/coding-acceptance-${randomUUID().slice(0, 8)}`; mkdirSync(root, { recursive: true });
await git(root, ['init', '-b', 'main']); await git(root, ['config', 'user.name', 'Hapla acceptance']); await git(root, ['config', 'user.email', 'acceptance@hapla.test']);
writeFileSync(join(root, 'tracked.txt'), 'original\n'); await git(root, ['add', '.']); await git(root, ['commit', '-m', 'fixture base']);
const visualBase = `export function WorkspaceHeader({ title }: { title: string }) {
    return (
        <header className="workspace-header">
            <h1>{title}</h1>
        </header>
    );
}
`;
mkdirSync(join(root, 'src/components'), { recursive: true });
writeFileSync(join(root, 'src/components/WorkspaceHeader.tsx'), visualBase);
await git(root, ['add', '.']); await git(root, ['commit', '-m', 'Add workspace header']);
const remote = root + '-remote.git'; mkdirSync(remote); await git(remote, ['init', '--bare']); await git(root, ['remote', 'add', 'origin', remote]);
const tools = root + '-tools'; mkdirSync(tools); const prRecord = join(output, 'pr-request.json'); const prMode = join(output, 'pr-mode');
writeFileSync(prMode, 'fail');
writeFileSync(join(tools, 'gh'), `#!/usr/bin/env node
const fs = require('node:fs'); const args = process.argv.slice(2);
if (args[1] === 'create') {
 if(fs.readFileSync(${JSON.stringify(prMode)}, 'utf8') === 'fail') { console.error('fixture PR creation temporarily unavailable'); process.exit(1); }
 fs.writeFileSync(${JSON.stringify(prRecord)}, JSON.stringify(args)); console.log('https://example.test/pull/1');
} else { console.log(JSON.stringify({url:'https://example.test/pull/1',state:'OPEN',statusCheckRollup:[{name:'acceptance-check',status:'COMPLETED',conclusion:'SUCCESS'}]})); }
`, { mode: 0o755 });
const daemonOutput = openSync(join(output, 'daemon.log'), 'a');
const daemon = spawn(process.execPath, ['/repo/packages/hapla-cli/dist/index.mjs', 'daemon', 'start-sync'], { cwd: root, env: { ...process.env, PATH: tools + ':' + process.env.PATH }, stdio: ['ignore', daemonOutput, daemonOutput] });
process.once('exit', () => { daemon.kill('SIGTERM'); });
const pw = await import(process.env.HAPLA_PLAYWRIGHT_MODULE || '/opt/hapla-browser/node_modules/playwright/index.mjs');
const browser = await pw[profile === 'iphone' ? 'webkit' : 'chromium'].launch({ headless: true, ...(profile === 'iphone' ? {} : { args: ['--no-sandbox'], ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}) }) });
const context = await browser.newContext({ ...(profile === 'desktop' ? { viewport: { width: 1440, height: 1000 } } : pw.devices[profile === 'iphone' ? 'iPhone 13' : 'Pixel 7']), locale: 'en-US', recordVideo: { dir: join(output, 'video') } });
await context.addInitScript(({ token, secret }) => { localStorage.setItem('auth_credentials', JSON.stringify({ token, secret })); }, { token, secret: secret.toString('base64url') });
const page = await context.newPage();
page.on('requestfailed', request => { const url = new URL(request.url()); log({ type: 'request-failed', method: request.method(), url: url.origin + url.pathname, error: request.failure()?.errorText }); });
page.setDefaultTimeout(30_000); const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
const headers = { authorization: 'Bearer ' + token };
async function sessions() { const response = await fetch(api + '/v1/sessions', { headers }); assert(response.ok); return (await response.json()).sessions; }
async function waitFor<T>(read: () => Promise<T>, ready: (value: T) => boolean, label: string): Promise<T> {
    const deadline = Date.now() + 60_000; let value: T;
    do { value = await read(); if (ready(value)) return value; await new Promise(resolve => setTimeout(resolve, 200)); } while (Date.now() < deadline);
    throw new Error(`Timed out: ${label}`);
}
const click = (locator: any) => profile === 'desktop' ? locator.click() : locator.tap();
const openChanges = async () => {
    const changes = page.getByRole('button', { name: 'Changes', exact: true });
    if (!await changes.isVisible()) await click(page.getByRole('button', { name: 'Coder 模式', exact: true }));
    await click(changes);
};
const openFiles = async () => {
    const toggle = page.getByRole('button', { name: /^Changed files/ });
    if (await toggle.getAttribute('aria-expanded') === 'false') await click(toggle);
};
const shot = (name: string) => page.screenshot({ path: join(output, name + '.png'), animations: 'disabled', scale: 'css' });
try {
    await waitFor(async () => (await fetch(api + '/v1/machines', { headers })).json(), data => (Array.isArray(data) ? data : data.machines ?? []).some((m: any) => m.active), 'test machine online');
    await page.goto(origin + '/new');
    await click(page.getByRole('button', { name: '选择工作目录', exact: true }));
    await page.getByRole('textbox', { name: '目录路径', exact: true }).fill(root); await click(page.getByRole('button', { name: '使用此路径', exact: true }));
    await click(page.getByRole('button', { name: /^Select worktree mode/ }));
    await click(page.getByText('new worktree', { exact: true }));
    await page.getByRole('textbox', { name: 'Session prompt', exact: true }).fill('HAPLA_FIXTURE_READ');
    await click(page.getByRole('button', { name: 'Start session', exact: true }));
    await page.waitForURL(/\/session\//);
    const sessionId = new URL(page.url()).pathname.split('/').pop()!;
    let record = await waitFor(async () => (await sessions()).find((s: any) => s.id === sessionId), s => !!s?.metadata, 'native session metadata');
    let metadata: any = decrypt(secret, 'legacy', Buffer.from(record.metadata, 'base64'));
    const worktree = metadata.path; assert(worktree.includes('/.dev/worktree/'));
    await page.getByText('HAPLA_FIXTURE_DONE', { exact: true }).last().waitFor();
    const composer = () => page.locator('[id^="hapla-composer-"] textarea').first();
    await composer().fill('HAPLA_FIXTURE_EDIT'); await click(page.getByRole('button', { name: 'Send message', exact: true }));
    await waitFor(async () => existsSync(join(worktree, 'native-new.txt')), value => value, 'real Codex tool edit');
    await page.getByText('HAPLA_FIXTURE_DONE', { exact: true }).last().waitFor();
    await waitFor(async () => { const s = (await sessions()).find((s: any) => s.id === sessionId); return s?.agentState ? decrypt(secret, 'legacy', Buffer.from(s.agentState, 'base64')) as any : null; }, state => state?.codexInputs?.receipts?.at(-1)?.status === 'completed', 'second native turn settled');
    log({ type: 'passed', name: 'new-worktree-real-native-edit' });
    // Real files in this test repository exercise code density, nested paths, and mixed statuses.
    writeFileSync(join(worktree, 'src/components/WorkspaceHeader.tsx'), `type WorkspaceHeaderProps = {
    title: string;
    branch: string;
    pending: boolean;
    onReview: () => void;
};

export function WorkspaceHeader({ title, branch, pending, onReview }: WorkspaceHeaderProps) {
    return (
        <header className="workspace-header">
            <div className="workspace-heading">
                <h1>{title}</h1>
                <span className="workspace-branch">{branch}</span>
            </div>
            <button disabled={pending} onClick={onReview}>
                {pending ? 'Loading changes…' : 'Review changes'}
            </button>
        </header>
    );
}
`);
    mkdirSync(join(worktree, 'src/hooks'), { recursive: true });
    writeFileSync(join(worktree, 'src/hooks/useChanges.ts'), `import { useState } from 'react';

export function useChanges() {
    const [selectedPath, setSelectedPath] = useState<string | null>(null);
    const [source, setSource] = useState('working');

    function selectFile(path: string) {
        setSelectedPath(path);
    }

    return { selectedPath, source, setSource, selectFile };
}
`);
    await openChanges();
    const diff = page.getByRole('generic', { name: 'Diff', exact: true });
    await page.locator('.hapla-git-line--add').filter({ hasText: 'fixture-new-file' }).waitFor();
    await shot('01-unstaged-and-new-files');
    const originalBackground = await page.locator('.hapla-git').evaluate(node => getComputedStyle(node).backgroundColor);
    await page.emulateMedia({ colorScheme: 'dark' });
    await waitFor(() => page.locator('.hapla-git').evaluate(node => getComputedStyle(node).backgroundColor), color => color !== originalBackground, 'dark theme updates the whole workbench');
    const darkIconColors = await page.locator('.hapla-git-header-actions').evaluate(node => Array.from(node.querySelectorAll('button *')).map(icon => getComputedStyle(icon).color));
    assert(!darkIconColors.includes('rgb(0, 0, 0)'), 'icons must inherit readable dark-theme colors');
    const primaryContrast = await page.locator('.hapla-git-button--primary').evaluate(node => {
        const style = getComputedStyle(node);
        const luminances = [style.color, style.backgroundColor].map(color => {
            const values = (color.match(/[\d.]+/g) ?? []).slice(0, 3).map(value => Number(value) / 255).map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4);
            return .2126 * values[0] + .7152 * values[1] + .0722 * values[2];
        });
        const [text, background] = luminances;
        return { ratio: (Math.max(text, background) + .05) / (Math.min(text, background) + .05), foreground: style.color, background: style.backgroundColor };
    });
    log({ type: 'contrast', ...primaryContrast });
    assert(primaryContrast.ratio >= 4.5, 'primary action colors must meet AA text contrast');
    await shot('01-dark');
    await page.emulateMedia({ colorScheme: 'light' });
    await waitFor(() => page.locator('.hapla-git').evaluate(node => getComputedStyle(node).backgroundColor), color => color === originalBackground, 'light theme restored');
    const layout = await page.locator('.hapla-git').evaluate(node => ({ width: node.clientWidth, scrollWidth: node.scrollWidth }));
    assert(layout.scrollWidth <= layout.width + 1, 'workbench must not overflow horizontally');
    if (profile !== 'desktop') {
        const code = await page.locator('.hapla-git-diff').boundingBox(); assert(code && code.y < 300, 'code must be visible in the first mobile viewport');
    }
    await openFiles();
    const filter = page.getByRole('textbox', { name: 'Filter files', exact: true });
    await filter.fill('workspaceheader');
    assert.equal(await page.locator('.hapla-git-file').count(), 1);
    await filter.fill('does-not-exist'); await page.getByText('No matching files', { exact: true }).waitFor();
    await filter.fill('');
    if (profile === 'desktop') {
        await filter.focus(); await page.keyboard.press('Tab');
        const outline = await page.evaluate(() => getComputedStyle(document.activeElement!).outlineStyle);
        assert.notEqual(outline, 'none', 'keyboard focus must remain visible');
    }
    log({ type: 'passed', name: 'light-dark-contrast-filter-keyboard-and-mobile-code-first' });
    await click(page.getByRole('button', { name: 'Turn', exact: true }));
    const checkpoint = page.locator('.hapla-git-checkpoint').filter({ hasText: 'HAPLA_FIXTURE_EDIT' }).first(); await click(checkpoint);
    await waitFor(() => page.locator('.hapla-git-diff').textContent(), text => !!text?.includes('+fixture-native-edit'), 'turn diff');
    page.once('dialog', dialog => dialog.accept());
    await click(page.getByRole('button', { name: 'Restore files and conversation', exact: true }));
    await page.getByRole('status').getByText('Workspace and conversation restored on a new branch.', { exact: true }).waitFor();
    await waitFor(async () => readFileSync(join(worktree, 'tracked.txt'), 'utf8'), text => text === 'original\n', 'native-coordinated restore');
    assert(!existsSync(join(worktree, 'native-new.txt')));
    assert.equal(readFileSync(join(worktree, 'src/components/WorkspaceHeader.tsx'), 'utf8'), visualBase);
    assert(!existsSync(join(worktree, 'src/hooks/useChanges.ts')));
    metadata = await waitFor(async () => {
        const value = (await sessions()).find((s: any) => s.id === sessionId);
        return value?.metadata ? decrypt(secret, 'legacy', Buffer.from(value.metadata, 'base64')) as any : null;
    }, value => value?.codexBranches?.length >= 2 && value.codexThreadId === value.activeCodexBranchId, 'persisted restored native thread and branch');
    assert(metadata.codexBranches.length >= 2); assert.equal(metadata.codexThreadId, metadata.activeCodexBranchId);
    log({ type: 'passed', name: 'workspace-and-native-thread-restored' }); await shot('02-restored');
    await page.goto(origin + '/session/' + sessionId);
    await composer().waitFor(); assert.equal(await page.getByText('HAPLA_FIXTURE_EDIT', { exact: true }).count(), 0);
    await composer().fill('HAPLA_FIXTURE_READ'); await click(page.getByRole('button', { name: 'Send message', exact: true }));
    await waitFor(async () => observations.filter(item => item.action === 'read' && item.toolOutputs > 0).at(-1), item => !!item && item.userMarkers.length === 2 && item.userMarkers.every((marker: string) => marker === 'HAPLA_FIXTURE_READ') && item.observedOriginal && item.tools.includes('mcp__hapla'), 'restored native history and filesystem continued together');
    log({ type: 'passed', name: 'restored-native-history-continues-without-discarded-turn' });
    const usage: any = await waitFor(async () => {
        const value = (await sessions()).find((s: any) => s.id === sessionId);
        return value?.metadata ? (decrypt(secret, 'legacy', Buffer.from(value.metadata, 'base64')) as any).contextUsage : null;
    }, usage => !!usage && usage.contextWindow > 0 && usage.threadId === metadata.codexThreadId, 'native model context capacity');
    assert.notEqual(usage.contextWindow, 190000); assert(usage.usedTokens >= 0);
    log({ type: 'passed', name: 'native-context-capacity', capacity: usage.contextWindow, usedTokens: usage.usedTokens });
    await openChanges();
    writeFileSync(join(worktree, 'review file.txt'), 'reviewable content\n');
    await click(page.getByRole('button', { name: 'Refresh', exact: true }));
    const message = page.getByRole('textbox', { name: 'Commit message', exact: true }); await message.fill('acceptance commit');
    await click(page.getByRole('button', { name: 'Commit staged changes', exact: true }));
    await page.getByRole('alert').waitFor(); assert.equal(await message.inputValue(), 'acceptance commit');
    log({ type: 'passed', name: 'failed-commit-keeps-draft' });
    await openFiles(); await click(page.getByRole('button', { name: 'Stage review file.txt', exact: true }));
    await click(page.getByRole('button', { name: 'Staged', exact: true }));
    await waitFor(() => page.locator('.hapla-git-diff').textContent(), text => !!text?.includes('+reviewable content'), 'staged diff');
    await click(page.getByRole('button', { name: 'Unstage review file.txt', exact: true }));
    await openFiles(); await click(page.getByRole('button', { name: 'Stage review file.txt', exact: true }));
    await click(page.getByRole('button', { name: 'Commit staged changes', exact: true }));
    await waitFor(() => message.inputValue(), text => text === '', 'successful commit clears draft');
    await click(page.getByRole('button', { name: 'Commit', exact: true }));
    await waitFor(() => page.locator('.hapla-git-diff').textContent(), text => !!text?.includes('+reviewable content'), 'commit diff');
    page.once('dialog', dialog => dialog.accept()); await click(page.getByRole('button', { name: 'Push branch', exact: true }));
    await waitFor(async () => git(remote, ['rev-parse', `refs/heads/${await git(worktree, ['branch', '--show-current']).then(s => s.trim())}`]).catch(() => ''), value => !!value, 'push to isolated local remote');
    assert.equal((await git(remote, ['rev-parse', `refs/heads/${metadata.path.split('/').pop()}`])).trim(), (await git(worktree, ['rev-parse', 'HEAD'])).trim());
    await click(page.getByText('Create draft PR', { exact: true }).first());
    const prTitle = page.getByRole('textbox', { name: 'Pull request title', exact: true });
    const prBody = page.getByRole('textbox', { name: 'Pull request description', exact: true });
    await prTitle.fill('Review acceptance'); await prBody.fill('Verified in isolated development.');
    page.once('dialog', dialog => dialog.accept()); await click(page.getByRole('button', { name: 'Create draft PR', exact: true }));
    await page.getByRole('alert').waitFor(); assert.equal(await prTitle.inputValue(), 'Review acceptance'); assert.equal(await prBody.inputValue(), 'Verified in isolated development.');
    writeFileSync(prMode, 'success'); page.once('dialog', dialog => dialog.accept()); await click(page.getByRole('button', { name: 'Create draft PR', exact: true }));
    await page.getByRole('link', { name: /example.test\/pull\/1/ }).waitFor();
    const prArguments = JSON.parse(readFileSync(prRecord, 'utf8')); assert(prArguments.includes('--draft')); assert(prArguments.includes('Review acceptance'));
    await click(page.getByRole('button', { name: 'Load PR and checks', exact: true })); await page.getByText('acceptance-check: SUCCESS', { exact: true }).waitFor();
    log({ type: 'passed', name: 'PR-adapter-failure-retry-draft-and-check-results', transport: 'fixture gh executable; no live GitHub writes' });
    await page.reload(); await page.getByRole('button', { name: 'Refresh', exact: true }).waitFor();
    assert((await git(worktree, ['log', '-1', '--format=%s'])).includes('acceptance commit'));
    log({ type: 'passed', name: 'stage-unstage-commit-push-and-reload' });
    writeFileSync(join(worktree, 'large-review.txt'), Array.from({ length: 18000 }, (_, i) => `${i}: 中文 mixed content\n`).join(''));
    await click(page.getByRole('button', { name: 'Unstaged + new files', exact: true }));
    await click(page.getByRole('button', { name: 'Refresh', exact: true }));
    const more = page.getByRole('button', { name: /^Load more diff/ }); await more.waitFor();
    for (let pageNumber = 0; pageNumber < 10 && await more.count(); pageNumber++) {
        const previous = await page.locator('.hapla-git-diff').getAttribute('data-total-lines'); await click(more);
        await waitFor(() => page.locator('.hapla-git-diff').getAttribute('data-total-lines'), count => count !== null && Number(count) > Number(previous), 'next UTF-8 diff page');
    }
    log({ type: 'diff-pages-loaded', rows: await page.locator('.hapla-git-diff').getAttribute('data-total-lines') });
    assert(await page.locator('.hapla-git-line').count() < 200, 'large patch must bound DOM cost');
    await page.locator('.hapla-git-diff').evaluate(node => { node.scrollTop = node.scrollHeight; });
    await waitFor(() => page.locator('.hapla-git-diff').textContent(), text => !!text?.includes('17999: 中文 mixed content'), 'last virtualized diff line');
    await click(page.getByRole('button', { name: 'Raw patch', exact: true }));
    const fullDiff = await page.locator('.hapla-git-diff').textContent();
    assert(fullDiff?.includes('+17999: 中文 mixed content')); assert(!fullDiff.includes('�'));
    await click(page.getByRole('button', { name: 'Formatted diff', exact: true }));
    await shot('04-large-complete-diff'); rmSync(join(worktree, 'large-review.txt'));
    await click(page.getByRole('button', { name: 'Against base', exact: true }));
    await click(page.getByRole('button', { name: 'Refresh', exact: true }));
    await openFiles(); await page.getByRole('button', { name: /review file.txt/ }).waitFor();
    log({ type: 'passed', name: 'complete-large-UTF8-diff-and-branch-file-list' });
    await message.fill('offline draft'); await context.setOffline(true);
    await click(page.getByRole('button', { name: 'Refresh', exact: true }));
    await page.getByRole('alert').waitFor(); assert.equal(await message.inputValue(), 'offline draft');
    assert.equal(await page.getByRole('button', { name: 'Commit staged changes', exact: true }).isDisabled(), true, 'Failed workspace reads block mutations');
    await context.setOffline(false);
    await click(page.getByRole('button', { name: 'Refresh', exact: true }));
    await page.locator('.hapla-git-diff').waitFor();
    await waitFor(() => page.locator('.hapla-git-diff').textContent(), text => !!text?.includes('reviewable content'), 'retry reloads a failed diff at the same Git revision');
    assert.equal(await message.inputValue(), 'offline draft');
    await waitFor(() => page.getByRole('button', { name: 'Commit staged changes', exact: true }).isEnabled(), value => value, 'successful status reload enables mutations');
    log({ type: 'passed', name: 'offline-failure-keeps-draft-and-diff-retry-recovers' });
    if (profile !== 'desktop') { await page.setViewportSize({ width: 844, height: 390 }); await click(page.getByRole('button', { name: 'Staged', exact: true })); await shot('04-landscape'); }
    await shot('03-final'); assert.deepEqual(errors, []); log({ type: 'complete', profile, sessionId, worktree });
} catch (error) { await shot('failure').catch(() => undefined); writeFileSync(join(output, 'failure-body.txt'), await page.locator('body').innerText().catch(() => '')); throw error; }
finally {
    for (const record of await sessions().catch(() => [])) {
        const metadata: any = decrypt(secret, 'legacy', Buffer.from(record.metadata, 'base64'));
        if (metadata.hostPid) { try { process.kill(metadata.hostPid, 'SIGTERM'); } catch {} }
    }
    daemon.kill('SIGTERM'); await context.close(); await browser.close(); await provider.close(); }
