# agent-media

[English](../README.md)

让 base64 媒体远离 LLM 上下文。`agent-media` 工作在工具结果的边界上：工具以 base64 返回图片、音频或 PDF 时，字节先进存储，模型拿到的只是一个很短的引用。引用有两种：可以按需查看的私有 `asset_id`，或者 S3 / R2 / OSS 上的公开 URL。

一张 1 MB 的截图编码后约 137 万个字符。它留在工具结果里，之后每一轮请求都会重复发送，截断会把它截坏，上下文压缩也处理不了。何况模型本来就无法通过 base64 文本“看到”图片。

```
工具结果 ──► captureMedia ──► 历史 / 模型
  { type:"image", data:"iVBORw0…" }      [private image {"asset_id":"…"}; call inspect_media …]
  "data:image/png;base64,…"              agent-media:<asset_id>
  { b64_json:"…" }                       {"url":"https://media.example.com/…png"}   （公开策略）
```

## 支持的 harness

| Harness | 用法 | 原因 |
|---|---|---|
| 任何 MCP 客户端（Claude Code、Codex、Gemini CLI、Cursor 等） | `agent-media proxy -- <上游 server>` | 包一层会产出媒体的 MCP server，结果在 harness 看到之前就被替换 |
| Claude Code | `agent-media hook claude-code`（PostToolUse） | Claude Code 的钩子可以用 `updatedToolOutput` 改写工具输出 |
| Codex CLI | proxy | Codex 的 PostToolUse 钩子只能阻断或补充上下文，不能改写输出（[openai/codex#38135](https://github.com/openai/codex/issues/38135)） |
| Gemini CLI | proxy | AfterTool 钩子不能返回结构化的替换结果 |
| 自己写的 agent loop | `captureMedia()` + `InspectionQueue` | 库 API，适用于任何 LLM SDK |

另附 `skills/agent-media/SKILL.md`：一个教模型遵守约定的 Skill（不输出 base64，需要时才查看图片，用户要求时才公开发布）。

## 快速开始

需要 Node.js ≥ 20。

### Claude Code

在项目的 `.mcp.json` 中添加（或用 `claude mcp add`）：

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

可选：在 `.claude/settings.json` 里加上钩子，其他 MCP 工具以文本形式返回的 base64 也会被拦截：

```json
{
  "hooks": {
    "PostToolUse": [
      { "matcher": "mcp__.*", "hooks": [{ "type": "command", "command": "npx -y @zhin.js/agent-media hook claude-code" }] }
    ]
  }
}
```

钩子默认不动 MCP 图片块，因为 Claude Code 本来就把它们作为原生图片交给模型。如果这类图片块也要捕获，加 `--capture-blocks`。

安装 Skill：

```bash
npx -y @zhin.js/agent-media skill .claude/skills
```

### Codex CLI

`~/.codex/config.toml`：

```toml
[mcp_servers.agent-media]
command = "npx"
args = ["-y", "@zhin.js/agent-media", "mcp"]

[mcp_servers.browser]
command = "npx"
args = ["-y", "@zhin.js/agent-media", "proxy", "--", "npx", "-y", "@playwright/mcp@latest"]
```

把 Skill 安装到仓库里：

```bash
npx -y @zhin.js/agent-media skill .agents/skills
```

Codex 的钩子不能改写工具输出，所以在 Codex 里只能用 proxy 捕获媒体。

更多示例见 [`examples/`](../examples)（Claude Code、Codex、Gemini CLI、自定义 loop）。

## 命令

| 命令 | 作用 |
|---|---|
| `agent-media mcp` | 提供 `inspect_media(asset_id)` 的 MCP server；配置了 S3 时还提供 `publish_media(asset_id \| file_path)` |
| `agent-media proxy [--public] [--keep-blocks] -- <cmd> [args…]` | 转发上游 stdio MCP server 的工具，结果里的媒体会被捕获，并附带上面两个工具。`--public` 把上游媒体发布到 S3，而不是存为私有（适合结果本来就要发给用户的生图类 server）；`--keep-blocks` 只捕获以文本形式出现的 base64 |
| `agent-media hook claude-code [--capture-blocks]` | Claude Code PostToolUse 钩子；没有媒体时不输出任何内容 |
| `agent-media capture [--public] [--keep-blocks]` | 过滤器：从 stdin 读入 JSON，把媒体替换掉后输出到 stdout。给其他钩子系统和脚本用 |
| `agent-media skill <skills-dir>` | 把 Skill 复制到 `<skills-dir>/agent-media/SKILL.md` |

## 配置

全部通过环境变量配置，各个 harness 的写法一致。

| 变量 | 默认值 | 说明 |
|---|---|---|
| `AGENT_MEDIA_DIR` | `~/.cache/agent-media` | 私有存储目录（文件权限 `0600`） |
| `AGENT_MEDIA_RETENTION_DAYS` | `7` | 私有资源到期天数。另有 1 GiB / 1000 个的上限，超出时先删最旧的 |
| `AGENT_MEDIA_MAX_MB` | `25` | 超过这个大小的内容直接丢弃，不存储 |
| `AGENT_MEDIA_SCOPE` | `default` | 私有资源只能在同一个 scope 内读取 |
| `AGENT_MEDIA_S3_BUCKET` | — | 设置后启用公开存储 |
| `AGENT_MEDIA_S3_ENDPOINT` | — | 例如 `https://<account>.r2.cloudflarestorage.com`、`https://s3.oss-cn-hangzhou.aliyuncs.com`、`https://cos.ap-guangzhou.myqcloud.com`、`https://s3.us-east-1.amazonaws.com` |
| `AGENT_MEDIA_S3_REGION` | 自动推断 | SigV4 签名地域。R2、阿里云 OSS、腾讯云 COS、AWS、七牛的 endpoint 会自动推断，其他情况为 `us-east-1` |
| `AGENT_MEDIA_S3_ACCESS_KEY_ID`、`AGENT_MEDIA_S3_SECRET_ACCESS_KEY` | — | 放在 shell 环境或密钥管理里，不要写进会提交的配置文件 |
| `AGENT_MEDIA_S3_PREFIX` | `agent-media/` | 给这个前缀配一条桶生命周期规则；本工具从不删除公开对象 |
| `AGENT_MEDIA_S3_VIRTUAL_HOSTED` | 自动推断 | `1`：使用 `https://<bucket>.<host>/` 寻址；`0`：使用 `<endpoint>/<bucket>/`。阿里云 OSS、腾讯云 COS、AWS、七牛推断为开启，R2 和其他 endpoint 推断为关闭 |
| `AGENT_MEDIA_S3_URL_MODE` | `public` | `public`：返回 `PUBLIC_BASE_URL + key`。`presigned`：返回带签名的 GET URL，桶可以保持私有 |
| `AGENT_MEDIA_S3_PUBLIC_BASE_URL` | — | `public` 模式必填：对外提供这个桶的 CDN 或自定义域名 |
| `AGENT_MEDIA_S3_URL_TTL` | `3600` | `presigned` 模式下签名 URL 的有效秒数 |

没有设置任何 `AGENT_MEDIA_S3_*` 变量时，所有内容都只存在本地私有存储，不会上传。

### 获取 S3 密钥

任何 S3 兼容服务都可以用。[storage-providers.zh-CN.md](./storage-providers.zh-CN.md) 逐个讲解 Cloudflare R2、阿里云 OSS、腾讯云 COS、AWS S3、MinIO 和七牛云 Kodo：在哪里创建只能访问一个桶的密钥，endpoint 和 region 填什么，怎样让对象可以被读取，以及如何配置清理这个前缀的生命周期规则。

## 作为库使用

```ts
import { captureMedia, LocalMediaStore, S3PublicStore, InspectionQueue } from '@zhin.js/agent-media';

const privateStore = new LocalMediaStore({ dir: './.media' });

const raw = await tool.execute(args);
const { value, captured } = await captureMedia(raw, { privateStore, scope: sessionId, source: tool.name });
history.push(toolResult(value)); // 写进历史的是 value，不是 raw
```

只需要存储和拦截能力的库或 agent 框架，可以改为导入 `@zhin.js/agent-media/core`。它导出同样的 `captureMedia`、`LocalMediaStore`、`S3PublicStore`、`InspectionQueue`、`inferS3Defaults`、`storesFromEnv` 和 `sniffMime`，运行时从不加载 MCP SDK。安装这个包时仍会装上 SDK，因为 CLI 需要它。

`captureMedia` 只识别下面这些形态。看起来像 base64 的任意字符串不会被动，因为它们可能是 token 或哈希：

- MCP 的 `{type:"image"|"audio", data, mimeType}` 和 `{type:"resource", resource:{blob, mimeType}}`
- Anthropic 的 `{type:"image"|"document", source:{type:"base64", data, media_type}}`
- 任意字符串里的 `data:<mime>;base64,…`（OpenAI 的 `image_url`、HTML、Markdown）
- `base64Keys` 指定字段的值（默认 `b64_json`、`image_base64`、`base64_image`、`audio_base64`）
- 文本块里的 JSON，以及已捕获内容在结果其他位置的每一份副本

媒体类型按文件头判断，从不信任声明的 MIME（支持 PNG、JPEG、GIF、WebP、MP3、WAV、OGG、MP4、WebM、PDF）。无效、无法识别、超大或存储失败的内容都会替换成 `[media omitted: <原因>]`，失败时也不会把字节放进去。

要让模型看到私有图片、又不把它写进历史，用 `InspectionQueue`：`inspect_media` 工具只登记请求，由你的 loop 把图片附加到下一次模型请求里。见 [`examples/custom-loop`](../examples/custom-loop/agent-loop.ts)。

## 安全说明

- **默认私有。** 只有选择 `--public` / `policy: 'public'`，或者模型调用 `publish_media` 时，内容才会公开。各 harness 默认会对 MCP 工具调用请求审批，请对 `publish_media` 保留审批。
- **公开就是公开。** 对象名是随机 UUID，但任何拿到 URL 的人都能读取。桶需要保持私有时，用 `presigned` 模式。
- **Scope。** 多用户宿主里，按会话和用户传入 scope；其他 scope 的 asset ID 一律读不到。
- **`publish_media(file_path)`** 只读取工作目录内的普通文件（先解析符号链接，打开时不跟随链接）。
- **不可信内容。** `inspect_media` 会把图片标注为不可信数据，图片里的文字可能是提示词注入。

## 开发

```bash
pnpm install
pnpm type-check
pnpm test
```

## 许可

MIT
