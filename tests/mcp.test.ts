import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { createMediaServer } from '../src/mcp/server.js';
import { BIG_PNG, MemoryPublicStore, b64, tempStore } from './helpers.js';

async function connect(server: Server): Promise<Client> {
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(b);
  return client;
}

function fakeUpstream(): Server {
  const server = new Server({ name: 'up', version: '0' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: 'shot', inputSchema: { type: 'object' } }] }));
  server.setRequestHandler(CallToolRequestSchema, async () => ({ content: [{ type: 'image', data: b64(BIG_PNG), mimeType: 'image/png' }] }));
  return server;
}

describe('media MCP server', () => {
  it('proxies upstream tools, captures their media, and inspects on demand', async () => {
    const store = await tempStore();
    const upstream = await connect(fakeUpstream());
    const client = await connect(createMediaServer({ privateStore: store, upstream }));

    const names = (await client.listTools()).tools.map(t => t.name);
    expect(names).toEqual(['shot', 'inspect_media']);

    const result = await client.callTool({ name: 'shot', arguments: {} }) as { content: Array<{ type: string; text?: string }> };
    expect(result.content[0]!.type).toBe('text');
    expect(JSON.stringify(result).length).toBeLessThan(500);
    const assetId = /"asset_id":"([^"]+)"/u.exec(result.content[0]!.text!)![1]!;

    const inspected = await client.callTool({ name: 'inspect_media', arguments: { asset_id: assetId } }) as { content: Array<{ type: string; data?: string }> };
    expect(inspected.content[1]).toMatchObject({ type: 'image', mimeType: 'image/png' });
    expect(inspected.content[1]!.data).toBe(b64(BIG_PNG));

    const missing = await client.callTool({ name: 'inspect_media', arguments: { asset_id: 'nope' } });
    expect(missing.isError).toBe(true);
  });

  it('publishes private assets and workspace files only when a public store exists', async () => {
    const store = await tempStore();
    const pub = new MemoryPublicStore();
    const ref = await store.capture({ bytes: BIG_PNG, mime: 'image/png' }, 'default');
    const client = await connect(createMediaServer({ privateStore: store, publicStore: pub, allowedDirs: [process.cwd()] }));
    expect((await client.listTools()).tools.map(t => t.name)).toEqual(['inspect_media', 'publish_media']);

    const published = await client.callTool({ name: 'publish_media', arguments: { asset_id: ref.asset_id } }) as { content: Array<{ text: string }> };
    expect(JSON.parse(published.content[0]!.text).url).toBe('https://cdn.example.com/m/1.png');

    const outside = await client.callTool({ name: 'publish_media', arguments: { file_path: '/etc/hosts' } }) as { isError?: boolean; content: Array<{ text: string }> };
    expect(outside.isError).toBe(true);
    expect(outside.content[0]!.text).toContain('outside');

    const noPublic = await connect(createMediaServer({ privateStore: store }));
    expect((await noPublic.listTools()).tools.map(t => t.name)).toEqual(['inspect_media']);
  });
});
