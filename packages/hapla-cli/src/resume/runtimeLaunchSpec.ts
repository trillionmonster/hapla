import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { configuration } from '@/configuration';
import type { Metadata } from '@/api/types';

type RuntimeLaunchSpec = { id: string; agent: 'codex' | 'claude'; args: string[]; noSandbox?: boolean; environment: Record<string, string> };
function specPath(id: string) {
    if (!/^[a-f0-9-]{36}$/i.test(id)) throw new Error('Invalid runtime launch reference');
    return join(configuration.haplaHomeDir, 'runtime-launches', id + '.json');
}
export function readRuntimeLaunchSpec(id: string): RuntimeLaunchSpec {
    try {
        const value = JSON.parse(readFileSync(specPath(id), 'utf8')) as RuntimeLaunchSpec;
        if (value.id !== id || !['codex', 'claude'].includes(value.agent) || !Array.isArray(value.args) || value.args.some(arg => typeof arg !== 'string') || !value.environment || Object.values(value.environment).some(value => typeof value !== 'string')) throw new Error();
        return value;
    } catch { throw new Error('原会话的执行配置不可用，无法安全恢复；请保留执行器状态目录'); }
}
export function saveRuntimeLaunchSpec(input: Omit<RuntimeLaunchSpec, 'id'> & { id?: string }): string {
    const id = input.id ?? randomUUID(); const path = specPath(id);
    mkdirSync(join(configuration.haplaHomeDir, 'runtime-launches'), { recursive: true, mode: 0o700 });
    const temporary = path + '.' + randomUUID() + '.tmp';
    writeFileSync(temporary, JSON.stringify({ ...input, id }), { mode: 0o600 }); renameSync(temporary, path);
    return id;
}
export function prepareRuntimeLaunch(agent: 'codex' | 'claude', args: string[], noSandbox?: boolean): string {
    const id = process.env.HAPLA_LAUNCH_SPEC_ID || undefined;
    const previous = id ? readRuntimeLaunchSpec(id) : undefined;
    const environment = { ...Object.fromEntries(Object.entries(process.env).filter(([key, value]) => value !== undefined && (key === 'HAPLA_CODEX_PATH' || !/^(HAPLA_|PWD$|OLDPWD$|SHLVL$|_$)/.test(key)))), ...previous?.environment } as Record<string, string>;
    const saved = saveRuntimeLaunchSpec({ id, agent, args: stripResumeArgs(args), noSandbox, environment });
    process.env.HAPLA_LAUNCH_SPEC_ID = saved;
    return saved;
}
function stripResumeArgs(args: string[]): string[] {
    const result: string[] = [];
    for (let index = 0; index < args.length; index++) {
        if (args[index] === '--resume' || args[index] === '-r') { index++; continue; }
        if (args[index].startsWith('--resume=')) continue;
        result.push(args[index]);
    }
    return result;
}
export function continuationEnvironment(session: { id: string; conversationId?: string; metadata: Metadata }): NodeJS.ProcessEnv {
    const metadata = session.metadata;
    const spec = metadata.launchSpecId ? readRuntimeLaunchSpec(metadata.launchSpecId) : undefined;
    return {
        ...spec?.environment,
        HAPLA_LAUNCH_SPEC_ID: metadata.launchSpecId ?? '',
        HAPLA_CONVERSATION_ID: session.conversationId ?? session.id,
        HAPLA_CONTINUED_FROM_SESSION_ID: session.id,
        HAPLA_CONVERSATION_ROOT_SESSION_ID: metadata.conversationRootSessionId ?? session.id,
        HAPLA_RESUME_CODEX_THREAD_ID: metadata.codexThreadId ?? '',
        HAPLA_CODEX_BRANCH_STATE: JSON.stringify({ codexBranches: metadata.codexBranches, activeCodexBranchId: metadata.activeCodexBranchId }),
        HAPLA_SESSION_CONFIGURATION: JSON.stringify(metadata.executionConfiguration ?? null),
    };
}
