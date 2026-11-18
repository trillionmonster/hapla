import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const config = vi.hoisted(() => ({ haplaHomeDir: '/not-configured', serverUrl: 'http://example.test' }));
const selected = vi.hoisted(() => [] as string[]);
vi.mock('@/configuration', () => ({ configuration: config }));
vi.mock('./CloudFileManager', () => ({ CloudFileManager: class {
 constructor(root: string) { selected.push(root); } has() { return false; } downloadInfo(path: string) { return { success: true, path }; }
} }));
vi.mock('./workspaceVideoPreview', () => ({ WorkspaceVideoPreviewManager: class {} }));
import { registerCloudFileHandlers } from './registerCloudFileHandlers';
let root: string;
beforeEach(async () => { selected.length = 0; root = await mkdtemp(join(tmpdir(), 'hapla-roots-')); config.haplaHomeDir = root; });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
it('uses the registered session root even if the browser supplies a different directory', async () => {
 const handlers = new Map<string, Function>();
 registerCloudFileHandlers({ registerHandler: (m: string, h: Function) => handlers.set(m, h) } as any, root, 'token', () => '/registered/workspace');
 await handlers.get('file-download-info')!({ sessionId: 'tracked', workspaceRoot: '/etc', path: '/registered/workspace/a' });
 expect(selected).toEqual(['/registered/workspace']);
});
it('requires an operator-owned root for a historical workspace outside home', async () => {
 const handlers = new Map<string, Function>();
 registerCloudFileHandlers({ registerHandler: (m: string, h: Function) => handlers.set(m, h) } as any, root, 'token', () => undefined);
 const workspace = join(root, 'work'); await mkdir(workspace);
 await expect(handlers.get('file-download-info')!({ sessionId: 'historical', workspaceRoot: workspace, path: workspace + '/a' })).rejects.toThrow('已授权');
 await writeFile(join(root, 'file-roots.json'), JSON.stringify([workspace]));
 await handlers.get('file-download-info')!({ sessionId: 'historical', workspaceRoot: workspace, path: workspace + '/a' });
 expect(selected).toEqual([workspace]);
 await expect(handlers.get('file-download-info')!({ sessionId: 'historical', workspaceRoot: '/etc', path: '/etc/passwd' })).rejects.toThrow('已授权');
});
