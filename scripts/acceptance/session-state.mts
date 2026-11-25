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
const output = process.env.HAPLA_ACCEPTANCE_OUTPUT ?? '/repo/artifacts/state-repair/browser'; mkdirSync(output, { recursive: true });
const log = (value: object) => { const line = JSON.stringify({ at: new Date().toISOString(), ...value }); appendFileSync(join(output, 'actions.ndjson'), line + '\n'); console.log(line); };
const profile = process.env.PROFILE ?? 'desktop';
const observations: any[] = [];
const provider = await startResponsesFixture(value => { observations.push(value); log(value); });
mkdirSync(process.env.CODEX_HOME!, { recursive: true });
writeFileSync(join(process.env.CODEX_HOME!, 'config.toml'), `model = "gpt-6-astra"\nmodel_provider = "hapla_fixture"\nmodel_reasoning_effort = "low"\nmodel_context_window = 262144\n[model_providers.hapla_fixture]\nname = "Hapla deterministic fixture"\nbase_url = "${provider.url}"\nwire_api = "responses"\nrequires_openai_auth = false\n`);
await waitFor(async () => fetch(api + '/health').then(response => response.ok).catch(() => false), value => value, 'development server health');
const secret = randomBytes(32); const token = await authGetToken(secret);
await writeCredentialsLegacy({ secret, token }); await writeSettings({ machineId: randomUUID(), machineIdConfirmedByServer: true });
const root = `/workspace/coding-acceptance-${randomUUID().slice(0, 8)}`; mkdirSync(root, { recursive: true });
await git(root, ['init', '-b', 'main']); await git(root, ['config', 'user.name', 'Hapla acceptance']); await git(root, ['config', 'user.email', 'acceptance@hapla.test']);
writeFileSync(join(root, 'tracked.txt'), 'original\n'); await git(root, ['add', '.']); await git(root, ['commit', '-m', 'fixture base']);
const daemonOutput = openSync(join(output, 'daemon.log'), 'a');
const daemon = spawn(process.execPath, ['/repo/packages/hapla-cli/dist/index.mjs', 'daemon', 'start-sync'], { cwd: root, env: process.env, stdio: ['ignore', daemonOutput, daemonOutput] });
process.once('exit', () => { daemon.kill('SIGTERM'); });
const pw = await import(process.env.HAPLA_PLAYWRIGHT_MODULE || '/opt/hapla-browser/node_modules/playwright/index.mjs');
const browser = await pw[profile === 'iphone' ? 'webkit' : 'chromium'].launch({ headless: true, ...(profile === 'iphone' ? {} : { args: ['--no-sandbox'], ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}) }) });
const context = await browser.newContext({ ...(profile === 'desktop' ? { viewport: { width: 1440, height: 1000 } } : pw.devices[profile === 'iphone' ? 'iPhone 13' : 'Pixel 7']), locale: 'en-US', recordVideo: { dir: join(output, 'video') } });
await context.addInitScript(({ token, secret }) => { localStorage.setItem('auth_credentials', JSON.stringify({ token, secret })); }, { token, secret: secret.toString('base64url') });
const page = await context.newPage();
page.on('requestfailed', request => { const url = new URL(request.url()); log({ type: 'request-failed', method: request.method(), url: url.origin + url.pathname, error: request.failure()?.errorText }); });
page.setDefaultTimeout(30_000); const errors: string[] = []; page.on('pageerror', e => { errors.push(e.message); log({type:'browser-error',message:e.message}); });
const headers = { authorization: 'Bearer ' + token };
async function sessions() { const response = await fetch(api + '/v1/sessions', { headers }); assert(response.ok); return (await response.json()).sessions; }
async function waitFor<T>(read: () => Promise<T>, ready: (value: T) => boolean, label: string): Promise<T> {
    const deadline = Date.now() + 60_000; let value: T;
    do { value = await read(); if (ready(value)) return value; await new Promise(resolve => setTimeout(resolve, 200)); } while (Date.now() < deadline);
    throw new Error(`Timed out: ${label}`);
}

async function runtime() {
    const record = (await sessions()).find((s:any)=>s.id===sessionId);
    return { record, metadata: record?.metadata ? decrypt(secret,'legacy',Buffer.from(record.metadata,'base64')) as any : null,
      state: record?.agentState ? decrypt(secret,'legacy',Buffer.from(record.agentState,'base64')) as any : null };
}
let sessionId = '';
await page.addInitScript(() => { (window as any).__stateTouches=0; addEventListener('pointerdown',(event:PointerEvent)=>{if(event.pointerType==='touch')(window as any).__stateTouches++;}); });
const click = (locator:any) => profile==='desktop' ? locator.click() : locator.tap();
async function openSettings(p:any) {
    const direct=p.getByRole('button',{name:'Open session settings',exact:true});
    if(p!==page || profile==='desktop') { await direct.click(); return; }
    if(await direct.isVisible().catch(()=>false)) { await direct.tap(); return; }
    await p.getByRole('button',{name:'更多输入操作',exact:true}).tap();
    await p.getByRole('menuitem',{name:'Open session settings',exact:true}).tap();
}
async function dismiss(p:any) { if(p===page && profile!=='desktop') await p.touchscreen.tap(4,p.viewportSize().height-4);else await p.keyboard.press('Escape'); }
const composer=(p:any)=>p.locator('[id^="hapla-composer-"] textarea').first();
async function send(p:any, marker:string) {
    const before=(await runtime()).state?.codexInputs?.receipts?.at(-1)?.id;
    await composer(p).fill(marker); await (p===page ? click(p.getByRole('button',{name:'Send message',exact:true})) : p.getByRole('button',{name:'Send message',exact:true}).click());
    await waitFor(runtime,s=>s.state?.codexInputs?.receipts?.at(-1)?.id!==before && s.state?.codexInputs?.receipts?.at(-1)?.status==='completed','native completion '+marker);
}
try {
    await waitFor(async ()=>(await fetch(api+'/v1/machines',{headers})).json(),data=>(Array.isArray(data)?data:data.machines??[]).some((m:any)=>m.active),'fixture machine online');
    await page.goto(origin+'/new');
    await click(page.getByRole('button',{name:'选择工作目录',exact:true}));
    await page.getByRole('textbox',{name:'目录路径',exact:true}).fill(root);
    await click(page.getByRole('button',{name:'使用此路径',exact:true}));
    await page.getByRole('textbox',{name:'Session prompt',exact:true}).fill('AUDIT_INITIAL');
    await click(page.getByRole('button',{name:'Start session',exact:true}));
    await page.waitForURL(/\/session\//); sessionId=new URL(page.url()).pathname.split('/').pop()!;
    await waitFor(runtime,s=>s.state?.codexInputs?.receipts?.at(-1)?.status==='completed','initial native completion');
    await openSettings(page);
    await page.getByRole('combobox',{name:'思考深度',exact:true}).selectOption('high');
    await page.getByRole('combobox',{name:'Codex 工作模式',exact:true}).selectOption('plan');
    await page.getByRole('combobox',{name:'输出详略',exact:true}).selectOption('high');
    assert.equal(await page.getByRole('combobox',{name:'思考深度',exact:true}).inputValue(),'high');
    await page.screenshot({path:join(output,'device-a-high.png')});
    await dismiss(page);

    const current=await runtime(); log({type:'runtime-model-before-send',model:current.metadata?.currentModelCode,modelCount:current.metadata?.models?.length});
    const machines=await (await fetch(api+'/v1/machines',{headers})).json(); for(const m of (Array.isArray(machines)?machines:machines.machines??[])){ if(m.metadata){ const mm=decrypt(secret,'legacy',Buffer.from(m.metadata,'base64')) as any; log({type:'machine-models',models:mm?.cliCapabilities?.codex?.models?.map((x:any)=>({code:x.code,levels:x.supportedEffortLevels})),fallback:mm?.codexModels?.map((x:any)=>({code:x.code,levels:x.supportedEffortLevels}))}); }}
    await openSettings(page);
    await click(page.getByText('read-only',{exact:true}).first());
    await send(page,'AUDIT_DEVICE_A_HIGH');
    assert.equal((await runtime()).metadata.effectiveConfiguration.permissionMode, 'read-only');
    const strangerToken = await authGetToken(randomBytes(32));
    assert.equal((await fetch(api+'/v1/sessions/'+sessionId+'/metadata', {headers:{authorization:'Bearer '+strangerToken}})).status,404);
    const aNative=observations.findLast((v:any)=>v.auditMarker==='AUDIT_DEVICE_A_HIGH');
    const rawMessages=await (await fetch(api+'/v3/sessions/'+sessionId+'/messages?limit=100',{headers})).json();
    log({type:'sent-meta',values:(rawMessages.messages??[]).filter((m:any)=>m.content?.t==='encrypted').map((m:any)=>decrypt(secret,'legacy',Buffer.from(m.content.c,'base64'))).filter((v:any)=>v?.role==='user').map((v:any)=>({meta:{effort:v.meta?.effort,model:v.meta?.model,permissionMode:v.meta?.permissionMode,collaborationMode:v.meta?.collaborationMode,verbosity:v.meta?.verbosity},text:v.content?.text}))});
    assert.equal(aNative?.reasoning?.effort,'high');
    log({type:'confirmed',name:'device-a-effective-high',effort:aNative.reasoning.effort});
    const b=await browser.newContext({viewport:{width:1440,height:1000},locale:'en-US',recordVideo:{dir:join(output,'video')}});
    await b.addInitScript(({token,secret})=>localStorage.setItem('auth_credentials',JSON.stringify({token,secret})),{token,secret:secret.toString('base64url')});
    const second=await b.newPage(); second.setDefaultTimeout(30_000);
    await second.goto(origin+'/session/'+sessionId);
    await openSettings(second);
    const effort=await second.getByRole('combobox',{name:'思考深度',exact:true}).inputValue();
    const plan=await second.getByRole('combobox',{name:'Codex 工作模式',exact:true}).inputValue();
    const verbosity=await second.getByRole('combobox',{name:'输出详略',exact:true}).inputValue();
    log({type:'confirmed',name:'fresh-device-settings-preserved',effort,plan,verbosity});
    assert.equal(effort,'high'); assert.equal(plan,'plan');assert.equal(verbosity,'high');
    await second.screenshot({path:join(output,'device-b-preserved-high.png')});
    await second.keyboard.press('Escape'); await send(second,'AUDIT_DEVICE_B_SEND');
    const bNative=observations.findLast((v:any)=>v.auditMarker==='AUDIT_DEVICE_B_SEND');
    assert.equal(bNative?.reasoning?.effort,'high');
    log({type:'confirmed',name:'cross-device-high-preserved',aEffective:aNative.reasoning.effort,bDisplayed:effort,bEffective:bNative.reasoning.effort});
    // The same device still displays its stale high selection after the other device changed native execution.
    await openSettings(page);
    assert.equal(await page.getByRole('combobox',{name:'思考深度',exact:true}).inputValue(),'high');
    log({type:'confirmed',name:'device-a-shared-high'});
    await dismiss(page);
    // A field-only change on B must reach A while retaining the other preferences.
    await openSettings(second);
    await second.getByRole('combobox',{name:'思考深度',exact:true}).selectOption('medium');
    await second.keyboard.press('Escape');
    await waitFor(runtime, s=>s.metadata.executionConfiguration.values.effort==='medium','B configuration persisted');
    await openSettings(page);
    await waitFor(()=>page.getByRole('combobox',{name:'思考深度',exact:true}).inputValue(),v=>v==='medium','A receives B preference');
    assert.equal(await page.getByRole('combobox',{name:'Codex 工作模式',exact:true}).inputValue(),'plan');
    await dismiss(page);
    log({type:'confirmed',name:'remote-field-change-propagates-with-other-preferences-retained'});
    // A queued message belongs to branch A. Switch to B, then inject it into B's active turn.
    await click(page.getByRole('button',{name:profile==='desktop'?'更多会话操作':'更多输入操作',exact:true}));
    await click(page.getByRole('menuitem',{name:'新分支',exact:true}));
    const branches=await waitFor(runtime,s=>(s.metadata?.codexBranches?.length??0)>=2,'two native branches');
    const branchA=branches.metadata.activeCodexBranchId;
    const branchB=branches.metadata.codexBranches.find((x:any)=>x.id!==branchA).id;
    await click(page.getByRole('button',{name:'查看待发送队列',exact:true}));
    await click(page.getByRole('button',{name:'暂停队列',exact:true}));
    await click(page.getByRole('button',{name:'收起队列',exact:true}));
    await click(page.getByRole('button',{name:'选择发送方式',exact:true}));
    await click(page.getByRole('menuitemradio',{name:'排队下一轮',exact:true}));
    await composer(page).fill('AUDIT_QUEUED_BRANCH_A');
    await click(page.getByRole('button',{name:'Send message',exact:true}));
    const queued=await waitFor(runtime,s=>s.state?.codexInputs?.items?.some((x:any)=>x.message.includes('AUDIT_QUEUED_BRANCH_A')),'message queued on A');
    const queuedId=queued.state.codexInputs.items.find((x:any)=>x.message.includes('AUDIT_QUEUED_BRANCH_A')).id;
    await click(page.getByRole('button',{name:'查看待发送队列',exact:true}));
    await click(page.getByRole('button',{name:'修改',exact:true}));
    await page.getByRole('textbox',{name:'编辑排队消息',exact:true}).fill('AUDIT_QUEUED_BRANCH_A_EDITED');
    await click(page.getByRole('button',{name:'保存',exact:true}));
    await waitFor(runtime,s=>s.state?.codexInputs?.items?.some((x:any)=>x.message==='AUDIT_QUEUED_BRANCH_A_EDITED'),'queue edit saved');
    await click(page.getByRole('button',{name:'收起队列',exact:true}));
    await click(page.getByRole('button',{name:'切换到分支，新分支',exact:true}));
    await waitFor(runtime,s=>s.metadata.activeCodexBranchId===branchB && s.state.codexRuntime.threadId===branchB,'runtime switched to B');
    await click(page.getByRole('button',{name:'选择发送方式',exact:true}));
    await click(page.getByRole('menuitemradio',{name:'补充当前任务',exact:true}));
    await composer(page).fill('AUDIT_HOLD');
    await click(page.getByRole('button',{name:'Send message',exact:true}));
    await waitFor(runtime,s=>s.state?.codexRuntime?.turnId && observations.some((x:any)=>x.auditMarker==='AUDIT_HOLD'),'B active native turn');
    await click(page.getByRole('button',{name:'查看待发送队列',exact:true}));
    await click(page.getByRole('button',{name:'立即发送',exact:true}));
    await page.getByText(/这条排队消息属于其他分支/).first().waitFor();
    const refused = await runtime();
    assert(refused.state.codexInputs.items.some((r:any)=>r.id===queuedId));
    assert(!refused.state.codexInputs.receipts.some((r:any)=>r.id===queuedId && r.status==='steered'));
    assert(!observations.some((x:any)=>x.auditMarker==='AUDIT_QUEUED_BRANCH_A_EDITED'));
    log({type:'confirmed',name:'cross-branch-queue-injection-refused',queuedBranch:branchA,executingBranch:branchB});
    const stored=await (await fetch(api+'/v3/sessions/'+sessionId+'/messages?limit=100',{headers})).json();
    const records=(stored.messages??[]).filter((m:any)=>m.content?.t==='encrypted').map((m:any)=>decrypt(secret,'legacy',Buffer.from(m.content.c,'base64'))) as any[];
    const userRecords=records.filter((v:any)=>v?.role==='user');
    assert(userRecords.some((v:any)=>v.content?.text==='AUDIT_QUEUED_BRANCH_A'));
    assert(records.some((v:any)=>v.role==='session' && v.content?.ev?.text==='AUDIT_QUEUED_BRANCH_A_EDITED' && v.content?.ev?.inputEdit?.revision > 0));
    log({type:'confirmed',name:'edited-queue-has-durable-revision',storedQuestion:'AUDIT_QUEUED_BRANCH_A',executedQuestion:'AUDIT_QUEUED_BRANCH_A_EDITED'});
    await click(page.getByRole('button',{name:'收起队列',exact:true}));
    await waitFor(runtime,s=>s.state?.codexRuntime?.runtime==='idle','B complete');
    // Check the revised question through the independent full-history reader.
    const branchALabel=branches.metadata.codexBranches.find((x:any)=>x.id===branchA).label;
    await click(page.getByRole('button',{name:'切换到分支，'+branchALabel,exact:true}));
    await waitFor(runtime,s=>s.metadata.activeCodexBranchId===branchA,'return to edited question branch');
    const historyButton=page.getByRole('button',{name:'当前会话全部历史问题',exact:true});
    if(profile==='desktop') await historyButton.click();
    else { await click(page.getByRole('button',{name:'更多输入操作',exact:true})); await click(page.getByRole('menuitem',{name:'当前会话全部历史问题',exact:true})); }
    await page.getByRole('textbox',{name:'筛选已加载的历史问题',exact:true}).fill('AUDIT_QUEUED_BRANCH_A_EDITED');
    await click(page.getByRole('button',{name:/AUDIT_QUEUED_BRANCH_A_EDITED/}));
    assert.equal(await composer(page).inputValue(),'AUDIT_QUEUED_BRANCH_A_EDITED'); await composer(page).fill('');
    await click(page.getByRole('button',{name:'切换到分支，新分支',exact:true}));
    await waitFor(runtime,s=>s.metadata.activeCodexBranchId===branchB,'restore B after history check');
    log({type:'confirmed',name:'full-question-history-reuses-revised-input'});
    // The HTTP acknowledgement controls draft clearing; retry reuses its durable submission id.
    const submittedIds: string[] = [];
    await page.route('**/v3/sessions/*/messages', route => {
        if (route.request().method() !== 'POST') return route.continue();
        submittedIds.push(route.request().postDataJSON().messages[0].localId);
        return route.fulfill({status:503,body:'fixture unavailable'});
    });
    await composer(page).fill('AUDIT_UNACKNOWLEDGED_MESSAGE');
    await click(page.getByRole('button',{name:'Send message',exact:true}));
    await click(page.getByRole('button',{name:/^(OK|确定)$/,exact:true}));
    assert.equal(await composer(page).inputValue(),'AUDIT_UNACKNOWLEDGED_MESSAGE');
    await page.reload(); await composer(page).waitFor();
    assert.equal(await composer(page).inputValue(),'AUDIT_UNACKNOWLEDGED_MESSAGE');
    await page.unroute('**/v3/sessions/*/messages');
    page.on('request', request => { if (request.method()==='POST' && request.url().includes('/v3/sessions/') && request.url().endsWith('/messages')) submittedIds.push(request.postDataJSON().messages[0].localId); });
    await click(page.getByRole('button',{name:'Send message',exact:true}));
    await waitFor(()=>composer(page).inputValue(),value=>value==='','acknowledged retry clears draft');
    assert.equal(submittedIds.at(-1),submittedIds[0]);
    await waitFor(runtime,s=>s.state?.codexInputs?.receipts?.at(-1)?.status==='completed','retried message completion');
    log({type:'confirmed',name:'failed-post-preserves-draft-through-reload-and-retries-same-id'});
    await b.close();
    // Exercise the public manual command, then Web/daemon continuation on the resulting child.
    const oldId = sessionId; const old = await runtime();
    process.kill(old.metadata.hostPid, 'SIGTERM');
    await waitFor(async()=>{try{process.kill(old.metadata.hostPid,0);return false;}catch{return true;}},v=>v,'original process exited');
    const resumeLog = openSync(join(output,'manual-resume.log'),'a');
    const manual = spawn(process.execPath, ['/repo/packages/hapla-cli/dist/index.mjs','resume',oldId], {cwd:root,env:process.env,stdio:['ignore',resumeLog,resumeLog]});
    const manualRow = await waitFor(sessions, rows=>rows.some((r:any)=>{if(!r.metadata)return false;const m=decrypt(secret,'legacy',Buffer.from(r.metadata,'base64')) as any;return m.continuedFromSessionId===oldId && r.active;}),'manual resumed row');
    sessionId=manualRow.find((r:any)=>{if(!r.metadata)return false;const m=decrypt(secret,'legacy',Buffer.from(r.metadata,'base64')) as any;return m.continuedFromSessionId===oldId && r.active;}).id;
    const restored=await waitFor(runtime,s=>s.state?.codexRuntime?.runtime==='idle' && s.state?.codexInputs?.items?.some((i:any)=>i.id===queuedId),'manual state ready');
    assert.equal(restored.metadata.conversationRootSessionId,oldId);
    assert.equal(restored.metadata.activeCodexBranchId,branchB);
    assert.equal(restored.metadata.launchSpecId,old.metadata.launchSpecId);
    assert.equal(restored.metadata.executionConfiguration.values.effort,'medium');
    assert.equal(restored.state.codexInputs.items.find((i:any)=>i.id===queuedId).message,'AUDIT_QUEUED_BRANCH_A_EDITED');
    log({type:'confirmed',name:'manual-resume-retains-root-branches-queue-and-configuration'});
    await page.goto(origin+'/session/'+sessionId); await composer(page).waitFor();
    await send(page,'AUDIT_MANUAL_RESUME_SEND');
    const manualId=sessionId; const beforeDaemon=await runtime();
    let pendingAcrossRuntime=''; let retryAcrossRuntime='';
    await page.route('**/v3/sessions/*/messages',route=>{ if(route.request().method()!=='POST')return route.continue(); pendingAcrossRuntime=route.request().postDataJSON().messages[0].localId; return route.fulfill({status:503,body:'fixture unavailable'}); });
    await composer(page).fill('AUDIT_DAEMON_RESUME_SEND'); await click(page.getByRole('button',{name:'Send message',exact:true}));
    await click(page.getByRole('button',{name:/^(OK|确定)$/,exact:true}));
    await page.unroute('**/v3/sessions/*/messages');
    page.on('request',request=>{if(request.method()==='POST' && request.url().includes('/v3/sessions/') && request.url().endsWith('/messages')) retryAcrossRuntime=request.postDataJSON().messages[0].localId;});
    process.kill(beforeDaemon.metadata.hostPid,'SIGTERM');
    await waitFor(async()=>{try{process.kill(beforeDaemon.metadata.hostPid,0);return false;}catch{return true;}},v=>v,'manual process exited');
    await page.reload(); await composer(page).waitFor();
    await composer(page).fill('AUDIT_DAEMON_RESUME_SEND'); await click(page.getByRole('button',{name:'Send message',exact:true}));
    await page.waitForURL((url:URL)=>url.pathname.includes('/session/') && !url.pathname.endsWith(manualId));
    sessionId=new URL(page.url()).pathname.split('/').pop()!;
    assert.equal(retryAcrossRuntime,pendingAcrossRuntime,'runtime replacement preserves ambiguous submission identity');
    const daemonRestored=await waitFor(runtime,s=>s.state?.codexInputs?.receipts?.at(-1)?.status==='completed','daemon resumed and sent');
    assert.equal(daemonRestored.metadata.conversationRootSessionId,oldId);
    assert.equal(daemonRestored.metadata.activeCodexBranchId,branchB);
    assert.equal(daemonRestored.metadata.executionConfiguration.values.effort,'medium');
    assert(daemonRestored.state.codexInputs.items.some((i:any)=>i.id===queuedId));
    assert.equal(observations.findLast((v:any)=>v.auditMarker==='AUDIT_DAEMON_RESUME_SEND')?.reasoning?.effort,'medium');
    log({type:'confirmed',name:'daemon-continuation-retains-stable-root-and-native-settings'});
    if(profile!=='desktop') {
        assert(await page.evaluate(()=>(window as any).__stateTouches)>0,'real touch inputs recorded');
        const portrait=page.viewportSize(); await page.setViewportSize({width:844,height:390});
        await openSettings(page);
        const settingsPanel=page.getByLabel('会话设置面板',{exact:true});
        const panelBox=await settingsPanel.boundingBox(); assert(panelBox && panelBox.y>=64 && panelBox.y+panelBox.height<=390,'landscape settings remain entirely in the viewport');
        const effortControl=page.getByRole('combobox',{name:'思考深度',exact:true}); await effortControl.scrollIntoViewIfNeeded();
        const controlBox=await effortControl.boundingBox(); assert(controlBox && controlBox.y>=panelBox.y && controlBox.y+controlBox.height<=panelBox.y+panelBox.height,'effort control is visible inside the landscape panel');
        await effortControl.selectOption('medium');
        await page.screenshot({path:join(output,'landscape-settings.png'),scale:'css'}); await dismiss(page);
        await page.setViewportSize(portrait); await page.emulateMedia({colorScheme:'dark'}); await openSettings(page);
        await page.screenshot({path:join(output,'dark-settings.png'),scale:'css'}); await dismiss(page);
    }
    await page.screenshot({path:join(output,'completed.png'),scale:'css'});
    assert.equal(errors.length,0,errors.join('\n'));
    writeFileSync(join(output,'result.json'),JSON.stringify({passed:true,profile,engine:profile==='iphone'?'webkit':'chromium',scope:'two isolated browser contexts, same synthetic account; real pinned Codex with local Responses fixture',aEffective:aNative.reasoning.effort,bDisplayed:effort,bEffective:bNative.reasoning.effort,plan,verbosity,unacknowledgedMessageRetained:true,crossBranchQueueInjectionRefused:true,editedQueueRevisionDurable:true,manualAndDaemonResumeStable:true},null,2));
} catch(error) { writeFileSync(join(output,'failure-body.txt'),await page.locator('body').innerText()); await page.screenshot({path:join(output,'failure.png')}).catch(()=>{});throw error; }
finally {
    await context.close(); await browser.close(); daemon.kill('SIGTERM');
    // Stop only the synthetic account's native session child.
    if(sessionId) { const data=await runtime().catch(()=>null);if(typeof data?.metadata?.hostPid==='number') try{process.kill(data.metadata.hostPid,'SIGTERM')}catch{} }
    await provider.close();
}
