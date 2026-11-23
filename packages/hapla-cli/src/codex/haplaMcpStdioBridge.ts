/**
 * Hapla MCP STDIO Bridge
 *
 * Exposes the tools registered by the existing Hapla HTTP MCP server, including
 * title management and persistent development previews. Tool schemas and calls
 * pass through StreamableHTTPClientTransport so both transports stay in sync.
 *
 * Configure the target HTTP MCP URL via env var `HAPLA_HTTP_MCP_URL` or
 * via CLI flag `--url <http://127.0.0.1:PORT>`.
 *
 * Note: This process must not print to stdout as it would break MCP STDIO.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { CallToolRequestSchema, CallToolResultSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

function parseArgs(argv: string[]): { url: string | null } {
  let url: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--url' && i + 1 < argv.length) {
      url = argv[i + 1];
      i++;
    }
  }
  return { url };
}

export async function main() {
  // Resolve target HTTP MCP URL
  const { url: urlFromArgs } = parseArgs(process.argv.slice(2));
  const baseUrl = urlFromArgs || process.env.HAPLA_HTTP_MCP_URL || '';

  if (!baseUrl) {
    // Write to stderr; never stdout.
    process.stderr.write(
      '[hapla-mcp] Missing target URL. Set HAPLA_HTTP_MCP_URL or pass --url <http://127.0.0.1:PORT>\n'
    );
    process.exit(2);
  }

  let httpClient: Client | null = null;

  async function ensureHttpClient(): Promise<Client> {
    if (httpClient) return httpClient;
    const client = new Client(
      { name: 'hapla-stdio-bridge', version: '1.0.0' },
      { capabilities: {} }
    );

    const transport = new StreamableHTTPClientTransport(new URL(baseUrl));
    await client.connect(transport);
    httpClient = client;
    return client;
  }

  // Create STDIO MCP server
  const server = new Server({
    name: 'Hapla MCP Bridge',
    version: '1.0.0',
  }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async (request) => {
    const client = await ensureHttpClient();
    return await client.listTools(request.params);
  });
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
      try {
        const client = await ensureHttpClient();
        return await client.callTool({ ...request.params, arguments: request.params.arguments ?? {} }, CallToolResultSchema);
      } catch (error) {
        return {
          content: [
            { type: 'text', text: `Hapla tool ${request.params.name} failed: ${error instanceof Error ? error.message : String(error)}` },
          ],
          isError: true,
        };
      }
  });
  server.onclose = () => { void httpClient?.close(); };

  // Start STDIO transport
  const stdio = new StdioServerTransport();
  await server.connect(stdio);
}

// Start and surface fatal errors to stderr only
main().catch((err) => {
  try {
    process.stderr.write(`[hapla-mcp] Fatal: ${err instanceof Error ? err.message : String(err)}\n`);
  } finally {
    process.exit(1);
  }
});
