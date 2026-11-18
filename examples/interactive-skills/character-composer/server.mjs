import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { registerAppResource, registerAppTool, RESOURCE_MIME_TYPE } from '@modelcontextprotocol/ext-apps/server';
import { z } from 'zod';

const root = dirname(fileURLToPath(import.meta.url));
const html = await readFile(join(root, 'public', 'composer.html'), 'utf8');
const RESOURCE_URI = 'ui://hapla/character-composer/v1.html';

const server = new McpServer({ name: 'hapla-character-composer', version: '0.1.0' });

registerAppResource(server, 'character-composer', RESOURCE_URI, {}, async () => ({
  contents: [{
    uri: RESOURCE_URI,
    mimeType: RESOURCE_MIME_TYPE,
    text: html.replaceAll('__ASSET_BASE_URL__', process.env.CHARACTER_ASSET_BASE_URL ?? 'https://picsum.photos'),
    _meta: {
      ui: {
        prefersBorder: false,
        csp: {
          resourceDomains: ['https://picsum.photos', 'https://fastly.picsum.photos'],
          connectDomains: [],
          frameDomains: []
        }
      }
    }
  }]
}));

const selectionSchema = {
  face: z.number().int().min(0).max(39).default(0),
  faceShape: z.number().int().min(0).max(39).default(0),
  hair: z.number().int().min(0).max(39).default(0),
  outfit: z.number().int().min(0).max(39).default(0),
  body: z.number().int().min(0).max(39).default(0)
};

registerAppTool(server, 'render_character_composer', {
  title: '打开人物组合器',
  description: 'Opens an interactive visual composer with 40 options in each character category.',
  inputSchema: selectionSchema,
  _meta: { ui: { resourceUri: RESOURCE_URI } }
}, async (args) => ({
  content: [{ type: 'text', text: 'Opened the character composer with face, face shape, hair, outfit, and body selectors.' }],
  structuredContent: {
    counts: { face: 40, faceShape: 40, hair: 40, outfit: 40, body: 40 },
    selection: args
  }
}));

await server.connect(new StdioServerTransport());
