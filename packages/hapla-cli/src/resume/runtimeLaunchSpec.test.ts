import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const home = vi.hoisted(() => ({ path: '' }));
vi.mock('@/configuration', async importOriginal => { const actual = await importOriginal<typeof import('@/configuration')>(); return { ...actual, configuration: { ...actual.configuration, get haplaHomeDir() { return home.path; } } }; });
import { saveRuntimeLaunchSpec, readRuntimeLaunchSpec, continuationEnvironment, prepareRuntimeLaunch } from './runtimeLaunchSpec';
import { buildResumeLaunch } from './handleResumeCommand';
afterEach(() => { vi.unstubAllEnvs(); if (home.path) rmSync(home.path, { recursive: true, force: true }); });
describe('private runtime continuation', () => {
    it('restores private arguments and environment with stable conversation and branch identity', () => {
        home.path = mkdtempSync(join(tmpdir(), 'hapla-launch-test-'));
        const id = saveRuntimeLaunchSpec({ agent: 'codex', args: ['--profile', 'team'], noSandbox: true, environment: { OPENAI_BASE_URL: 'http://fixture', CUSTOM_PROVIDER_KEY: 'synthetic-secret' } });
        expect(statSync(join(home.path, 'runtime-launches', id + '.json')).mode & 0o777).toBe(0o600);
        expect(readRuntimeLaunchSpec(id).args).toEqual(['--profile', 'team']);
        const session: any = { id: 'runtime-B', conversationId: 'conversation', metadata: { flavor: 'codex', path: '/work', launchSpecId: id, conversationRootSessionId: 'root-A', codexThreadId: 'thread-B', activeCodexBranchId: 'branch-B', codexBranches: [{ id: 'branch-B', threadId: 'thread-B' }], executionConfiguration: { revision: 3, values: { effort: 'high', permissionMode: 'read-only' } } } };
        const environment = continuationEnvironment(session);
        expect(environment).toMatchObject({ HAPLA_CONVERSATION_ID: 'conversation', HAPLA_CONVERSATION_ROOT_SESSION_ID: 'root-A', HAPLA_CONTINUED_FROM_SESSION_ID: 'runtime-B', OPENAI_BASE_URL: 'http://fixture', CUSTOM_PROVIDER_KEY: 'synthetic-secret' });
        expect(JSON.parse(environment.HAPLA_CODEX_BRANCH_STATE!)).toMatchObject({ activeCodexBranchId: 'branch-B' });
        expect(JSON.parse(environment.HAPLA_SESSION_CONFIGURATION!)).toEqual(session.metadata.executionConfiguration);
        const launch = buildResumeLaunch(session);
        expect(launch.args).toContain('--profile'); expect(launch.args).toContain('team'); expect(launch.args).toContain('--no-sandbox'); expect(launch.env).toEqual(environment);
    });
    it('fails clearly if the referenced private configuration was lost', () => {
        home.path = mkdtempSync(join(tmpdir(), 'hapla-launch-test-'));
        expect(() => continuationEnvironment({ id: 'runtime', metadata: { launchSpecId: '11111111-1111-1111-1111-111111111111' } as any })).toThrow('执行配置不可用');
    });
});

it('captures terminal-specific variables privately and strips old resume flags from future launches',()=>{
    home.path=mkdtempSync(join(tmpdir(),'hapla-launch-test-'));
    vi.stubEnv('HAPLA_LAUNCH_SPEC_ID',''); vi.stubEnv('HAPLA_CODEX_PATH','custom-codex'); vi.stubEnv('CUSTOM_PROVIDER_OPTION','synthetic');
    const id=prepareRuntimeLaunch('codex',['--profile','team','--resume','old-thread'],true);
    expect(readRuntimeLaunchSpec(id)).toMatchObject({args:['--profile','team'],noSandbox:true,environment:{HAPLA_CODEX_PATH:'custom-codex',CUSTOM_PROVIDER_OPTION:'synthetic'}});
});
