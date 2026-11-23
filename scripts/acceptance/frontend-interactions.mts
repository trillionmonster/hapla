import { readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync } from 'node:fs';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { decrypt } from '../../packages/hapla-cli/src/api/encryption';
// Opt-in browser acceptance. Account/history/auth are fixtures; all tested feature
// mutations go through the UI. Backend reads provide independent assertions.
assert.equal(process.env.HAPLA_ACCEPTANCE_STACK, 'dev-hapla', 'Run only in the isolated dev-hapla stack');
assert(existsSync('/.dockerenv'), 'Run the browser and CLI inside Docker');
const webOrigin = new URL(process.env.HAPLA_ACCEPTANCE_WEB_URL || 'http://web:8080').origin;
const apiOrigin = new URL(process.env.HAPLA_SERVER_URL || 'http://server:3005').origin;
const playwright = await import(process.env.HAPLA_PLAYWRIGHT_MODULE || 'playwright-core');
const stage = process.env.STAGE || 'main';
const mobileProfile = stage === 'mobile' ? process.env.HAPLA_ACCEPTANCE_MOBILE_PROFILE || 'android' : null;
assert(!mobileProfile || ['android', 'iphone'].includes(mobileProfile), 'Unknown mobile profile');
const browserName = mobileProfile === 'iphone' ? 'webkit' : 'chromium';
const device = mobileProfile ? playwright.devices[mobileProfile === 'iphone' ? 'iPhone 13' : 'Pixel 7'] : {};
const phoneViewport = mobileProfile === 'iphone' ? { width: 390, height: 844 } : { width: 360, height: 800 };
const c = JSON.parse(
  readFileSync(process.env.HAPLA_ACCEPTANCE_CREDENTIALS || '/repo/.runtime/dev-credentials.json', 'utf8'),
);
for (const field of ['token', 'secret', 'otherToken', 'historySessionId'])
  assert(typeof c[field] === 'string' && c[field], 'Missing private acceptance fixture field: ' + field);
const out = process.env.HAPLA_ACCEPTANCE_OUTPUT || '/repo/artifacts/frontend-interactions';
mkdirSync(out, { recursive: true });
assert(
  [
    'main',
    'queue-safety',
    'controls',
    'questions',
    'freshness',
    'history-mobile',
    'preview',
    'logout',
    'contexts',
    'mobile',
  ].includes(stage),
  'Unknown acceptance stage',
);
const progressFile = out + '/progress.json';
let progress: any = existsSync(progressFile)
  ? JSON.parse(readFileSync(progressFile, 'utf8'))
  : { run: 'ui-' + Date.now().toString(36) };
if ((stage === 'main' || stage === 'mobile') && !process.env.RESUME_CASE)
  progress = { run: (mobileProfile ? 'mobile-' + mobileProfile + '-' : 'ui-') + Date.now().toString(36) };
if (stage !== 'main' && stage !== 'mobile')
  assert(progress.sessionId, 'Run the main stage first in this output directory');
const run = progress.run;
const events: any[] = [];
const errors: string[] = [];
const log = (event: any) => {
  const value = { at: new Date().toISOString(), run, stage, browser: browserName, mobileProfile, ...event };
  events.push(value);
  appendFileSync(out + '/actions.ndjson', JSON.stringify(value) + '\n');
  console.log(JSON.stringify(value));
};
function save() {
  writeFileSync(progressFile, JSON.stringify(progress, null, 2));
}
const browser = await playwright[browserName].launch(
  browserName === 'chromium'
    ? {
        executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium',
        headless: true,
        args: [
          '--no-sandbox',
          '--disable-dev-shm-usage',
          '--no-proxy-server',
          '--unsafely-treat-insecure-origin-as-secure=' + webOrigin,
        ],
      }
    : {
        headless: true,
        env: {
          ...process.env,
          HTTP_PROXY: '',
          HTTPS_PROXY: '',
          ALL_PROXY: '',
          http_proxy: '',
          https_proxy: '',
        },
      },
);
const context = await browser.newContext({
  ...device,
  viewport: mobileProfile ? phoneViewport : { width: 1440, height: 1050 },
  locale: 'zh-CN',
  hasTouch: !!mobileProfile || stage === 'history-mobile',
  isMobile: !!mobileProfile || stage === 'history-mobile',
  recordVideo: { dir: out + '/video', size: mobileProfile ? phoneViewport : { width: 1440, height: 1050 } },
});
if (browserName === 'chromium')
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: webOrigin });
await context.addInitScript(({ token, secret }: any) => {
  if (!sessionStorage.getItem('acceptance-auth-initialized')) {
    localStorage.setItem('auth_credentials', JSON.stringify({ token, secret }));
    sessionStorage.setItem('acceptance-auth-initialized', '1');
  }
}, c);
await context.exposeBinding('recordAcceptanceAction', (_source: any, action: any) =>
  log({ type: 'ui', ...action }),
);
await context.addInitScript(() => {
  document.addEventListener(
    'pointerdown',
    (event) => {
      const node = (event.target as Element)?.closest('button,[role=button],a,select,textarea');
      if (node)
        (window as any).recordAcceptanceAction({
          path: location.pathname,
          event: 'pointer',
          pointerType: event.pointerType,
          label: node.getAttribute('aria-label') ?? node.textContent?.trim().slice(0, 80),
        });
    },
    true,
  );
  document.addEventListener(
    'click',
    (event) => {
      const node = (event.target as Element)?.closest('button,[role=button],a,select,[tabindex="0"]');
      if (node)
        (window as any).recordAcceptanceAction({
          path: location.pathname,
          event: 'click',
          label: node.getAttribute('aria-label') ?? node.textContent?.trim().slice(0, 80),
        });
    },
    true,
  );
  document.addEventListener(
    'input',
    (event) => {
      const node = event.target as HTMLInputElement;
      if (node.type !== 'password')
        (window as any).recordAcceptanceAction({
          path: location.pathname,
          event: 'input',
          label: node.getAttribute('aria-label') ?? node.getAttribute('placeholder'),
          length: node.value?.length,
        });
    },
    true,
  );
  document.addEventListener(
    'keydown',
    (event) => {
      if (
        ['Enter', 'Escape', 'Tab', 'Home', 'End', 'ArrowUp', 'ArrowDown'].includes(event.key) ||
        event.ctrlKey ||
        event.metaKey
      )
        (window as any).recordAcceptanceAction({
          path: location.pathname,
          event: 'key',
          key: event.key,
          ctrl: event.ctrlKey,
          shift: event.shiftKey,
          meta: event.metaKey,
        });
    },
    true,
  );
});
const recordedPages: any[] = [];
context.on('page', (p) => recordedPages.push(p));
const page = await context.newPage();
page.setDefaultTimeout(15000);
page.on('pageerror', (e) => errors.push(e.message));
const key = Buffer.from(c.secret, 'base64url');
async function state() {
  const r = await fetch(apiOrigin + '/v1/sessions', { headers: { authorization: 'Bearer ' + c.token } });
  assert(r.ok);
  const { sessions } = await r.json();
  const selected = page.url().split('/session/')[1]?.split(/[/?]/)[0] || progress.sessionId;
  const s = sessions.find((s: any) => s.id === selected);
  if (!s) return {};
  return {
    ...s,
    agentState: s.agentState ? decrypt(key, 'legacy', Buffer.from(s.agentState, 'base64')) : null,
    metadata: decrypt(key, 'legacy', Buffer.from(s.metadata, 'base64')),
  };
}
async function wait(check: (s: any) => boolean, label: string, timeout = 100000) {
  const end = Date.now() + timeout;
  let s: any;
  while (Date.now() < end) {
    s = await state();
    if (check(s)) return s;
    await page.waitForTimeout(250);
  }
  log({
    type: 'timeout',
    label,
    runtime: s?.agentState?.codexRuntime,
    queue: s?.agentState?.codexInputs,
    side: s?.agentState?.codexSideChats?.map((v: any) => ({ status: v.status, error: v.error })),
  });
  throw Error('Timeout: ' + label);
}
async function test(name: string, fn: () => Promise<void>) {
  if (process.env.RESUME_CASE && Number(name.slice(0, 2)) < Number(process.env.RESUME_CASE)) return;
  log({ type: 'start', name });
  await fn();
  const s = await state();
  log({
    type: 'pass',
    name,
    evidence: {
      runtime: s.agentState?.codexRuntime,
      queue: s.agentState?.codexInputs,
      side: s.agentState?.codexSideChats?.map((c: any) => ({
        id: c.id,
        threadId: c.threadId,
        status: c.status,
        messages: c.messages.length,
      })),
    },
  });
}
async function shot(name: string) {
  await page.screenshot({
    path: out + '/' + stage + '-' + name + '.png',
    animations: 'disabled',
    scale: mobileProfile ? 'css' : 'device',
  });
}
const composer = () => page.locator('[id^="hapla-composer-"] textarea');
async function loadAllQuestions() {
  const panel = page.getByLabel('历史问题面板');
  const end = page.getByText('已加载本会话全部问题', { exact: true });
  const more = page.getByRole('button', { name: '加载更早的问题', exact: true });
  for (let i = 0; i < 12; i++) {
    await end.or(more).waitFor();
    if (await end.count()) return;
    const count = await panel.getByText(/^历史问题 \d{3}/).count();
    await more[mobileProfile ? 'tap' : 'click']();
    await page.waitForFunction((before) => {
      const panel = document.querySelector('[aria-label="历史问题面板"]');
      return panel?.textContent?.includes('已加载本会话全部问题') ||
        (panel?.textContent?.match(/历史问题 \d{3}/g)?.length ?? 0) > before;
    }, count);
  }
  await end.waitFor();
}
async function choose(label: string) {
  if (mobileProfile) {
    await page.getByRole('button', { name: '选择发送方式', exact: true }).tap();
    await page.getByRole('menuitemradio', { name: label, exact: true }).tap();
  } else {
    await page.getByRole('button', { name: '选择发送方式', exact: true }).click();
    await page.getByRole('menuitemradio', { name: label, exact: true }).click();
  }
}
async function send(text: string, mode?: string) {
  if (mode) await choose(mode);
  await composer().fill(text);
  if (mobileProfile || stage === 'history-mobile')
    await page.getByRole('button', { name: 'Send message', exact: true }).tap();
  else await composer().press('Enter');
  await page.waitForFunction(() =>
    Array.from(document.querySelectorAll('[id^="hapla-composer-"] textarea')).every(
      (t) => (t as HTMLTextAreaElement).value === '',
    ),
  );
  log({
    type: 'action',
    action: mobileProfile || stage === 'history-mobile' ? 'composer-tap-send' : 'composer-enter',
    mode,
    text,
  });
}
async function queueOpen() {
  if (!(await page.getByLabel('待发送队列', { exact: true }).count()))
    await page
      .getByRole('button', { name: '查看待发送队列', exact: true })
      [mobileProfile ? 'tap' : 'click']();
}
async function dismiss() {
  await page.keyboard.press('Escape');
}
async function terminalOpen() {
  const mode = page.getByRole('button', { name: 'Coder 模式', exact: true });
  if ((await mode.getAttribute('aria-pressed')) !== 'true') await mode[mobileProfile ? 'tap' : 'click']();
  if (!(await page.locator('.xterm-helper-textarea').count()))
    await page.getByRole('button', { name: 'Terminal', exact: true })[mobileProfile ? 'tap' : 'click']();
  await page.locator('.xterm-helper-textarea').waitFor();
  await page.waitForTimeout(600);
  if (mobileProfile) await page.getByRole('button', { name: 'Open terminal keyboard', exact: true }).tap();
  await page.locator('.xterm-helper-textarea').focus();
}
async function shell(command: string, output: string) {
  const t = page.locator('.xterm-helper-textarea');
  await t.focus();
  await page.keyboard.type(command);
  await t.press('Enter');
  await terminalLine(output);
  log({ type: 'action', action: 'terminal-command', command, expectedOutput: output });
}
async function terminalLine(line: string, count = 1) {
  await page.waitForFunction(
    ({ line, count }) =>
      Array.from(document.querySelectorAll('.xterm-screen')).some(
        (el) => (el as HTMLElement).innerText.split('\n').filter((l) => l.trim() === line).length >= count,
      ),
    { line, count },
    { timeout: 12000 },
  );
}
async function closeTerminal() {
  await page.getByRole('button', { name: 'Close terminal', exact: true })[mobileProfile ? 'tap' : 'click']();
}
async function idle() {
  await wait((s) => s.agentState?.codexRuntime?.runtime === 'idle', 'Codex idle');
}
async function rendered(marker: string) {
  await page.getByText(marker, { exact: true }).last().waitFor({ timeout: 100000 });
}
try {
  if (stage === 'main') {
    if (process.env.RESUME_CASE) {
      await page.goto(webOrigin + '/session/' + progress.sessionId);
      await page.getByRole('button', { name: '选择发送方式' }).waitFor();
    }
    await test('01 real new-session UI → directory selection → first Codex answer', async () => {
      await page.goto(webOrigin + '/new');
      await page.getByRole('button', { name: '选择工作目录', exact: true }).click();
      await page.getByRole('textbox', { name: '目录路径', exact: true }).fill('/workspace');
      await page.getByRole('button', { name: '使用此路径', exact: true }).click();
      await page.getByRole('textbox', { name: '目录路径', exact: true }).waitFor({ state: 'hidden' });
      assert.equal(await page.getByRole('button', { name: /语音|录音|voice input/i }).count(), 0);
      await page
        .getByRole('textbox', { name: 'Session prompt', exact: true })
        .fill(`Remember our project name ${run}. Reply exactly READY_${run}. Do not use tools.`);
      await page.getByRole('button', { name: 'Start session', exact: true }).click();
      await page.waitForURL(/\/session\//, { timeout: 100000 });
      await page.getByRole('button', { name: '选择发送方式', exact: true }).waitFor({ timeout: 100000 });
      progress.sessionId = page.url().split('/session/')[1].split(/[/?]/)[0];
      save();
      await rendered(`READY_${run}`);
      await idle();
      assert.equal((await state()).metadata.path, '/workspace');
      progress.parent = (await state()).agentState.codexRuntime.threadId;
      save();
      await shot('01-created');
    });
    await test('02 settings change → dismiss → reload → persisted values', async () => {
      await page.getByRole('button', { name: 'Open session settings', exact: true }).click();
      const p = page.getByLabel('会话设置面板', { exact: true });
      await p.waitFor();
      assert((await p.boundingBox())!.width <= 421);
      await page.getByLabel('输出详略', { exact: true }).selectOption('low');
      await dismiss();
      await page.reload();
      await page.getByRole('button', { name: 'Open session settings', exact: true }).click();
      assert.equal(await page.getByLabel('输出详略', { exact: true }).inputValue(), 'low');
      await shot('02-settings');
      await dismiss();
    });
    await test('03 real clipboard paste and Linux Ctrl+A/E/U/K/R/C/D + reconnect', async () => {
      await terminalOpen();
      const t = page.locator('.xterm-helper-textarea');
      await page.evaluate(() => navigator.clipboard.writeText('https://github.com/thedotmack/claude-mem'));
      await t.press('Control+v');
      await t.press('Control+a');
      await page.keyboard.type('printf "PASTE_OK:%s\\n" ');
      await t.press('Enter');
      await terminalLine('PASTE_OK:https://github.com/thedotmack/claude-mem');
      assert(!(await page.locator('.xterm-screen').innerText()).includes('^[[200~'));
      await page.keyboard.type('AE_' + run);
      await t.press('Control+a');
      await page.keyboard.type("printf '%s\\n' ");
      await t.press('Control+e');
      await page.keyboard.type('_END');
      await t.press('Enter');
      await terminalLine('AE_' + run + '_END');
      await page.keyboard.type('THIS_IS_WRONG');
      await t.press('Control+u');
      await shell(`printf '%s\\n' U_${run}`, 'U_' + run);
      const prefix = `printf '%s\\n' K_${run}`;
      await page.keyboard.type(prefix + '_WRONG');
      await t.press('Control+a');
      for (let i = 0; i < prefix.length; i++) await t.press('ArrowRight');
      await t.press('Control+k');
      await t.press('Enter');
      await terminalLine('K_' + run);
      await shell(`printf '%s\\n' R_${run}`, 'R_' + run);
      await t.press('Control+r');
      await page.keyboard.type('R_' + run);
      await t.press('Enter');
      await terminalLine('R_' + run, 2);
      await page.keyboard.type('sleep 180');
      await t.press('Enter');
      await page.waitForTimeout(250);
      await t.press('Control+c');
      await shell(`printf '%s\\n' C_${run}`, 'C_' + run);
      await shot('03-terminal');
      await t.press('Control+d');
      await page.getByRole('button', { name: '重新连接终端', exact: true }).click();
      await page.waitForTimeout(700);
      await shell(`printf '%s\\n' RECONNECT_${run}`, 'RECONNECT_' + run);
      await shell(`mkdir -p /workspace/.${run} && printf '%s\\n' WORKSPACE_${run}`, 'WORKSPACE_' + run);
      await closeTerminal();
    });
    await test('04 running turn → Enter steering → no stop/turn replacement', async () => {
      await send(
        `Run this shell command exactly and wait for it to finish: for i in $(seq 1 600); do if test -f /workspace/.${run}/release; then break; fi; sleep 1; done . Do not finish before the command returns. Then reply MAIN_DONE_${run} and any extra markers requested by followups.`,
        '补充当前任务',
      );
      const s = await wait((s) => s.agentState?.codexRuntime?.turn === 'running', 'main running');
      progress.turn = s.agentState.codexRuntime.turnId;
      save();
      await send(`Additional instruction: include STEER_${run} in the final answer.`);
      const a = await wait(
        (s) => s.agentState?.codexInputs?.receipts.some((r: any) => r.status === 'steered'),
        'steer ack',
      );
      assert.equal(a.agentState.codexRuntime.turnId, progress.turn);
      assert.equal(a.agentState.codexRuntime.threadId, progress.parent);
      await composer().fill('ESC_DRAFT_' + run);
      await composer().press('Escape');
      assert.equal(await composer().inputValue(), 'ESC_DRAFT_' + run);
      assert.equal((await state()).agentState.codexRuntime.turnId, progress.turn);
      await composer().fill('');
      await page.getByRole('button', { name: '选择发送方式', exact: true }).click();
      await page.keyboard.press('Home');
      await page.keyboard.press('ArrowDown');
      await page.keyboard.press('Enter');
      assert((await page.getByRole('button', { name: '选择发送方式' }).innerText()).includes('排队下一轮'));
      await choose('补充当前任务');
    });
    await test('05 queue via menu and Tab → pause → edit → reorder → delete → inject', async () => {
      await send(`Reply exactly QUEUE_ORIGINAL_${run}. Do not use tools.`, '排队下一轮');
      await wait((s) => s.agentState?.codexInputs?.items.length === 1, 'queue first');
      await choose('补充当前任务');
      await composer().fill(`Reply exactly QUEUE_DELETE_${run}. Do not use tools.`);
      await composer().press('Tab');
      await wait((s) => s.agentState?.codexInputs?.items.length === 2, 'Tab queues');
      await send(`Additional instruction: include INJECT_${run} in the final answer.`, '排队下一轮');
      await wait((s) => s.agentState?.codexInputs?.items.length === 3, 'queue third');
      await queueOpen();
      await page.getByRole('button', { name: '暂停队列', exact: true }).click();
      await wait((s) => s.agentState?.codexInputs?.paused, 'queue paused');
      await page.getByRole('button', { name: '修改', exact: true }).first().click();
      await page
        .getByRole('textbox', { name: '编辑排队消息', exact: true })
        .fill(`Reply exactly QUEUE_EDITED_${run}. Do not use tools.`);
      await page.getByRole('button', { name: '保存', exact: true }).click();
      await wait((s) => s.agentState?.codexInputs?.items[0].message.includes('QUEUE_EDITED'), 'queue edited');
      await page.getByRole('button', { name: '上移', exact: true }).last().click();
      await wait((s) => s.agentState?.codexInputs?.items[1].message.includes('INJECT'), 'queue reordered');
      await page.getByRole('button', { name: '删除', exact: true }).last().click();
      await wait((s) => s.agentState?.codexInputs?.items.length === 2, 'queue deleted');
      await page.getByRole('button', { name: '立即发送', exact: true }).last().click();
      const s = await wait((s) => s.agentState?.codexInputs?.items.length === 1, 'queue injected');
      assert(s.agentState.codexInputs.paused);
      assert.equal(s.agentState.codexRuntime.turnId, progress.turn);
      await shot('05-queue');
      await dismiss();
    });
    await test('06 two browser tabs → stale queue revision rejected → draft preserved → retry', async () => {
      await queueOpen();
      await page.getByRole('button', { name: '修改', exact: true }).click();
      await page
        .getByRole('textbox', { name: '编辑排队消息' })
        .fill(`Reply exactly QUEUE_FINAL_${run}. Do not use tools.`);
      const b = await context.newPage();
      await b.goto(page.url());
      await b.getByRole('button', { name: '查看待发送队列' }).click();
      await b.getByRole('button', { name: '修改', exact: true }).click();
      await b
        .getByRole('textbox', { name: '编辑排队消息' })
        .fill(`Reply exactly QUEUE_OTHER_TAB_${run}. Do not use tools.`);
      await b.getByRole('button', { name: '保存', exact: true }).click();
      await wait(
        (s) => s.agentState?.codexInputs?.items[0].message.includes('OTHER_TAB'),
        'other tab update',
      );
      await b.close();
      await page.getByRole('button', { name: '保存', exact: true }).click();
      await page
        .getByRole('alert')
        .filter({ hasText: /修改|刷新|changed|modified/ })
        .waitFor();
      assert(
        (await page.getByRole('textbox', { name: '编辑排队消息' }).inputValue()).includes('QUEUE_FINAL'),
      );
      await shot('06-conflict-draft');
      await page.getByRole('button', { name: '取消', exact: true }).click();
      await page.getByRole('button', { name: '修改', exact: true }).click();
      await page
        .getByRole('textbox', { name: '编辑排队消息' })
        .fill(`Reply exactly QUEUE_FINAL_${run}. Do not use tools.`);
      await page.getByRole('button', { name: '保存', exact: true }).click();
      await wait((s) => s.agentState?.codexInputs?.items[0].message.includes('QUEUE_FINAL'), 'retry saved');
      await dismiss();
    });
    await test('07 reload + offline reconnect → active turn and paused queue preserved', async () => {
      await page.reload();
      await page.getByRole('button', { name: '选择发送方式' }).waitFor();
      let s = await state();
      assert.equal(s.agentState.codexRuntime.turnId, progress.turn);
      assert(s.agentState.codexInputs.paused);
      assert.equal(s.agentState.codexInputs.items.length, 1);
      await choose('补充当前任务');
      await context.setOffline(true);
      await page.getByText(/^connected$/i).waitFor({ state: 'hidden' });
      const draft = 'Additional instruction: include RECONNECT_STEER_' + run;
      await composer().fill(draft);
      await composer().press('Enter');
      await page.getByText(/^(Socket not connected|网络已离线，请恢复连接后重试)$/).waitFor();
      assert.equal(await composer().inputValue(), draft);
      await shot('07-offline-draft-preserved');
      await context.setOffline(false);
      await page.getByText('确定', { exact: true }).click();
      await page.getByText(/^connected$/i).waitFor();
      await composer().press('Enter');
      await page.waitForFunction(() =>
        Array.from(document.querySelectorAll('[id^="hapla-composer-"] textarea')).every(
          (t) => (t as HTMLTextAreaElement).value === '',
        ),
      );
      s = await wait(
        (s) => s.agentState?.codexInputs?.receipts.filter((r: any) => r.status === 'steered').length >= 3,
        'offline retry steered',
      );
      assert.equal(s.agentState.codexRuntime.turnId, progress.turn);
      assert(s.agentState.codexInputs.paused);
    });
    if (process.env.RESUME_CASE === '8') {
      await page.getByRole('button', { name: '打开旁问侧栏' }).click();
      const existing = (await state()).agentState.codexSideChats ?? [];
      for (const chat of existing) {
        await page.getByLabel('选择旁聊', { exact: true }).selectOption(chat.id);
        await page.getByRole('button', { name: '关闭旁聊', exact: true }).click();
        await wait(
          (s) => !s.agentState?.codexSideChats?.some((x: any) => x.id === chat.id),
          'cleanup prior BTW',
        );
      }
      await page.getByRole('button', { name: '收起旁问' }).click();
    }
    await test('08 BTW → real parent context → same-chat followup → separate stop', async () => {
      await send(`What is our project name? Reply only with that exact name. Do not use tools.`, '旁问 BTW');
      let s = await wait(
        (s) =>
          s.agentState?.codexSideChats?.some(
            (c: any) =>
              c.status === 'idle' &&
              c.messages.some((m: any) => m.role === 'assistant' && m.text.trim() === run),
          ),
        'BTW context',
      );
      progress.chatId = s.agentState.codexSideChats[0].id;
      save();
      assert.equal(s.agentState.codexRuntime.turnId, progress.turn);
      await page.locator('.hapla-btw-message.is-assistant').filter({ hasText: run }).waitFor();
      await page.getByRole('button', { name: /^在下方输入框继续旁问/ }).click();
      await send(`Remember side word ORCHID_${run}. Reply exactly BTW_SECOND_${run}.`);
      s = await wait(
        (s) =>
          s.agentState?.codexSideChats?.some(
            (c: any) =>
              c.id === progress.chatId &&
              c.status === 'idle' &&
              c.messages.some((m: any) => m.role === 'assistant' && m.text.trim() === `BTW_SECOND_${run}`),
          ),
        'same-chat followup',
      );
      assert.equal(s.agentState.codexSideChats.length, 1);
      await send(
        'Run sleep 180 and wait for it before replying SIDE_WAIT_DONE. Do not skip the shell command.',
      );
      await wait(
        (s) => s.agentState?.codexSideChats?.find((c: any) => c.id === progress.chatId)?.status === 'running',
        'side running',
      );
      await page.waitForTimeout(2500);
      await page.getByRole('button', { name: '停止旁问', exact: true }).click();
      s = await wait(
        (s) =>
          s.agentState?.codexSideChats?.find((c: any) => c.id === progress.chatId)?.status === 'interrupted',
        'side stopped',
      );
      assert.equal(s.agentState.codexRuntime.turnId, progress.turn);
      assert.equal(s.agentState.codexRuntime.turn, 'running');
      await send('What is our side word? Reply only with that exact word. Do not use tools.');
      await wait(
        (s) =>
          s.agentState?.codexSideChats?.some(
            (c: any) =>
              c.id === progress.chatId &&
              c.status === 'idle' &&
              c.messages.some((m: any) => m.role === 'assistant' && m.text.trim() === `ORCHID_${run}`),
          ),
        'side resumes context',
      );
      await shot('08-btw');
      await page.getByRole('button', { name: '选择发送方式' }).click();
      await dismiss();
      assert.equal(await page.getByLabel('旁问侧栏', { exact: true }).count(), 1);
      await page.getByRole('button', { name: '收起旁问', exact: true }).click();
      await page.getByRole('button', { name: '打开旁问侧栏', exact: true }).click();
      assert.equal(await page.getByLabel('选择旁聊', { exact: true }).inputValue(), progress.chatId);
      await page.getByRole('button', { name: '新旁问', exact: true }).click();
      await send(`Reply exactly NEW_SIDE_${run}. Do not use tools.`);
      await wait(
        (s) =>
          s.agentState?.codexSideChats?.length === 2 &&
          s.agentState.codexSideChats.some((c: any) =>
            c.messages.some((m: any) => m.role === 'assistant' && m.text.trim() === `NEW_SIDE_${run}`),
          ),
        'second side',
      );
      await page.getByLabel('选择旁聊', { exact: true }).selectOption(progress.chatId);
      await page.getByRole('button', { name: '关闭旁聊', exact: true }).click();
      await wait((s) => s.agentState?.codexSideChats?.length === 1, 'remove side');
      await page.getByRole('button', { name: '收起旁问' }).click();
    });
    await test('09 busy fork → original turn continues unchanged', async () => {
      await page.getByRole('button', { name: '更多会话操作', exact: true }).click();
      await page.getByRole('menuitem', { name: '新分支', exact: true }).click();
      const s = await wait((s) => (s.metadata?.codexBranches?.length ?? 0) >= 2, 'fork saved');
      assert.equal(s.agentState.codexRuntime.turnId, progress.turn);
      assert.equal(s.agentState.codexRuntime.threadId, progress.parent);
      progress.branches = s.metadata.codexBranches;
      save();
    });
    await test('10 terminal releases main → rendered final with steer + inject → paused queue stays', async () => {
      await terminalOpen();
      await shell(`touch /workspace/.${run}/release && printf '%s\\n' RELEASE_${run}`, 'RELEASE_' + run);
      await closeTerminal();
      await idle();
      await page
        .getByText(new RegExp('MAIN_DONE_' + run))
        .last()
        .waitFor({ timeout: 100000 });
      const s = await state();
      assert(s.agentState.codexInputs.paused);
      assert.equal(s.agentState.codexInputs.items.length, 1);
      assert((await page.locator('body').innerText()).includes('STEER_' + run));
      assert((await page.locator('body').innerText()).includes('INJECT_' + run));
      await shot('10-completed-live');
    });
    await test('11 explicit continue queue → actual provider completion → empty queue', async () => {
      await queueOpen();
      await page.getByRole('button', { name: '继续队列', exact: true }).click();
      await rendered('QUEUE_FINAL_' + run);
      await idle();
      await wait((s) => s.agentState?.codexInputs?.items.length === 0, 'queue drained');
      await page.locator('.hapla-followup-empty').filter({ hasText: '没有待发送的消息' }).waitFor();
      await shot('11-queue-complete');
      await dismiss();
    });
    progress.mainComplete = true;
    save();
  } else if (stage !== 'mobile' || process.env.RESUME_CASE) {
    await page.goto(webOrigin + '/session/' + progress.sessionId);
    await page.getByRole('button', { name: '选择发送方式', exact: true }).waitFor({ timeout: 30000 });
  }
  if (stage === 'queue-safety') {
    await test('12 paused queue + new direct input must not silently resume old pending inputs', async () => {
      await queueOpen();
      if (await page.getByRole('button', { name: '暂停队列', exact: true }).count())
        await page.getByRole('button', { name: '暂停队列', exact: true }).click();
      await dismiss();
      await send(`Reply exactly PAUSED_PENDING_${run}. Do not use tools.`, '排队下一轮');
      await wait(
        (s) => s.agentState?.codexInputs?.paused && s.agentState.codexInputs.items.length === 1,
        'paused pending',
      );
      await send(`Reply exactly DIRECT_ONLY_${run}. Do not use tools.`, '补充当前任务');
      await rendered('DIRECT_ONLY_' + run);
      await idle();
      const s = await state();
      assert(s.agentState.codexInputs.paused, 'Sending a direct input silently resumed the paused queue');
      assert.equal(
        s.agentState.codexInputs.items.length,
        1,
        'Old pending input executed without Continue queue',
      );
      await shot('12-paused-preserved');
      await queueOpen();
      await page.getByRole('button', { name: '删除', exact: true }).click();
      await wait((s) => s.agentState?.codexInputs?.items.length === 0, 'cleanup pending');
      await dismiss();
    });
    await test('29 idle single-item injection → only selected item runs → other paused item remains', async () => {
      await send(`Reply exactly INJECT_IDLE_${run}. Do not use tools.`, '排队下一轮');
      await send(`Reply exactly NOT_YET_${run}. Do not use tools.`);
      await wait(
        (s) => s.agentState?.codexInputs?.items.length === 2 && s.agentState.codexInputs.paused,
        'two paused inputs',
      );
      await queueOpen();
      await page.getByRole('button', { name: '立即发送', exact: true }).first().click();
      await rendered('INJECT_IDLE_' + run);
      await idle();
      const s = await state();
      assert(s.agentState.codexInputs.paused);
      assert.equal(s.agentState.codexInputs.items.length, 1);
      assert(s.agentState.codexInputs.items[0].message.includes('NOT_YET'));
      await page.getByRole('button', { name: '删除', exact: true }).click();
      await dismiss();
    });
  }
  if (stage === 'controls') {
    await test('13 explicit stop → idle + paused queue → continue with original context', async () => {
      await send(
        'Run sleep 180 and wait for it before replying STOP_TEST_DONE. Do not skip the command.',
        '补充当前任务',
      );
      await wait((s) => s.agentState?.codexRuntime?.turn === 'running', 'stop main running');
      await page.waitForTimeout(2500);
      await page.getByRole('button', { name: '停止当前任务', exact: true }).click();
      await idle();
      assert((await state()).agentState.codexInputs.paused);
      await send('What is our project name? Reply only with that exact name. Do not use tools.');
      await rendered(run);
      await idle();
      assert.equal((await state()).agentState.codexRuntime.threadId, progress.parent);
    });
    await test('14 stop-and-send → correct replacement response while old queue remains paused', async () => {
      await queueOpen();
      if (await page.getByRole('button', { name: '暂停队列', exact: true }).count())
        await page.getByRole('button', { name: '暂停队列', exact: true }).click();
      await dismiss();
      await send(`Reply exactly SHOULD_STAY_PAUSED_${run}. Do not use tools.`, '排队下一轮');
      await send('Run sleep 180 and wait before replying OLD_REPLACE_DONE.', '补充当前任务');
      await wait((s) => s.agentState?.codexRuntime?.turn === 'running', 'replace old turn');
      await send(`Reply exactly REPLACED_${run}. Do not use tools.`, '停止并发送');
      await rendered('REPLACED_' + run);
      await idle();
      const s = await state();
      assert(s.agentState.codexInputs.paused);
      assert.equal(s.agentState.codexInputs.items.length, 1);
      await queueOpen();
      await page.getByRole('button', { name: '删除', exact: true }).click();
      await dismiss();
      await shot('14-replaced');
    });
    await test('15 rapid repeated Enter → only one provider input and response', async () => {
      await choose('补充当前任务');
      const before = new Set((await state()).agentState.codexInputs.receipts.map((r: any) => r.id));
      await composer().fill(`Reply exactly DEDUPE_${run}. Do not use tools.`);
      await composer().press('Enter');
      await page.keyboard.press('Enter');
      await page.keyboard.press('Enter');
      await rendered('DEDUPE_' + run);
      await idle();
      const added = (await state()).agentState.codexInputs.receipts.filter((r: any) => !before.has(r.id));
      assert.equal(added.length, 1);
      assert.equal(await page.getByText('DEDUPE_' + run, { exact: true }).count(), 1);
    });
    await test('16 switch fork branch → verified native thread → continue → switch back', async () => {
      const before = (await state()).agentState.codexRuntime.threadId;
      const branch = page.getByRole('button', { name: /^切换到分支，/ }).first();
      await branch.click();
      await wait(
        (s) => s.agentState?.codexRuntime?.threadId !== before && s.agentState?.codexRuntime?.threadId,
        'branch native switched',
      );
      await send('What is our project name? Reply only with that exact name. Do not use tools.');
      await page.locator('[data-hapla-forward-row]').last().getByText(run, { exact: true }).waitFor();
      await idle();
      await page
        .getByRole('button', { name: /^切换到分支，/ })
        .first()
        .click();
      await wait((s) => s.agentState?.codexRuntime?.threadId === progress.parent, 'original branch restored');
      await shot('16-branches');
    });
  }
  if (stage === 'history-mobile') {
    await test('17 all 140 questions → filter oldest → reuse → edit → draft restored after reload', async () => {
      await page.goto(webOrigin + '/session/' + c.historySessionId);
      await page.getByRole('button', { name: '当前会话全部历史问题' }).click();
      await loadAllQuestions();
      assert.equal(
        await page
          .getByLabel('历史问题面板')
          .getByText(/^历史问题 \d{3}/)
          .count(),
        140,
      );
      await shot('17-all-history');
      await page.getByRole('textbox', { name: '筛选已加载的历史问题', exact: true }).fill('001');
      await page.getByText('历史问题 001：开发验收记录', { exact: true }).click();
      assert((await composer().inputValue()).includes('001'));
      await composer().fill('历史复用后编辑 ' + run);
      await page.waitForTimeout(1000);
      await page.reload();
      await composer().waitFor();
      assert.equal(await composer().inputValue(), '历史复用后编辑 ' + run);
      await composer().fill('');
    });
    await page.goto(webOrigin + '/session/' + progress.sessionId);
    await page.getByRole('button', { name: '选择发送方式' }).waitFor();
    await test('18 mobile touch-size viewport → BTW reply → reduced-height viewport + composer unobstructed', async () => {
      await page.setViewportSize({ width: 390, height: 844 });
      await page.getByRole('button', { name: '打开旁问侧栏' }).click();
      await page.getByRole('button', { name: /^(继续这个旁问|在下方输入框继续旁问)/ }).click();
      await send(`Reply exactly MOBILE_${run}. Do not use tools.`);
      await wait(
        (s) =>
          s.agentState?.codexSideChats?.some((c: any) =>
            c.messages.some((m: any) => m.role === 'assistant' && m.text.trim() === `MOBILE_${run}`),
          ),
        'mobile side answer',
      );
      for (const height of [844, 520, 440]) {
        await page.setViewportSize({ width: 390, height });
        await composer().fill('移动端输入 ' + run);
        await composer().focus();
        await page.waitForTimeout(250);
        const panel = await page.getByLabel('旁问侧栏', { exact: true }).boundingBox(),
          input = await composer().boundingBox(),
          footer = await page.locator('.hapla-btw-footer').boundingBox();
        assert(panel && input && footer);
        assert(panel.y + panel.height <= input.y, 'mobile panel covers composer');
        assert(footer.y + footer.height <= input.y, 'mobile footer covers composer at height ' + height);
        assert(footer.y >= panel.y, 'mobile footer overflow at height ' + height);
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
        await shot('18-mobile-' + height);
      }
      await composer().fill('');
      await page.getByRole('button', { name: '收起旁问' }).click();
      await page.setViewportSize({ width: 1440, height: 1050 });
    });
    await test('19 dark theme + keyboard menu Escape priority + voice hidden', async () => {
      await page.emulateMedia({ colorScheme: 'dark' });
      await page.reload();
      await page.getByRole('button', { name: '打开旁问侧栏' }).click();
      await page.getByLabel('旁问侧栏', { exact: true }).waitFor();
      await page.getByRole('button', { name: '选择发送方式' }).click();
      await page.getByRole('menu', { name: '发送方式', exact: true }).waitFor();
      await page.keyboard.press('End');
      await page.keyboard.press('Home');
      await dismiss();
      assert.equal(await page.getByLabel('旁问侧栏', { exact: true }).count(), 1);
      await page.getByRole('button', { name: 'Open session settings' }).click();
      await dismiss();
      assert.equal(await page.getByLabel('旁问侧栏', { exact: true }).count(), 1);
      assert.equal(await page.getByRole('button', { name: /语音|录音|voice input/i }).count(), 0);
      await shot('19-dark');
      await page.getByRole('button', { name: '收起旁问' }).click();
    });
  }
  if (stage === 'preview') {
    const upstreams: any[] = [];
    async function fixture(label: string, port = 0) {
      const server = createServer(async (req, res) => {
        const url = new URL(req.url!, 'http://fixture');
        if (url.pathname === '/gateway/v1/session/login') {
          if (req.method === 'POST') {
            res.writeHead(302, { location: '/', 'set-cookie': 'fixture_session=logged-in; Path=/; HttpOnly; SameSite=Lax' });
            res.end();
          } else {
            res.setHeader('content-type', 'text/html;charset=utf-8');
            res.end('<!doctype html><form method="post" action="/gateway/v1/session/login"><label>Fixture account<input name="account"></label><button type="submit">Fixture login</button></form>');
          }
        } else if (url.pathname === '/login-state') {
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ loggedIn: /fixture_session=logged-in/.test(req.headers.cookie || '') }));
        } else if (url.pathname === '/api') {
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ label }));
        } else if (url.pathname === '/module.js') {
          res.setHeader('content-type', 'application/javascript');
          res.end(`export default 'MODULE_${run}'`);
        } else if (url.pathname === '/style.css') {
          res.setHeader('content-type', 'text/css');
          res.end('body{color:rgb(20,80,120)}');
        } else if (url.pathname === '/echo') {
          const chunks = [];
          for await (const chunk of req) chunks.push(chunk);
          res.end(Buffer.concat(chunks));
        } else {
          res.setHeader('content-type', 'text/html;charset=utf-8');
          res.end(
            `<!doctype html><link rel="stylesheet" href="/style.css"><h1>${label}</h1><a href="/gateway/v1/session/login">Fixture sign in</a><div id="login-state"></div><div id="api"></div><div id="module"></div><div id="ws"></div><button id="post">POST</button><div id="posted"></div><script type="module">import m from '/module.js';document.querySelector('#module').textContent=m;fetch('/api').then(r=>r.json()).then(v=>document.querySelector('#api').textContent=v.label);fetch('/login-state').then(r=>r.json()).then(v=>document.querySelector('#login-state').textContent=v.loggedIn?'AUTHENTICATED':'GUEST');const s=new WebSocket(location.origin.replace(/^http/,'ws')+'/socket');s.onopen=()=>s.send('HMR_${run}');s.onmessage=e=>document.querySelector('#ws').textContent=e.data;document.querySelector('#post').onclick=()=>fetch('/echo',{method:'POST',body:'POST_${run}'}).then(r=>r.text()).then(t=>document.querySelector('#posted').textContent=t);</script>`,
          );
        }
      });
      const wss = new WebSocketServer({ server, path: '/socket' });
      wss.on('connection', (s) => s.on('message', (d, b) => s.send(d, { binary: b })));
      await new Promise<void>((resolve) => server.listen(port, '0.0.0.0', resolve));
      const value = {
        server,
        wss,
        port: (server.address() as any).port,
        closed: false,
        async close() {
          if (this.closed) return;
          this.closed = true;
          for (const s of wss.clients) s.terminate();
          await new Promise<void>((resolve) => wss.close(() => resolve()));
          server.closeAllConnections();
          await new Promise<void>((resolve) => server.close(() => resolve()));
        },
      };
      upstreams.push(value);
      return value;
    }
    let current = await fixture('UPSTREAM_A_' + run);
    let stable = '';
    let direct: any;
    try {
      await test('20 preview UI register → browser-origin stable URL → real CSS/modules/fetch/WebSocket/POST', async () => {
        await page.goto(webOrigin + '/session/' + progress.sessionId + '/preview');
        await page
          .getByRole('textbox', { name: '网页地址或 HTML 路径' })
          .fill(`http://127.0.0.1:${current.port}/`);
        await page.getByRole('button', { name: '注册并打开', exact: true }).click();
        const iframe = page.frameLocator('iframe[title="网页交互预览"]');
        await iframe
          .locator('#api')
          .filter({ hasText: 'UPSTREAM_A_' + run })
          .waitFor();
        assert.equal(await iframe.locator('#module').innerText(), 'MODULE_' + run);
        await iframe
          .locator('#ws')
          .filter({ hasText: 'HMR_' + run })
          .waitFor();
        assert.equal(
          await iframe.locator('body').evaluate((el) => getComputedStyle(el).color),
          'rgb(20, 80, 120)',
        );
        await iframe.locator('#post').click();
        await iframe
          .locator('#posted')
          .filter({ hasText: 'POST_' + run })
          .waitFor();
        stable = (await page.getByRole('link', { name: '在浏览器打开', exact: true }).getAttribute('href'))!;
        assert(stable.startsWith(webOrigin + '/preview/'));
        progress.previewURL = stable;
        save();
        const newPage = context.waitForEvent('page');
        await page.getByRole('link', { name: '在浏览器打开', exact: true }).click();
        direct = await newPage;
        await direct
          .locator('#api')
          .filter({ hasText: 'UPSTREAM_A_' + run })
          .waitFor();
        await direct.getByRole('link', { name: 'Fixture sign in', exact: true }).click();
        assert(direct.url().startsWith(stable + 'gateway/v1/session/login'), 'Root navigation lost the preview origin or handle');
        await direct.getByRole('textbox', { name: 'Fixture account' }).fill('dev-only-account');
        await direct.getByRole('button', { name: 'Fixture login', exact: true }).click();
        await direct.locator('#login-state').filter({ hasText: 'AUTHENTICATED' }).waitFor();
        assert(direct.url().startsWith(stable), 'Post-login redirect lost the preview origin or handle');
        await shot('20-registered');
      });
      await test('21 restart upstream → same browser link → update target port via UI → same link persists', async () => {
        const port = current.port;
        await current.close();
        const unavailable = await direct.reload();
        assert.equal(unavailable!.status(), 502);
        current = await fixture('RESTARTED_' + run, port);
        await direct.reload();
        await direct
          .locator('#api')
          .filter({ hasText: 'RESTARTED_' + run })
          .waitFor();
        const replacement = await fixture('UPSTREAM_B_' + run);
        await current.close();
        current = replacement;
        await page
          .getByRole('textbox', { name: '网页地址或 HTML 路径' })
          .fill(`http://127.0.0.1:${current.port}/`);
        await page.getByRole('button', { name: '更新目标并打开', exact: true }).click();
        await page
          .frameLocator('iframe[title="网页交互预览"]')
          .locator('#api')
          .filter({ hasText: 'UPSTREAM_B_' + run })
          .waitFor();
        assert.equal(
          await page.getByRole('link', { name: '在浏览器打开', exact: true }).getAttribute('href'),
          stable,
        );
        await direct.reload();
        await direct
          .locator('#api')
          .filter({ hasText: 'UPSTREAM_B_' + run })
          .waitFor();
        await page.reload();
        const target = new RegExp('127.0.0.1:' + port);
        await page.getByRole('button', { name: target }).click();
        await page.getByRole('button', { name: '更新目标并打开', exact: true }).click();
        assert.equal(
          await page.getByRole('link', { name: '在浏览器打开', exact: true }).getAttribute('href'),
          stable,
        );
        await shot('21-stable-after-edit');
      });
      await test('22 different logged-in account cannot open owner preview', async () => {
        const other = await browser.newContext();
        await other.addInitScript(
          ({ token, secret }: any) =>
            localStorage.setItem('auth_credentials', JSON.stringify({ token, secret })),
          { token: c.otherToken, secret: c.secret },
        );
        const p = await other.newPage();
        await p.goto(webOrigin + '/');
        await p.waitForTimeout(1500);
        const denied = await p.goto(stable);
        assert.equal(denied!.status(), 404);
        assert(
          (await other.cookies()).some((v) => v.name === 'hapla_preview_auth' && v.value === c.otherToken),
          'Other-account login did not establish its own cookie',
        );
        await other.close();
      });
      await test('23 delete registration through UI → formerly stable link returns 404', async () => {
        await page.getByRole('button', { name: '删除此代理', exact: true }).click();
        await page.getByRole('button', { name: '注册并打开', exact: true }).waitFor();
        const response = await direct.reload();
        assert.equal(response!.status(), 404);
        await direct.close();
      });
    } finally {
      for (const s of upstreams) await s.close();
    }
  }
  if (stage === 'questions') {
    const pending = await state();
    if (
      Object.entries(pending.agentState?.requests ?? {}).some(
        ([id, r]: any) => r.tool === 'AskUserQuestion' && !pending.agentState?.completedRequests?.[id],
      )
    ) {
      log({
        type: 'diagnostic-recovery',
        reason: 'Answer a pending test question left by a failed selector before retrying the workflow',
      });
      await page
        .getByRole('button', { name: /^Blue(?: \(Recommended\))?$/ })
        .last()
        .click();
      await idle();
    }
    await test('24 Plan setting → real request_user_input → UI answer → provider continues', async () => {
      await page.getByRole('button', { name: 'Open session settings' }).click();
      await page.getByLabel('Codex 工作模式', { exact: true }).selectOption('plan');
      await dismiss();
      await send(
        `Use the request_user_input tool now. Ask one question id=color, header=Color, question="Choose the acceptance color", with options "Blue" (description Blue mode) and "Green" (description Green mode). Do not answer it yourself and do not ask in plain text. After the user answers, reply exactly COLOR_<chosen label>_${run}.`,
        '补充当前任务',
      );
      await wait(
        (s) => Object.values(s.agentState?.requests ?? {}).some((r: any) => r.tool === 'AskUserQuestion'),
        'real structured question',
      );
      await page
        .getByRole('button', { name: /^Blue(?: \(Recommended\))?$/ })
        .last()
        .click();
      await page
        .getByText(new RegExp('^COLOR_Blue(?: \\(Recommended\\))?_' + run + '$'))
        .last()
        .waitFor({ timeout: 100000 });
      await idle();
      await shot('24-question-choice');
      await page.getByRole('button', { name: 'Open session settings' }).click();
      await page.getByLabel('Codex 工作模式', { exact: true }).selectOption('default');
      await dismiss();
    });
    await test('25 slash queue and BTW → correct destinations and no main interruption', async () => {
      await queueOpen();
      if (await page.getByRole('button', { name: '暂停队列', exact: true }).count())
        await page.getByRole('button', { name: '暂停队列', exact: true }).click();
      await dismiss();
      await send(`/queue Reply exactly SLASH_QUEUE_${run}. Do not use tools.`, '补充当前任务');
      await wait(
        (s) => s.agentState?.codexInputs?.items.some((i: any) => i.message.includes('SLASH_QUEUE')),
        'slash queue destination',
      );
      await send(`/btw Reply exactly SLASH_BTW_${run}. Do not use tools.`);
      await wait(
        (s) =>
          s.agentState?.codexSideChats?.some((c: any) =>
            c.messages.some((m: any) => m.role === 'assistant' && m.text.trim() === `SLASH_BTW_${run}`),
          ),
        'slash BTW answer',
      );
      await page
        .locator('.hapla-btw-message.is-assistant')
        .filter({ hasText: 'SLASH_BTW_' + run })
        .waitFor();
      await page.getByRole('button', { name: '收起旁问' }).click();
      await queueOpen();
      await page.getByRole('button', { name: '删除', exact: true }).click();
      await dismiss();
    });
  }
  if (stage === 'freshness') {
    await test('26 streaming grows beyond viewport → final answer visible without Latest click', async () => {
      await send(
        `Output 45 numbered lines, each containing a different short sentence about UI acceptance. End with a separate paragraph containing exactly FRESH_END_${run}. Do not use tools.`,
        '补充当前任务',
      );
      await rendered('FRESH_END_' + run);
      await idle();
      await page.waitForTimeout(500);
      const last = await page
        .getByText('FRESH_END_' + run, { exact: true })
        .last()
        .boundingBox();
      const input = await composer().boundingBox();
      assert(last && input);
      assert(
        last.y > 100 && last.y + last.height <= input.y,
        'Newest response is outside the viewport until Latest is clicked',
      );
      await shot('26-auto-latest');
    });
    await test('27 leave conversation while running → return → latest backend response rendered automatically', async () => {
      await send(`Run sleep 6, then reply exactly RETURN_LATEST_${run}.`);
      await wait((s) => s.agentState?.codexRuntime?.turn === 'running', 'navigation running');
      await page.goto(webOrigin + '/new');
      await page.getByRole('textbox', { name: 'Session prompt' }).waitFor();
      await page.waitForTimeout(9500);
      await page.goto(webOrigin + '/session/' + progress.sessionId);
      await rendered('RETURN_LATEST_' + run);
      await idle();
      await shot('27-return-latest');
    });
  }
  if (stage === 'contexts') {
    const remember = async (text: string) => {
      const before = new Set((await state()).agentState.codexInputs.receipts.map((r: any) => r.id));
      await send(text, '补充当前任务');
      await wait(
        (s) =>
          s.agentState?.codexInputs?.receipts.some((r: any) => r.status === 'completed' && !before.has(r.id)),
        'new input actually completed',
      );
      await page.locator('[data-hapla-forward-row]').last().getByText(run, { exact: true }).waitFor();
    };
    await test('30 stop then ask without answer hints → real main context retained', async () => {
      await send('Run sleep 180 and wait until it returns.', '补充当前任务');
      await wait((s) => s.agentState?.codexRuntime?.turn === 'running', 'context main running');
      await page.waitForTimeout(2500);
      await page.getByRole('button', { name: '停止当前任务', exact: true }).click();
      await idle();
      await remember('What is our project name? Reply only with that exact name. Do not use tools.');
      assert.equal((await state()).agentState.codexRuntime.threadId, progress.parent);
      await shot('30-main-memory');
    });
    await test('31 fork switch then ask without answer hints → real fork context retained', async () => {
      await page
        .getByRole('button', { name: /^切换到分支，/ })
        .first()
        .click();
      await wait((s) => s.agentState?.codexRuntime?.threadId !== progress.parent, 'fork switched');
      await remember('What is our project name? Reply only with that exact name. Do not use tools.');
      await page
        .getByRole('button', { name: /^切换到分支，/ })
        .first()
        .click();
      await wait((s) => s.agentState?.codexRuntime?.threadId === progress.parent, 'original restored');
      await shot('31-fork-memory');
    });
    await test('32 stop BTW then ask without answer hints → side memory retained, main unchanged', async () => {
      const word = 'ORCHID_' + Date.now().toString(36),
        main = (await state()).agentState.codexRuntime;
      await choose('旁问 BTW');
      await page.getByRole('button', { name: '新旁问', exact: true }).click();
      await send('Remember this side word: ' + word + '. Reply only MEMORIZED. Do not use tools.');
      let s = await wait(
        (s) =>
          s.agentState?.codexSideChats?.some(
            (c: any) =>
              c.status === 'idle' &&
              c.messages.some((m: any) => m.role === 'user' && m.text.includes(word)) &&
              c.messages.at(-1)?.text.trim() === 'MEMORIZED',
          ),
        'side memorized',
      );
      const id = s.agentState.codexSideChats.find((c: any) =>
        c.messages.some((m: any) => m.role === 'user' && m.text.includes(word)),
      ).id;
      await send('Run sleep 180 and wait until it returns.');
      await wait(
        (s) => s.agentState?.codexSideChats?.find((c: any) => c.id === id)?.status === 'running',
        'side running',
      );
      await page.waitForTimeout(2500);
      await page.getByRole('button', { name: '停止旁问', exact: true }).click();
      await wait(
        (s) => s.agentState?.codexSideChats?.find((c: any) => c.id === id)?.status === 'interrupted',
        'side interrupted',
      );
      await send('What is our side word? Reply only with that exact word. Do not use tools.');
      s = await wait(
        (s) =>
          s.agentState?.codexSideChats?.some(
            (c: any) =>
              c.id === id &&
              c.status === 'idle' &&
              c.messages.at(-1)?.role === 'assistant' &&
              c.messages.at(-1)?.text.trim() === word,
          ),
        'unprompted side memory',
      );
      await page.locator('.hapla-btw-message.is-assistant').getByText(word, { exact: true }).waitFor();
      assert.equal(s.agentState.codexRuntime.threadId, main.threadId);
      assert.equal(s.agentState.codexRuntime.turnId, main.turnId);
      assert.equal(s.agentState.codexRuntime.runtime, 'idle');
      await shot('32-side-memory');
      await page.getByRole('button', { name: '关闭旁聊', exact: true }).click();
      await page.getByRole('button', { name: '收起旁问', exact: true }).click();
    });
  }
  if (stage === 'logout') {
    const upstream = createServer((_req, res) => res.end('LOGOUT_PREVIEW_' + run));
    await new Promise<void>((resolve) => upstream.listen(0, '0.0.0.0', resolve));
    const port = (upstream.address() as any).port;
    let direct: any;
    try {
      await test('28 actual account Logout UI → preview cookie removed → previous link rejects access', async () => {
        await page.goto(webOrigin + '/session/' + progress.sessionId + '/preview');
        await page.getByRole('textbox', { name: '网页地址或 HTML 路径' }).fill(`http://127.0.0.1:${port}/`);
        await page.getByRole('button', { name: '注册并打开', exact: true }).click();
        await page
          .frameLocator('iframe[title="网页交互预览"]')
          .getByText('LOGOUT_PREVIEW_' + run, { exact: true })
          .waitFor();
        const stable = (await page
          .getByRole('link', { name: '在浏览器打开', exact: true })
          .getAttribute('href'))!;
        direct = await context.newPage();
        assert.equal((await direct.goto(stable))!.status(), 200);
        await page.goto(webOrigin + '/settings/account');
        await page
          .getByText(/^(Logout|登出)$/i)
          .first()
          .click();
        await page
          .getByText(/^(Logout|登出)$/i)
          .last()
          .click();
        await page.waitForFunction(() => !localStorage.getItem('auth_credentials'));
        assert(!(await context.cookies()).some((cookie) => cookie.name === 'hapla_preview_auth'));
        assert.equal((await direct.reload())!.status(), 401);
        await shot('28-logged-out');
        const cleanup = await browser.newContext();
        await cleanup.addInitScript(
          ({ token, secret }: any) =>
            localStorage.setItem('auth_credentials', JSON.stringify({ token, secret })),
          c,
        );
        const p = await cleanup.newPage();
        await p.goto(webOrigin + '/session/' + progress.sessionId + '/preview');
        await p.getByRole('button', { name: `127.0.0.1:${port}`, exact: true }).click();
        await p.getByRole('button', { name: '删除此代理', exact: true }).click();
        await p.getByRole('button', { name: '注册并打开', exact: true }).waitFor();
        await cleanup.close();
      });
    } finally {
      upstream.closeAllConnections();
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
      if (direct) await direct.close();
    }
  }
  if (stage === 'mobile') {
    const receiptIds = async () =>
      new Set((await state()).agentState?.codexInputs?.receipts?.map((r: any) => r.id) ?? []);
    const completedAfter = async (before: Set<string>) =>
      wait(
        (s) =>
          s.agentState?.codexInputs?.receipts.some((r: any) => r.status === 'completed' && !before.has(r.id)),
        'new mobile input completed',
      );
    const latestAnswer = async (text: string) =>
      page
        .locator('[data-hapla-forward-row]')
        .last()
        .getByText(text, { exact: true })
        .waitFor({ timeout: 100000 });
    const assertMain = async () => {
      const s = await state();
      assert.equal(s.agentState.codexRuntime.threadId, progress.parent);
      assert.equal(s.agentState.codexRuntime.turnId, progress.turn);
      assert.equal(s.agentState.codexRuntime.turn, 'running');
    };
    const mobileAction = async (label: string) => {
      const direct = page.getByRole('button', { name: label, exact: true });
      if (await direct.isVisible().catch(() => false)) {
        await direct.tap();
        return;
      }
      await page.getByRole('button', { name: '更多输入操作', exact: true }).tap();
      await page.getByRole('menuitem', { name: label, exact: true }).tap();
    };
    const closeQueue = async () => page.getByRole('button', { name: '收起队列', exact: true }).tap();
    const closeSettings = async () => {
      await page.touchscreen.tap(4, page.viewportSize()!.height - 4);
      await page.getByLabel('会话设置面板', { exact: true }).waitFor({ state: 'hidden' });
    };
    const tapBox = async (locator: any) => {
      const box = await locator.boundingBox();
      assert(
        box &&
          box.x >= 0 &&
          box.y >= 0 &&
          box.x + box.width <= page.viewportSize()!.width + 1 &&
          box.y + box.height <= page.viewportSize()!.height + 1,
        'Mobile touch control outside viewport',
      );
      await locator.tap();
    };
    await test('01 mobile new-session sheet → multiline Enter → tap Start → real Codex response', async () => {
      await page.goto(webOrigin + '/new');
      assert(
        await page.evaluate(
          () =>
            matchMedia('(pointer: coarse)').matches &&
            (navigator.maxTouchPoints > 0 || 'ontouchstart' in window),
        ),
      );
      await page.getByRole('button', { name: '选择工作目录', exact: true }).tap();
      await page.getByRole('textbox', { name: '目录路径', exact: true }).fill('/workspace');
      await page.getByRole('button', { name: '使用此路径', exact: true }).tap();
      await page.getByRole('textbox', { name: '目录路径', exact: true }).waitFor({ state: 'hidden' });
      const prompt = page.getByRole('textbox', { name: 'Session prompt', exact: true });
      await prompt.fill('第一行🙂');
      await prompt.press('Enter');
      assert((await prompt.inputValue()).includes('\n'));
      assert(!page.url().includes('/session/'));
      await prompt.fill(`Remember our project name ${run}. Reply exactly READY_${run}. Do not use tools.`);
      await tapBox(page.getByRole('button', { name: 'Start session', exact: true }));
      await page.waitForURL(/\/session\//, { timeout: 100000 });
      progress.sessionId = page.url().split('/session/')[1].split(/[/?]/)[0];
      save();
      await latestAnswer('READY_' + run);
      await idle();
      const s = await state();
      assert.equal(s.metadata.path, '/workspace');
      progress.parent = s.agentState.codexRuntime.threadId;
      save();
      assert.equal(await page.getByRole('button', { name: /语音|录音|voice input/i }).count(), 0);
      await shot('01-phone-created');
    });
    await test('02 phone settings taps → bounded panel → save preference → reload persists', async () => {
      await composer().fill('设置前保留的草稿🙂');
      await mobileAction('Open session settings');
      const panel = page.getByLabel('会话设置面板', { exact: true });
      await panel.waitFor();
      const b = await panel.boundingBox();
      assert(b && b.x >= 0 && b.x + b.width <= page.viewportSize()!.width + 1 && b.y >= 0);
      await page.getByLabel('输出详略', { exact: true }).selectOption('low');
      assert(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        'Settings backdrop makes phone page scroll horizontally',
      );
      await shot('02-phone-settings');
      await closeSettings();
      assert.equal(await composer().inputValue(), '设置前保留的草稿🙂');
      await page.reload();
      await mobileAction('Open session settings');
      assert.equal(await page.getByLabel('输出详略', { exact: true }).inputValue(), 'low');
      await closeSettings();
      await composer().fill('');
    });
    await test('03 phone terminal → tap keyboard → type command + Return → real output → close', async () => {
      await terminalOpen();
      await shell(`mkdir -p /workspace/.${run} && printf '%s\\n' TERMINAL_${run}`, 'TERMINAL_' + run);
      await shot('03-phone-terminal');
      await closeTerminal();
      await composer().waitFor();
    });
    await test('04 phone main task → tap steering → same native turn continues', async () => {
      await send(
        `Run this shell command and wait until it returns: for i in $(seq 1 300); do if test -f /workspace/.${run}/release; then break; fi; sleep 1; done . Then reply MAIN_${run} and any requested extra markers.`,
        '补充当前任务',
      );
      let s = await wait((s) => s.agentState?.codexRuntime?.turn === 'running', 'mobile main running');
      progress.turn = s.agentState.codexRuntime.turnId;
      save();
      await send('Additional instruction: include STEER_' + run + ' in the final reply.');
      await wait(
        (s) => s.agentState?.codexInputs?.receipts.some((r: any) => r.status === 'steered'),
        'mobile steer ack',
      );
      await assertMain();
    });
    await test('05 phone queue taps → pause → edit → reorder → delete → inject', async () => {
      await send(`Reply exactly QUEUE_FIRST_${run}. Do not use tools.`, '排队下一轮');
      await send(`Reply exactly QUEUE_DELETE_${run}. Do not use tools.`);
      await wait((s) => s.agentState?.codexInputs?.items.length === 2, 'phone queue two');
      await queueOpen();
      await page.getByRole('button', { name: '暂停队列', exact: true }).tap();
      await wait((s) => s.agentState?.codexInputs?.paused, 'phone queue paused');
      await page.getByRole('button', { name: '修改', exact: true }).first().tap();
      await page
        .getByRole('textbox', { name: '编辑排队消息', exact: true })
        .fill(`Reply exactly QUEUE_EDITED_${run}. Do not use tools.`);
      await page.getByRole('button', { name: '保存', exact: true }).tap();
      await wait(
        (s) => s.agentState?.codexInputs?.items[0].message.includes('QUEUE_EDITED'),
        'phone queue saved',
      );
      await page.getByRole('button', { name: '上移', exact: true }).tap();
      await wait(
        (s) => s.agentState?.codexInputs?.items[0].message.includes('QUEUE_DELETE'),
        'phone reordered',
      );
      await page.getByRole('button', { name: '删除', exact: true }).first().tap();
      await wait((s) => s.agentState?.codexInputs?.items.length === 1, 'phone deleted');
      await shot('05-phone-queue');
      await closeQueue();
      await send('Additional instruction: include INJECT_' + run + ' in the final reply.', '排队下一轮');
      await wait((s) => s.agentState?.codexInputs?.items.length === 2, 'phone inject queued');
      await queueOpen();
      await page.getByRole('button', { name: '立即发送', exact: true }).last().tap();
      await wait((s) => s.agentState?.codexInputs?.items.length === 1, 'phone injected');
      await closeQueue();
      await assertMain();
    });
    await test('06 phone BTW → true context → continue → stop only side → recall without answer hints', async () => {
      await send('What is our project name? Reply only with that exact name. Do not use tools.', '旁问 BTW');
      let s = await wait(
        (s) =>
          s.agentState?.codexSideChats?.some(
            (c: any) => c.status === 'idle' && c.messages.at(-1)?.text.trim() === run,
          ),
        'phone BTW inherits context',
      );
      progress.chatId = s.agentState.codexSideChats.find(
        (c: any) => c.messages.at(-1)?.text.trim() === run,
      ).id;
      progress.word = 'ORCHID_' + Date.now().toString(36);
      save();
      await page.locator('.hapla-btw-message.is-assistant').getByText(run, { exact: true }).waitFor();
      await tapBox(page.getByRole('button', { name: '在下方输入框继续旁问', exact: true }));
      await send('Remember this side word: ' + progress.word + '. Reply only MEMORIZED. Do not use tools.');
      await wait(
        (s) =>
          s.agentState?.codexSideChats?.some(
            (c: any) =>
              c.id === progress.chatId &&
              c.status === 'idle' &&
              c.messages.at(-1)?.text.trim() === 'MEMORIZED',
          ),
        'phone side word memorized',
      );
      await send('Run sleep 180 and wait until it returns.');
      await wait(
        (s) => s.agentState?.codexSideChats?.find((c: any) => c.id === progress.chatId)?.status === 'running',
        'phone side running',
      );
      await page.waitForTimeout(2000);
      await tapBox(page.getByRole('button', { name: '停止旁问', exact: true }));
      await wait(
        (s) =>
          s.agentState?.codexSideChats?.find((c: any) => c.id === progress.chatId)?.status === 'interrupted',
        'phone side stopped',
      );
      await assertMain();
      await send('What is our side word? Reply only with that exact word. Do not use tools.');
      await wait(
        (s) =>
          s.agentState?.codexSideChats?.some(
            (c: any) =>
              c.id === progress.chatId &&
              c.status === 'idle' &&
              c.messages.at(-1)?.text.trim() === progress.word,
          ),
        'phone side recalls after stop',
      );
      await assertMain();
      await shot('06-phone-btw');
    });
    await test('07 phone new/switch/delete side chat → close/reopen preserves previous side', async () => {
      await page.getByRole('button', { name: '新旁问', exact: true }).tap();
      await send(`Reply exactly SECOND_SIDE_${run}. Do not use tools.`);
      await wait(
        (s) =>
          s.agentState?.codexSideChats?.some(
            (c: any) => c.status === 'idle' && c.messages.at(-1)?.text.trim() === 'SECOND_SIDE_' + run,
          ),
        'phone second side',
      );
      await page.getByLabel('选择旁聊', { exact: true }).selectOption(progress.chatId);
      assert.equal(await page.getByLabel('选择旁聊', { exact: true }).inputValue(), progress.chatId);
      await page.getByRole('button', { name: '收起旁问', exact: true }).tap();
      await page.getByRole('button', { name: '打开旁问侧栏', exact: true }).tap();
      assert.equal(await page.getByLabel('选择旁聊', { exact: true }).inputValue(), progress.chatId);
      const s = await state();
      const second = s.agentState.codexSideChats.find((c: any) => c.id !== progress.chatId);
      await page.getByLabel('选择旁聊', { exact: true }).selectOption(second.id);
      await page.getByRole('button', { name: '关闭旁聊', exact: true }).tap();
      await wait((s) => s.agentState?.codexSideChats?.length === 1, 'phone remove side');
      await page.getByRole('button', { name: '收起旁问', exact: true }).tap();
      await assertMain();
    });
    await test('08 phone overflow menu forks while main turn stays active', async () => {
      await page.getByRole('button', { name: '更多输入操作', exact: true }).tap();
      await page.getByRole('menuitem', { name: '新分支', exact: true }).tap();
      await wait((s) => (s.metadata?.codexBranches?.length ?? 0) >= 2, 'phone fork persisted');
      await assertMain();
    });
    await test('09 phone terminal releases task → live final result → explicitly continue queue', async () => {
      await terminalOpen();
      await shell(`touch /workspace/.${run}/release && printf '%s\\n' RELEASE_${run}`, 'RELEASE_' + run);
      await closeTerminal();
      await idle();
      await page
        .getByText(new RegExp('MAIN_' + run))
        .last()
        .waitFor();
      const text = await page.locator('[data-hapla-forward-row]').last().innerText();
      assert(text.includes('STEER_' + run) && text.includes('INJECT_' + run));
      let s = await state();
      assert(s.agentState.codexInputs.paused && s.agentState.codexInputs.items.length === 1);
      await queueOpen();
      await page.getByRole('button', { name: '继续队列', exact: true }).tap();
      await latestAnswer('QUEUE_EDITED_' + run);
      await idle();
      s = await wait((s) => s.agentState?.codexInputs?.items.length === 0, 'phone queue completed');
      await closeQueue();
      await shot('09-phone-completed');
    });
    await test('10 phone stop tap → idle → real context recall without answer hints', async () => {
      await send('Run sleep 180 and wait until it returns.', '补充当前任务');
      await wait((s) => s.agentState?.codexRuntime?.turn === 'running', 'phone main stop running');
      await page.waitForTimeout(2000);
      await tapBox(page.getByRole('button', { name: '停止当前任务', exact: true }));
      await idle();
      const before = await receiptIds();
      await send('What is our project name? Reply only with that exact name. Do not use tools.');
      await completedAfter(before);
      await latestAnswer(run);
      assert.equal((await state()).agentState.codexRuntime.threadId, progress.parent);
    });
    await test('11 phone stop-and-send → replacement finishes while older queue remains paused', async () => {
      await send(`Reply exactly NOT_YET_${run}. Do not use tools.`, '排队下一轮');
      await wait(
        (s) => s.agentState?.codexInputs?.items.length === 1 && s.agentState.codexInputs.paused,
        'phone old pending',
      );
      await send('Run sleep 180 and wait until it returns.', '补充当前任务');
      await wait((s) => s.agentState?.codexRuntime?.turn === 'running', 'phone replace running');
      await send(`Reply exactly REPLACED_${run}. Do not use tools.`, '停止并发送');
      await latestAnswer('REPLACED_' + run);
      await idle();
      const s = await state();
      assert(s.agentState.codexInputs.paused && s.agentState.codexInputs.items.length === 1);
      await queueOpen();
      await page.getByRole('button', { name: '删除', exact: true }).tap();
      await wait((s) => s.agentState?.codexInputs?.items.length === 0, 'phone old pending removed');
      await closeQueue();
    });
    await test('12 phone rapid send taps → exactly one completed input', async () => {
      await choose('补充当前任务');
      const before = await receiptIds();
      await composer().fill(`Reply exactly DEDUPE_${run}. Do not use tools.`);
      const sendBox = (await page.getByRole('button', { name: 'Send message', exact: true }).boundingBox())!;
      await page.getByRole('button', { name: 'Send message', exact: true }).tap();
      await page.touchscreen.tap(sendBox.x + sendBox.width / 2, sendBox.y + sendBox.height / 2);
      await completedAfter(before);
      await latestAnswer('DEDUPE_' + run);
      const added = (await state()).agentState.codexInputs.receipts.filter((r: any) => !before.has(r.id));
      assert.equal(added.length, 1);
    });
    await test('13 phone branch taps → real thread switch and unprompted context recall → original restored', async () => {
      await page
        .getByRole('button', { name: /^切换到分支，/ })
        .first()
        .tap();
      await wait((s) => s.agentState?.codexRuntime?.threadId !== progress.parent, 'phone branch switched');
      const before = await receiptIds();
      await send('What is our project name? Reply only with that exact name. Do not use tools.');
      await completedAfter(before);
      await latestAnswer(run);
      await page
        .getByRole('button', { name: /^切换到分支，/ })
        .first()
        .tap();
      await wait((s) => s.agentState?.codexRuntime?.threadId === progress.parent, 'phone original restored');
    });
    await test('14 phone Plan select → native structured question → tap option → provider continues', async () => {
      await mobileAction('Open session settings');
      await page.getByLabel('Codex 工作模式', { exact: true }).selectOption('plan');
      await closeSettings();
      await send(
        `Use request_user_input now. Ask a question id=color header=Color question="Choose a color" with options Blue and Green. Wait for the answer. Then reply exactly ANSWERED_${run}.`,
        '补充当前任务',
      );
      await wait(
        (s) =>
          Object.entries(s.agentState?.requests ?? {}).some(
            ([id, r]: any) => r.tool === 'AskUserQuestion' && !s.agentState?.completedRequests?.[id],
          ),
        'phone structured input',
      );
      await page
        .getByRole('button', { name: /^Blue(?: \(Recommended\))?$/ })
        .last()
        .tap();
      await latestAnswer('ANSWERED_' + run);
      await idle();
      await mobileAction('Open session settings');
      await page.getByLabel('Codex 工作模式', { exact: true }).selectOption('default');
      await closeSettings();
      await shot('14-phone-question');
    });
    await test('15 narrow phone history 140 questions → filter → tap reuse → edit and reload draft', async () => {
      await page.goto(webOrigin + '/session/' + c.historySessionId);
      await mobileAction('当前会话全部历史问题');
      await loadAllQuestions();
      assert.equal(
        await page
          .getByLabel('历史问题面板')
          .getByText(/^历史问题 \d{3}/)
          .count(),
        140,
      );
      await page.getByRole('textbox', { name: '筛选已加载的历史问题', exact: true }).fill('001');
      await page.getByText('历史问题 001：开发验收记录', { exact: true }).tap();
      assert((await composer().inputValue()).includes('001'));
      await composer().fill('手机历史复用🙂 ' + run);
      await page.waitForTimeout(1000);
      await page.reload();
      await composer().waitFor();
      assert.equal(await composer().inputValue(), '手机历史复用🙂 ' + run);
      await composer().fill('');
      await mobileAction('当前会话全部历史问题');
      await shot('15-phone-history');
      await page.goto(webOrigin + '/session/' + progress.sessionId);
      await page.getByRole('button', { name: '选择发送方式', exact: true }).waitFor();
    });
    await test('16 phone proxy UI → tap iframe button → update upstream with same URL → delete', async () => {
      const servers: any[] = [];
      const fixture = async (label: string) => {
        const server = createServer((req, res) => {
          if (req.url === '/api') {
            res.setHeader('content-type', 'application/json');
            res.end(JSON.stringify({ label }));
          } else {
            res.setHeader('content-type', 'text/html;charset=utf-8');
            res.end(
              `<h1>${label}</h1><button id="go" style="font-size:20px;padding:14px">读取</button><div id="value"></div><script>document.querySelector('#go').onclick=()=>fetch('/api').then(r=>r.json()).then(v=>document.querySelector('#value').textContent=v.label)</script>`,
            );
          }
        });
        await new Promise<void>((resolve) => server.listen(0, '0.0.0.0', resolve));
        servers.push(server);
        return (server.address() as any).port;
      };
      try {
        const a = await fixture('PROXY_A_' + run),
          b = await fixture('PROXY_B_' + run);
        await page.getByRole('button', { name: '预览', exact: true }).tap();
        await page
          .getByRole('textbox', { name: '网页地址或 HTML 路径', exact: true })
          .fill(`http://127.0.0.1:${a}/`);
        await page.getByRole('button', { name: '注册并打开', exact: true }).tap();
        const frame = page.frameLocator('iframe[title="网页交互预览"]');
        await frame.locator('#go').tap();
        await frame
          .locator('#value')
          .getByText('PROXY_A_' + run, { exact: true })
          .waitFor();
        const stable = (await page
          .getByRole('link', { name: '在浏览器打开', exact: true })
          .getAttribute('href'))!;
        assert(stable.startsWith(webOrigin + '/preview/'));
        await page
          .getByRole('textbox', { name: '网页地址或 HTML 路径', exact: true })
          .fill(`http://127.0.0.1:${b}/`);
        await page.getByRole('button', { name: '更新目标并打开', exact: true }).tap();
        await frame.locator('#go').tap();
        await frame
          .locator('#value')
          .getByText('PROXY_B_' + run, { exact: true })
          .waitFor();
        assert.equal(
          await page.getByRole('link', { name: '在浏览器打开', exact: true }).getAttribute('href'),
          stable,
        );
        await shot('16-phone-proxy');
        await page.getByRole('button', { name: '删除此代理', exact: true }).tap();
        await page.getByRole('button', { name: '注册并打开', exact: true }).waitFor();
        const direct = await context.newPage();
        assert.equal((await direct.goto(stable))!.status(), 404);
        await direct.close();
      } finally {
        for (const server of servers) {
          server.closeAllConnections();
          await new Promise<void>((resolve) => server.close(() => resolve()));
        }
        await page.goto(webOrigin + '/session/' + progress.sessionId);
        await page.getByRole('button', { name: '选择发送方式', exact: true }).waitFor();
      }
    });
    await test('17 phone dark mode + small heights + landscape → visible composer and reachable side close', async () => {
      await page.emulateMedia({ colorScheme: 'dark' });
      await page.reload();
      await page.getByRole('button', { name: '打开旁问侧栏', exact: true }).tap();
      await page.getByLabel('选择旁聊', { exact: true }).selectOption(progress.chatId);
      for (const viewport of [
        { width: 360, height: 800 },
        { width: 390, height: 844 },
        { width: 412, height: 915 },
        { width: 390, height: 520 },
        { width: 390, height: 440 },
        { width: 844, height: 390 },
      ]) {
        await page.setViewportSize(viewport);
        await composer().fill('手机多行输入🙂\n第二行');
        await composer().tap();
        await page.waitForTimeout(200);
        const input = await composer().boundingBox(),
          panel = await page.getByLabel('旁问侧栏', { exact: true }).boundingBox(),
          footer = await page.locator('.hapla-btw-footer').boundingBox();
        assert(input && panel);
        assert(
          input.x >= 0 &&
            input.x + input.width <= viewport.width + 1 &&
            input.y + input.height <= viewport.height,
        );
        assert(
          panel.y + panel.height <= (await page.locator('[id^=\"hapla-composer-\"]').boundingBox())!.y,
          'Phone side panel covers composer toolbar',
        );
        if (footer)
          assert(footer.y + footer.height <= panel.y + panel.height + 1, 'Phone side footer overflows panel');
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
        await shot(`17-phone-${viewport.width}x${viewport.height}`);
        await tapBox(page.getByRole('button', { name: '收起旁问', exact: true }));
        await page.getByLabel('旁问侧栏', { exact: true }).waitFor({ state: 'hidden' });
        await composer().tap();
        await page.getByRole('button', { name: '打开旁问侧栏', exact: true }).tap();
      }
      await composer().fill('');
      await send('Run sleep 180 and wait until it returns.');
      await wait(
        (s) => s.agentState?.codexSideChats?.find((c: any) => c.id === progress.chatId)?.status === 'running',
        'landscape side running',
      );
      await page.waitForTimeout(2000);
      await shot('17-phone-landscape-stop');
      await tapBox(page.getByRole('button', { name: '停止旁问', exact: true }));
      await wait(
        (s) =>
          s.agentState?.codexSideChats?.find((c: any) => c.id === progress.chatId)?.status === 'interrupted',
        'landscape side stopped',
      );
      assert.equal((await state()).agentState.codexRuntime.runtime, 'idle');
      await page.getByRole('button', { name: '收起旁问', exact: true }).tap();
      await page.setViewportSize(phoneViewport);
      assert.equal(await page.getByRole('button', { name: /语音|录音|voice input/i }).count(), 0);
    });
    await test('18 phone offline send → draft retained → reconnect and tap retry → actual completion', async () => {
      await choose('补充当前任务');
      const before = await receiptIds(),
        draft = `Reply exactly RETRY_${run}. Do not use tools.`;
      await context.setOffline(true);
      await page.waitForTimeout(1200);
      await composer().fill(draft);
      await page.getByRole('button', { name: 'Send message', exact: true }).tap();
      await page
        .getByText(/^(Socket not connected|网络已离线，请恢复连接后重试)$/)
        .waitFor({ timeout: 30000 });
      assert.equal(await composer().inputValue(), draft);
      await shot('18-phone-offline');
      await context.setOffline(false);
      await page.getByText('确定', { exact: true }).tap();
      await page.waitForTimeout(5200);
      await send(draft);
      await completedAfter(before);
      await latestAnswer('RETRY_' + run);
    });
    await test('19 phone long streaming answer → newest result visible without Latest tap', async () => {
      const before = await receiptIds();
      await send(
        `Output 35 numbered short lines about frontend testing, followed by a separate paragraph exactly FRESH_${run}. Do not use tools.`,
        '补充当前任务',
      );
      await completedAfter(before);
      await page
        .getByText('FRESH_' + run, { exact: true })
        .last()
        .waitFor();
      await page.waitForTimeout(300);
      const last = await page
          .getByText('FRESH_' + run, { exact: true })
          .last()
          .boundingBox(),
        input = await composer().boundingBox();
      assert(
        last && input && last.y >= 0 && last.y + last.height <= input.y,
        'Phone latest answer is outside viewport',
      );
      await shot('19-phone-freshness');
    });
    await test('20 compact toolbar → explicit stop keeps draft → history/settings dismiss → real attachment pickers', async () => {
      await send('Run sleep 180 and wait until it returns.', '补充当前任务');
      await wait((s) => s.agentState?.codexRuntime?.turn === 'running', 'draft stop main running');
      await page.waitForTimeout(2000);
      const draft = '保留这段草稿，不要因为停止任务丢失。' + run;
      await composer().fill(draft);
      assert(await page.getByRole('button', { name: 'Send message', exact: true }).isEnabled());
      await mobileAction('停止当前任务');
      await idle();
      assert.equal((await state()).agentState.codexRuntime.threadId, progress.parent);
      assert.equal(await composer().inputValue(), draft);
      await mobileAction('Open session settings');
      await closeSettings();
      assert.equal(await composer().inputValue(), draft);
      await mobileAction('当前会话全部历史问题');
      await page.getByLabel('历史问题面板', { exact: true }).waitFor();
      await page.touchscreen.tap(4, phoneViewport.height - 4);
      await page.getByLabel('历史问题面板', { exact: true }).waitFor({ state: 'hidden' });
      assert.equal(await composer().inputValue(), draft);
      for (const label of ['添加附件', 'Attach image']) {
        const pending = page.waitForEvent('filechooser');
        await mobileAction(label);
        const picker = await pending;
        await picker.setFiles([]);
        assert.equal(await composer().inputValue(), draft);
      }
      await page.getByRole('button', { name: '更多输入操作', exact: true }).tap();
      await shot('20-phone-more-draft');
      await page.touchscreen.tap(4, phoneViewport.height - 4);
      await page.getByRole('menu', { name: '输入操作', exact: true }).waitFor({ state: 'hidden' });
      await composer().fill('');
    });
    await terminalOpen();
    await shell(
      `if test -d /workspace/.${run}; then rm -f /workspace/.${run}/release && rmdir /workspace/.${run}; fi && printf '%s\\n' CLEAN_${run}`,
      'CLEAN_' + run,
    );
    await closeTerminal();
    progress.mobileComplete = true;
    save();
  }
  log({ type: 'stage-complete', pageErrors: errors });
  assert.deepEqual(errors, []);
  save();
} catch (error: any) {
  log({ type: 'failure', message: error.message });
  await shot('failure').catch(() => {});
  writeFileSync(
    out + '/' + stage + '-failure-body.txt',
    (await page.locator('body').innerText()).slice(-10000),
  );
  throw error;
} finally {
  await context.close();
  for (const [index, p] of recordedPages.entries()) {
    const video = p.video();
    if (video)
      appendFileSync(
        out + '/videos.ndjson',
        JSON.stringify({ run, stage, index, file: (await video.path()).slice(out.length + 1) }) + '\n',
      );
  }
  await browser.close();
}
