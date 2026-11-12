#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { captureMedia } from './capture.js';
import { storesFromEnv } from './config.js';
import { handleClaudeCodePostToolUse } from './hooks/claude-code.js';
import { createMediaServer, INSPECT_TOOL } from './mcp/server.js';

const VERSION = (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version;

const USAGE = `agent-media ${VERSION} — keep base64 media out of LLM context

Usage:
  agent-media mcp                                MCP server with inspect_media / publish_media
  agent-media proxy [--public] [--keep-blocks] -- <command> [args...]
                                                 Wrap an upstream stdio MCP server; capture media in its results
  agent-media hook claude-code [--capture-blocks]
                                                 Claude Code PostToolUse hook (stdin → stdout)
  agent-media capture [--public] [--keep-blocks] Filter: JSON on stdin → JSON with media replaced on stdout

Configure with AGENT_MEDIA_* environment variables (see README).`;

async function main(argv: string[]): Promise<void> {
  const [command, ...rest] = argv;
  const sep = rest.indexOf('--');
  const flags = new Set(sep === -1 ? rest : rest.slice(0, sep));
  const env = storesFromEnv();
  const policy = flags.has('--public') ? 'public' as const : 'private' as const;
  if (policy === 'public' && !env.publicStore) throw new Error('--public needs AGENT_MEDIA_S3_* configuration');
  const base = { privateStore: env.privateStore, publicStore: env.publicStore, scope: env.scope, maxBytes: env.maxBytes };

  switch (command) {
    case 'mcp': {
      const server = createMediaServer({ ...base, version: VERSION });
      await server.connect(new StdioServerTransport());
      return;
    }
    case 'proxy': {
      if (sep === -1 || !rest[sep + 1]) throw new Error('proxy needs an upstream command after --');
      const [upstreamCommand, ...upstreamArgs] = rest.slice(sep + 1);
      const client = new Client({ name: 'agent-media-proxy', version: VERSION });
      await client.connect(new StdioClientTransport({
        command: upstreamCommand!, args: upstreamArgs, stderr: 'inherit',
        env: Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => typeof e[1] === 'string')),
      }));
      const server = createMediaServer({ ...base, upstream: client, policy, keepBlocks: flags.has('--keep-blocks'), version: VERSION });
      client.setNotificationHandler(ToolListChangedNotificationSchema, () => server.sendToolListChanged());
      server.onclose = () => { void client.close(); };
      await server.connect(new StdioServerTransport());
      return;
    }
    case 'hook': {
      if (rest[0] !== 'claude-code') throw new Error('Supported hooks: claude-code');
      const payload = JSON.parse(await readStdin()) as Parameters<typeof handleClaudeCodePostToolUse>[0];
      const output = await handleClaudeCodePostToolUse(payload, {
        ...base, policy: 'private', inspectTool: `mcp__agent-media__${INSPECT_TOOL}`,
        // Claude Code already turns MCP image blocks into native images; by default only text-borne base64 is captured.
        keepBlocks: !flags.has('--capture-blocks'),
      });
      if (output !== undefined) process.stdout.write(`${JSON.stringify(output)}\n`);
      return;
    }
    case 'capture': {
      const input = JSON.parse(await readStdin()) as unknown;
      const result = await captureMedia(input, { ...base, policy, keepBlocks: flags.has('--keep-blocks') });
      process.stdout.write(`${JSON.stringify(result.value)}\n`);
      return;
    }
    case '--version': case '-v':
      process.stdout.write(`${VERSION}\n`);
      return;
    default:
      process.stdout.write(`${USAGE}\n`);
      if (command && command !== '--help' && command !== '-h') process.exitCode = 2;
  }
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

main(process.argv.slice(2)).catch((error: unknown) => {
  process.stderr.write(`agent-media: ${error instanceof Error ? error.message : String(error)}\n`);
  // A failing hook must not break the harness: exit 1 is a non-blocking error in Claude Code.
  process.exitCode = 1;
});
