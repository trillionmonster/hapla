import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {CodexAppServerClient} from '../../packages/hapla-cli/src/codex/codexAppServerClient';
import {startResponsesFixture} from './fixtures/responses.mts';
assert(existsSync('/.dockerenv'));assert.equal(process.env.HAPLA_ACCEPTANCE_STACK,'dev-hapla');
const output=process.env.HAPLA_ACCEPTANCE_OUTPUT ?? '/repo/artifacts/state-repair/native';mkdirSync(output,{recursive:true});
const observations:any[]=[];const provider=await startResponsesFixture(value=>observations.push(value));
mkdirSync(process.env.CODEX_HOME!,{recursive:true});
writeFileSync(join(process.env.CODEX_HOME!,'config.toml'),`model = "gpt-6-astra"\nmodel_provider = "hapla_fixture"\nmodel_reasoning_effort = "low"\n[model_providers.hapla_fixture]\nname = "Hapla audit fixture"\nbase_url = "${provider.url}"\nwire_api = "responses"\nrequires_openai_auth = false\n`);
const client=new CodexAppServerClient();const result:any={version:execFileSync('codex',['--version'],{encoding:'utf8'}).trim()};
try {
 await client.connect();const models=await client.listModels();
 assert(models.length>=2);const first=models[0].model;const second=models[1].model;
 await client.startThread({model:first,cwd:'/workspace',approvalPolicy:'never',sandbox:'read-only'});
 await client.sendTurnAndWait('AUDIT_NATIVE_BASE',{effort:'high'});
 try {const turns=await client.readThreadTurns();result.historyRead={supported:true,count:turns.length};}
 catch(error){result.historyRead={supported:false,error:error instanceof Error?error.message:String(error)};}
 await client.sendTurnAndWait('AUDIT_NATIVE_SELECT_MODEL',{model:second});
 const fork=await client.requestRaw<any>('thread/fork',{threadId:client.threadId,model:second,cwd:'/workspace',deferGoalContinuation:true,persistExtendedHistory:true});
 const resumed=await client.resumeThread({threadId:fork.thread.id,cwd:'/workspace'});
 result.branchModelRetention={savedBranchModel:fork.model,actualAfterSwitch:resumed.model,preserved:fork.model===resumed.model};
 await client.sendTurnAndWait('AUDIT_NATIVE_SELECT_MODEL_AGAIN',{model:second});
 await client.sendTurnAndWait('AUDIT_NATIVE_RESET_MODEL',{model:null,effort:null,collaborationMode:'default'});
 const reset=observations.findLast((x:any)=>x.auditMarker==='AUDIT_NATIVE_RESET_MODEL');
 assert.equal(reset?.model,'gpt-6-astra'); assert.equal(reset?.reasoning?.effort,'low');
 result.defaultModelReset={configured:'gpt-6-astra',selected:second,actualAfterReset:reset.model,effort:reset.reasoning.effort};
 assert.equal(resumed.model,fork.model);
 assert.equal(client.effectiveConfiguration.permissionMode,'read-only');
 writeFileSync(join(output,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
} finally{await client.disconnect();await provider.close();}
