import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { BIG_PNG, b64 } from './helpers.js';

const CLI = join(import.meta.dirname, '..', 'lib', 'cli.js');

beforeAll(() => { execFileSync('npx', ['tsc', '-p', 'tsconfig.build.json'], { cwd: join(import.meta.dirname, '..') }); }, 60_000);

describe('cli (built)', () => {
  it('proxy: an MCP client never sees the upstream base64', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agent-media-cli-'));
    const client = new Client({ name: 'harness', version: '0' });
    await client.connect(new StdioClientTransport({
      command: process.execPath,
      args: [CLI, 'proxy', '--', process.execPath, join(import.meta.dirname, 'fixtures', 'upstream.mjs')],
      env: { ...process.env as Record<string, string>, AGENT_MEDIA_DIR: dir },
      stderr: 'pipe',
    }));
    try {
      const result = await client.callTool({ name: 'screenshot', arguments: {} });
      const text = JSON.stringify(result);
      expect(text.length).toBeLessThan(1500);
      expect(text).toContain('asset_id');
      expect(text).toContain('agent-media:');
    } finally {
      await client.close();
    }
  });

  it('hook claude-code: rewrites text-borne base64 via updatedToolOutput, keeps image blocks', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agent-media-hook-'));
    const data = b64(BIG_PNG);
    const payload = {
      hook_event_name: 'PostToolUse', tool_name: 'mcp__img__generate',
      tool_response: [{ type: 'text', text: JSON.stringify({ b64_json: data }) }, { type: 'image', data, mimeType: 'image/png' }],
    };
    const run = spawnSync(process.execPath, [CLI, 'hook', 'claude-code'], { input: JSON.stringify(payload), env: { ...process.env, AGENT_MEDIA_DIR: dir }, encoding: 'utf8' });
    expect(run.status).toBe(0);
    const out = JSON.parse(run.stdout) as { hookSpecificOutput: { hookEventName: string; updatedToolOutput: Array<Record<string, string>> } };
    expect(out.hookSpecificOutput.hookEventName).toBe('PostToolUse');
    const [textBlock, imageBlock] = out.hookSpecificOutput.updatedToolOutput;
    expect(textBlock!.text).toContain('agent-media:');
    expect(textBlock!.text).not.toContain(data.slice(0, 200));
    expect(imageBlock!.data).toBe(data);
  });

  it('hook claude-code: prints nothing when there is no media', () => {
    const run = spawnSync(process.execPath, [CLI, 'hook', 'claude-code'], {
      input: JSON.stringify({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_response: { stdout: 'ok', stderr: '' } }), encoding: 'utf8',
    });
    expect(run.status).toBe(0);
    expect(run.stdout).toBe('');
  });

  it('capture: filters stdin JSON', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agent-media-cap-'));
    const run = spawnSync(process.execPath, [CLI, 'capture'], {
      input: JSON.stringify({ img: `data:image/png;base64,${b64(BIG_PNG)}` }), env: { ...process.env, AGENT_MEDIA_DIR: dir }, encoding: 'utf8',
    });
    expect(run.status).toBe(0);
    expect(JSON.parse(run.stdout).img).toMatch(/^agent-media:[0-9a-f-]{36}$/u);
  });
});
