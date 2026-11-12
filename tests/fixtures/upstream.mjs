// A fake upstream MCP server whose tool returns a screenshot as base64, like many browser/image servers do.
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const png = Buffer.concat([
  Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'),
  Buffer.alloc(30_000, 7),
]).toString('base64');

const server = new Server({ name: 'upstream', version: '1.0.0' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [{ name: 'screenshot', description: 'Take a screenshot', inputSchema: { type: 'object', properties: {} } }],
}));
server.setRequestHandler(CallToolRequestSchema, async () => ({
  content: [
    { type: 'text', text: JSON.stringify({ ok: true, b64_json: png }) },
    { type: 'image', data: png, mimeType: 'image/png' },
  ],
}));
await server.connect(new StdioServerTransport());
