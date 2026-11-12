import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, readFile } from 'node:fs/promises';
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

  it('skill: copies SKILL.md into the target skills directory', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agent-media-skill-'));
    const run = spawnSync(process.execPath, [CLI, 'skill', join(dir, '.claude', 'skills')], { encoding: 'utf8' });
    expect(run.status).toBe(0);
    const copied = await readFile(join(dir, '.claude', 'skills', 'agent-media', 'SKILL.md'), 'utf8');
    expect(copied).toContain('name: agent-media');
  });
});

describe('npm package contents', () => {
  it('ships exactly one root README so npm renders the English one, plus the Chinese docs', () => {
    const out = execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: join(import.meta.dirname, '..'), encoding: 'utf8' });
    const files = (JSON.parse(out) as Array<{ files: Array<{ path: string }> }>)[0]!.files.map(f => f.path);
    expect(files.filter(path => /^readme/iu.test(path))).toEqual(['README.md']);
    for (const path of ['LICENSE', 'lib/cli.js', 'skills/agent-media/SKILL.md', 'docs/README.zh-CN.md', 'docs/storage-providers.md', 'docs/storage-providers.zh-CN.md']) {
      expect(files).toContain(path);
    }
  }, 60_000);
});

describe('core entry', () => {
  it('never imports the MCP SDK, directly or transitively', async () => {
    const { readFile } = await import('node:fs/promises');
    const { dirname, resolve } = await import('node:path');
    const seen = new Set<string>();
    const visit = async (file: string): Promise<void> => {
      if (seen.has(file)) return;
      seen.add(file);
      const source = await readFile(file, 'utf8');
      expect(source, file).not.toMatch(/(?:from\s+|import\s*\(\s*|import\s+)'@modelcontextprotocol\//u);
      for (const [, spec] of source.matchAll(/from\s+'(\.[^']+)'/gu)) await visit(resolve(dirname(file), spec!));
    };
    await visit(join(import.meta.dirname, '..', 'lib', 'core.js'));
    expect(seen.size).toBeGreaterThan(5);
  });

  it('is exported as @zhin.js/agent-media/core', async () => {
    const core = await import(join(import.meta.dirname, '..', 'lib', 'core.js')) as Record<string, unknown>;
    expect(Object.keys(core)).toEqual(expect.arrayContaining(['captureMedia', 'S3PublicStore', 'LocalMediaStore', 'InspectionQueue', 'sniffMime']));
  });
});
