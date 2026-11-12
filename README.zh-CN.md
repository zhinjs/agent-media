# agent-media

[English](./README.md)

让 base64 媒体远离 LLM 上下文。`agent-media` 工作在工具结果的边界上：工具返回 base64 形式的图片、音频或 PDF 时，字节先存起来，模型拿到的只是一个很短的引用：要么是可以按需查看的私有 `asset_id`，要么是 S3 / R2 / 阿里云 OSS 的公开 URL。

一张 1 MB 的截图编码后约 137 万个字符。它留在工具结果里，之后每一轮请求都会重复发送，截断会把 JSON 截坏，压缩也处理不了。而且模型本来就无法通过 base64 文本“看到”图片。

## 支持的 harness

| Harness | 用法 | 原因 |
|---|---|---|
| 任何 MCP 客户端（Claude Code、Codex、Gemini CLI、Cursor 等） | `agent-media proxy -- <上游 server>` | 包一层会产出媒体的 MCP server，结果在 harness 看到之前就被替换 |
| Claude Code | `agent-media hook claude-code`（PostToolUse） | Claude Code 的钩子可以用 `updatedToolOutput` 改写工具输出 |
| Codex CLI | proxy | Codex 的 PostToolUse 钩子只能阻断或补充上下文，不能改写输出（[openai/codex#38135](https://github.com/openai/codex/issues/38135)） |
| Gemini CLI | proxy | AfterTool 钩子不能返回结构化的替换结果 |
| 自己写的 agent loop | `captureMedia()` + `InspectionQueue` | 库 API，适用于任何 LLM SDK |

另附 `skills/agent-media/SKILL.md`，教模型遵守约定：不输出 base64，需要时才查看图片，用户要求时才公开发布。

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

可选：在 `.claude/settings.json` 里加上钩子，其他 MCP 工具以文本形式返回的 base64 也能被拦截。

```json
{
  "hooks": {
    "PostToolUse": [
      { "matcher": "mcp__.*", "hooks": [{ "type": "command", "command": "npx -y @zhin.js/agent-media hook claude-code" }] }
    ]
  }
}
```

钩子默认不动 MCP 图片块，因为 Claude Code 本来就把它们作为原生图片交给模型。如果这类图片块也要替换，加 `--capture-blocks`。

安装 Skill：

```bash
mkdir -p .claude/skills && cp -r node_modules/@zhin.js/agent-media/skills/agent-media .claude/skills/
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

把 `skills/agent-media` 复制到仓库的 `.agents/skills/` 下。

更多示例见 [`examples/`](./examples)（Claude Code、Codex、Gemini CLI、自定义 loop）。

## 命令

| 命令 | 作用 |
|---|---|
| `agent-media mcp` | 提供 `inspect_media(asset_id)` 的 MCP server；配置了 S3 时还提供 `publish_media(asset_id \| file_path)` |
| `agent-media proxy [--public] [--keep-blocks] -- <cmd> [args…]` | 转发上游 stdio MCP server 的工具，结果里的媒体会被替换，并附带上面两个工具。`--public` 把上游媒体直接发布到 S3（适合结果本来就要发给用户的生图类 server）；`--keep-blocks` 只替换以文本形式出现的 base64 |
| `agent-media hook claude-code [--capture-blocks]` | Claude Code PostToolUse 钩子；没有媒体时不输出任何内容 |
| `agent-media capture [--public] [--keep-blocks]` | 过滤器：从 stdin 读入 JSON，把媒体替换掉后输出到 stdout。给其他钩子系统和脚本用 |

## 配置

全部通过环境变量配置，各个 harness 的写法一致。变量列表见[英文 README](./README.md#configuration)。常用的几项：

- `AGENT_MEDIA_DIR`：私有存储目录，默认 `~/.cache/agent-media`。默认保留 7 天，总量 1 GiB、最多 1000 个文件，超出时先删最旧的。
- `AGENT_MEDIA_S3_*`：配置后启用公开存储，兼容 AWS S3、Cloudflare R2、阿里云 OSS（需要 `AGENT_MEDIA_S3_VIRTUAL_HOSTED=1`）、腾讯云 COS、MinIO。
- `AGENT_MEDIA_S3_URL_MODE=presigned`：返回带签名的临时 URL，桶可以保持私有。
- 密钥只放在 shell 环境或密钥管理里，不要写进会提交的配置文件。
- 给 `AGENT_MEDIA_S3_PREFIX` 配一条生命周期规则：本工具不会删除公开对象。

## 作为库使用

```ts
import { captureMedia, LocalMediaStore } from '@zhin.js/agent-media';

const privateStore = new LocalMediaStore({ dir: './.media' });
const raw = await tool.execute(args);
const { value } = await captureMedia(raw, { privateStore, scope: sessionId, source: tool.name });
history.push(toolResult(value)); // 写入历史的是 value，不是 raw
```

只识别结构明确的媒体形态：MCP / Anthropic 的内容块、Data URI、`b64_json` 这类已知字段，以及文本块里的 JSON。看起来像 base64 的任意字符串不会被动，因为它们可能是 token 或哈希。媒体类型按文件头魔数判断，不信任工具声明的 MIME。无效、无法识别、超大或存储失败的内容一律替换成 `[media omitted: 原因]`，失败时也不会把字节放进去。

## 安全

- 默认私有：只有显式选择 `--public` / `policy: 'public'`，或模型调用 `publish_media` 时才会公开。请保留 harness 对 MCP 工具调用的审批。
- 公开 URL 任何人拿到都能访问；桶需要保持私有时，用 `presigned` 模式。
- 多用户宿主：按会话和用户传入 scope，其他 scope 的 asset_id 一律读不到。
- `publish_media(file_path)` 只读工作目录内的普通文件，会先解析符号链接，打开时不跟随链接。
- 图片里的文字可能是提示词注入，`inspect_media` 会把图片标注为不可信数据。

## 许可

MIT
