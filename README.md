# agent-media

[中文](./docs/README.zh-CN.md)

Keep base64 media out of LLM context. `agent-media` sits at the tool-result boundary: when a tool returns an image, audio clip or PDF as base64, the bytes go to storage and the model gets a short reference instead — a private `asset_id` it can inspect on demand, or a public S3/R2/OSS URL.

One 1 MB screenshot is about 1.37 M base64 characters. Left in a tool result it is replayed on every later request, breaks truncation, and confuses compaction. The model cannot see an image through base64 text anyway.

```
tool result ──► captureMedia ──► history / model
  { type:"image", data:"iVBORw0…" }      [private image {"asset_id":"…"}; call inspect_media …]
  "data:image/png;base64,…"              agent-media:<asset_id>
  { b64_json:"…" }                       {"url":"https://media.example.com/…png"}   (public policy)
```

## Works with

| Harness | How | Why |
|---|---|---|
| Any MCP client (Claude Code, Codex, Gemini CLI, Cursor, …) | `agent-media proxy -- <upstream server>` | Wraps a media-producing MCP server; its results are captured before the harness sees them. |
| Claude Code | `agent-media hook claude-code` (PostToolUse) | Claude Code hooks can replace tool output with `updatedToolOutput`. |
| Codex CLI | proxy | Codex PostToolUse hooks can block or add context but cannot replace output ([openai/codex#38135](https://github.com/openai/codex/issues/38135)). |
| Gemini CLI | proxy | AfterTool hooks cannot return a structured replacement. |
| Your own agent loop | `captureMedia()` + `InspectionQueue` | Library API, any LLM SDK. |

Plus `skills/agent-media/SKILL.md`: a skill that teaches the model the conventions (never write base64, inspect only when needed, publish only when asked).

## Quick start

Requires Node.js ≥ 20.

### Claude Code

`.mcp.json` in your project (or `claude mcp add`):

```json
{
  "mcpServers": {
    "agent-media": { "type": "stdio", "command": "npx", "args": ["-y", "@zhin.js/agent-media", "mcp"] },
    "browser": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@zhin.js/agent-media", "proxy", "--", "npx", "-y", "@playwright/mcp@latest"]
    }
  }
}
```

Optionally also catch base64 that arrives as text from other MCP tools, in `.claude/settings.json`:

```json
{
  "hooks": {
    "PostToolUse": [
      { "matcher": "mcp__.*", "hooks": [{ "type": "command", "command": "npx -y @zhin.js/agent-media hook claude-code" }] }
    ]
  }
}
```

The hook leaves MCP image blocks alone by default, because Claude Code already shows those to the model as native images. Pass `--capture-blocks` to capture them too.

Install the skill:

```bash
npx -y @zhin.js/agent-media skill .claude/skills
```

### Codex CLI

`~/.codex/config.toml`:

```toml
[mcp_servers.agent-media]
command = "npx"
args = ["-y", "@zhin.js/agent-media", "mcp"]

[mcp_servers.browser]
command = "npx"
args = ["-y", "@zhin.js/agent-media", "proxy", "--", "npx", "-y", "@playwright/mcp@latest"]
```

Install the skill into your repository:

```bash
npx -y @zhin.js/agent-media skill .agents/skills
```

Codex hooks cannot rewrite tool output, so the proxy is the only way to capture media there.

More: [`examples/`](./examples) (Claude Code, Codex, Gemini CLI, custom loop).

## Commands

| Command | Does |
|---|---|
| `agent-media mcp` | MCP server with `inspect_media(asset_id)` and, when S3 is configured, `publish_media(asset_id \| file_path)`. |
| `agent-media proxy [--public] [--keep-blocks] -- <cmd> [args…]` | Re-exports an upstream stdio MCP server's tools with media captured, plus the two tools above. `--public` publishes upstream media to S3 instead of keeping it private (use for image generators whose output is meant for users). `--keep-blocks` captures only text-borne base64. |
| `agent-media hook claude-code [--capture-blocks]` | Claude Code PostToolUse hook. Prints nothing when there is no media. |
| `agent-media capture [--public] [--keep-blocks]` | Filter: JSON on stdin, JSON with media replaced on stdout. For other hook systems and scripts. |
| `agent-media skill <skills-dir>` | Copies the skill to `<skills-dir>/agent-media/SKILL.md`. |

## Configuration

All by environment variables, so every harness configures it the same way.

| Variable | Default | |
|---|---|---|
| `AGENT_MEDIA_DIR` | `~/.cache/agent-media` | Private store directory (files are `0600`). |
| `AGENT_MEDIA_RETENTION_DAYS` | `7` | Private assets expire after this. Also capped at 1 GiB / 1000 assets, oldest first. |
| `AGENT_MEDIA_MAX_MB` | `25` | Larger payloads are dropped, not stored. |
| `AGENT_MEDIA_SCOPE` | `default` | Private assets are readable only within the same scope. |
| `AGENT_MEDIA_S3_BUCKET` | — | Enables the public store. |
| `AGENT_MEDIA_S3_ENDPOINT` | — | e.g. `https://<account>.r2.cloudflarestorage.com`, `https://s3.oss-cn-hangzhou.aliyuncs.com`, `https://cos.ap-guangzhou.myqcloud.com`, `https://s3.us-east-1.amazonaws.com` |
| `AGENT_MEDIA_S3_REGION` | inferred | SigV4 signing region. Inferred for R2, Aliyun OSS, Tencent COS, AWS and Qiniu endpoints; otherwise `us-east-1`. |
| `AGENT_MEDIA_S3_ACCESS_KEY_ID`, `AGENT_MEDIA_S3_SECRET_ACCESS_KEY` | — | Keep these in your shell or secret manager, not in committed config. |
| `AGENT_MEDIA_S3_PREFIX` | `agent-media/` | Add a bucket lifecycle rule for it; this tool never deletes public objects. |
| `AGENT_MEDIA_S3_VIRTUAL_HOSTED` | inferred | `1`: `https://<bucket>.<host>/` addressing, `0`: `<endpoint>/<bucket>/`. Inferred as on for Aliyun OSS, Tencent COS, AWS and Qiniu; off for R2 and other endpoints. |
| `AGENT_MEDIA_S3_URL_MODE` | `public` | `public`: `PUBLIC_BASE_URL + key`. `presigned`: signed GET URL; the bucket stays private. |
| `AGENT_MEDIA_S3_PUBLIC_BASE_URL` | — | Required for `public` mode: the CDN / custom domain serving the bucket. |
| `AGENT_MEDIA_S3_URL_TTL` | `3600` | Seconds, for `presigned` mode. |

Without any `AGENT_MEDIA_S3_*` variable everything stays private and local; nothing is uploaded.

### Getting S3 credentials

Any S3-compatible service works. [docs/storage-providers.md](./docs/storage-providers.md) walks through Cloudflare R2, Aliyun OSS, Tencent Cloud COS, AWS S3, MinIO and Qiniu Kodo: where to create a bucket-scoped key, which endpoint and region to use, how to make objects readable, and the lifecycle rule that cleans up the prefix.

## Library

```ts
import { captureMedia, LocalMediaStore, S3PublicStore, InspectionQueue } from '@zhin.js/agent-media';

const privateStore = new LocalMediaStore({ dir: './.media' });

const raw = await tool.execute(args);
const { value, captured } = await captureMedia(raw, { privateStore, scope: sessionId, source: tool.name });
history.push(toolResult(value)); // never `raw`
```

Libraries and agent frameworks that only need storage and capture can import `@zhin.js/agent-media/core` instead. It exports the same `captureMedia`, `LocalMediaStore`, `S3PublicStore`, `InspectionQueue`, `inferS3Defaults`, `storesFromEnv` and `sniffMime`, and never loads the MCP SDK at run time. The package still installs the SDK, because the CLI needs it.

`captureMedia` recognises, and only these — arbitrary base64-looking strings are left alone, because they may be tokens or hashes:

- MCP `{type:"image"|"audio", data, mimeType}` and `{type:"resource", resource:{blob, mimeType}}`
- Anthropic `{type:"image"|"document", source:{type:"base64", data, media_type}}`
- `data:<mime>;base64,…` inside any string (OpenAI `image_url`, HTML, Markdown)
- values of `base64Keys` (default `b64_json`, `image_base64`, `base64_image`, `audio_base64`)
- JSON inside text blocks, and every copy of a captured payload elsewhere in the result

The media type comes from the file signature, never from the declared MIME (PNG, JPEG, GIF, WebP, MP3, WAV, OGG, MP4, WebM, PDF). Anything invalid, unrecognised, oversized or unstorable becomes `[media omitted: <reason>]`, so bytes never pass through on failure.

To let the model see a private image without storing it in history, use `InspectionQueue`: the `inspect_media` tool only queues the request, and your loop attaches the image to the next model request only. See [`examples/custom-loop`](./examples/custom-loop/agent-loop.ts).

## Security notes

- **Private by default.** Nothing becomes public unless you choose `--public` / `policy: 'public'` or the model calls `publish_media`. Harnesses ask for approval of MCP tools by default; keep it that way for `publish_media`.
- **Public means public.** Object names are random UUIDs, but anyone holding a URL can read it. Prefer `presigned` mode when the bucket must stay private.
- **Scopes.** In a multi-user host, pass a scope per conversation and user; asset IDs from another scope read as unavailable.
- **`publish_media(file_path)`** only reads regular files inside the working directory (symlinks resolved, no following on open).
- **Untrusted content.** `inspect_media` labels images as untrusted data; text inside an image can be a prompt injection.

## Development

```bash
pnpm install
pnpm type-check
pnpm test
```

## License

MIT
