import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { resolve } from 'node:path';
import { startHaplaServer } from '../claude/utils/startHaplaServer';
import type { ApiSessionClient } from '../api/apiSession';
import { listDevelopmentPreviews, registerDevelopmentPreview } from '../api/developmentPreviews';

vi.mock('../api/developmentPreviews', () => ({
  listDevelopmentPreviews: vi.fn(),
  registerDevelopmentPreview: vi.fn(),
}));

describe('Hapla MCP STDIO to HTTP tool bridge', () => {
  let client: Client;
  let upstream: Awaited<ReturnType<typeof startHaplaServer>>;
  const sendSummary = vi.fn();
  const handle = 'a'.repeat(32);

  beforeAll(async () => {
    upstream = await startHaplaServer({
      sessionId: 'bridge-test', authToken: 'dev-token',
      getMetadata: () => ({ machineId: 'dev-machine' }),
      sendClaudeSessionMessage: sendSummary,
    } as unknown as ApiSessionClient);
    client = new Client({ name: 'bridge-test', version: '1.0.0' });
    await client.connect(new StdioClientTransport({
      command: process.execPath,
      args: [resolve('dist/codex/haplaMcpStdioBridge.mjs'), '--url', upstream.url],
      stderr: 'pipe',
    }));
  });

  afterAll(async () => {
    await client?.close();
    upstream?.stop();
  });

  it('discovers the upstream preview tools and their target schema over STDIO', async () => {
    const { tools } = await client.listTools();
    expect(tools.map(tool => tool.name)).toEqual(expect.arrayContaining([
      'change_title', 'register_web_preview', 'list_web_previews',
    ]));
    const registration = tools.find(tool => tool.name === 'register_web_preview')!;
    expect(registration.inputSchema.required).toEqual(expect.arrayContaining(['target', 'name']));
    expect(registration.inputSchema.properties).toHaveProperty('handle');
  });

  it('forwards preview registration, stable URLs and errors to the HTTP owner context', async () => {
    const result = { handle, name: 'dev-app', target: 'http://127.0.0.1:5173/', url: `/preview/${handle}/`, access: 'current-account-only' };
    vi.mocked(registerDevelopmentPreview).mockResolvedValueOnce(result);
    const args = { name: result.name, target: result.target, handle };
    const reply = await client.callTool({ name: 'register_web_preview', arguments: args });
    expect(reply.isError).not.toBe(true);
    expect(reply.content).toEqual([{ type: 'text', text: JSON.stringify(result) }]);
    expect(registerDevelopmentPreview).toHaveBeenLastCalledWith({ token: 'dev-token', machineId: 'dev-machine' }, args);

    vi.mocked(listDevelopmentPreviews).mockResolvedValueOnce([]);
    expect((await client.callTool({ name: 'list_web_previews' })).content).toEqual([{ type: 'text', text: '[]' }]);
    expect(listDevelopmentPreviews).toHaveBeenLastCalledWith('dev-token');

    vi.mocked(registerDevelopmentPreview).mockRejectedValueOnce(new Error('工作台离线'));
    const failed = await client.callTool({ name: 'register_web_preview', arguments: args });
    expect(failed.isError).toBe(true);
    expect(failed.content).toEqual([{ type: 'text', text: '工作台离线' }]);
  });

  it('keeps title updates working and preserves upstream argument validation', async () => {
    const updated = await client.callTool({ name: 'change_title', arguments: { title: 'New title' } });
    expect(updated.isError).not.toBe(true);
    expect(sendSummary).toHaveBeenCalledWith(expect.objectContaining({ type: 'summary', summary: 'New title' }));
    const invalid = await client.callTool({ name: 'register_web_preview', arguments: { name: 'missing-target' } });
    expect(invalid.isError).toBe(true);
  });
});
