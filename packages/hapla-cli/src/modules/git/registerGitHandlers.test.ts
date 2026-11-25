import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { encrypt, decrypt, encodeBase64, decodeBase64 } from '@/api/encryption';
import { registerGitHandlers } from './registerGitHandlers';
import { git } from './gitProcess';

let temporary: string;
afterEach(async () => { if (temporary) await rm(temporary, { recursive: true, force: true }); });
it('serves an adopted session outside the machine home while rejecting unrelated paths', async () => {
    temporary = await mkdtemp(join(tmpdir(), 'git-handler-'));
    const home = join(temporary, 'home'), project = join(temporary, 'project'), stranger = join(temporary, 'other');
    await Promise.all([mkdir(home), mkdir(project), mkdir(stranger)]);
    await git(project, ['init', '-b', 'main']); await writeFile(join(project, 'changed.txt'), 'owned workspace\n');
    const key = new Uint8Array(32).fill(7);
    const manager = new RpcHandlerManager({ scopePrefix: 'machine', encryptionKey: key, encryptionVariant: 'legacy' });
    registerGitHandlers(manager, home, undefined, id => id === 'owned-session' ? project : undefined);
    const call = async (request: object) => decrypt(key, 'legacy', decodeBase64(await manager.handleRequest({ method: 'machine:git-workbench', params: encodeBase64(encrypt(key, 'legacy', request)) }))) as any;
    const status = await call({ operation: 'status', sessionId: 'owned-session', directory: project });
    expect(status.branch).toBe('main'); expect(status.files.map((file: any) => file.path)).toContain('changed.txt');
    expect((await call({ operation: 'status', sessionId: 'unknown-session', directory: project })).error).toMatch(/outside/);
    expect((await call({ operation: 'status', sessionId: 'owned-session', directory: stranger })).error).toMatch(/outside/);
});
