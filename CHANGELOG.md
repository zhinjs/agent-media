# Changelog

## 0.2.0

- New `@zhin.js/agent-media/core` entry: storage, capture and inspection without the MCP server, CLI or hooks. It never loads `@modelcontextprotocol/sdk` at run time.
- `S3PublicStore.ownsUrl` is now exact. A public URL with a query string, fragment or extra path no longer counts as owned. A presigned URL must carry its signature query.

## 0.1.1

- The npm package now shows the English README; the Chinese README moved to `docs/README.zh-CN.md`, a full translation of the English one.
- New `docs/storage-providers.md` / `docs/storage-providers.zh-CN.md`: step-by-step setup for Cloudflare R2, Aliyun OSS, Tencent Cloud COS, AWS S3, MinIO and Qiniu Kodo.
- Region and virtual-hosted addressing are inferred from well-known endpoints (`inferS3Defaults`). Aliyun OSS and Tencent COS need virtual-hosted addressing and now get it without extra settings. `AGENT_MEDIA_S3_VIRTUAL_HOSTED=0` now explicitly turns it off.
- New `agent-media skill <skills-dir>` command installs the skill without a local `node_modules`.

## 0.1.0

- First release.
