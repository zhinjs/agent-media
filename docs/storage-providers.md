# Object storage guide

[中文](./storage-providers.zh-CN.md)

agent-media uploads with the S3 protocol (AWS SigV4 signing), so any S3-compatible object store works. This page covers six common providers. Each one follows the same order:

1. Create a key that can **only access this bucket**
2. What to set for endpoint, region and addressing style
3. How images become readable (public URL or presigned URL)
4. A lifecycle rule that deletes expired objects
5. Gotchas

> Console menu names follow each provider's official documentation as of November 2026. Consoles get redesigned; the linked official pages are authoritative.

## Choose a URL mode first

| Mode | Settings | Good for | Requires |
|---|---|---|---|
| Public URL | `AGENT_MEDIA_S3_URL_MODE=public` (default) + `AGENT_MEDIA_S3_PUBLIC_BASE_URL` | Generated images sent to users or group chats | The bucket or a CDN allows anonymous reads |
| Presigned URL | `AGENT_MEDIA_S3_URL_MODE=presigned` + `AGENT_MEDIA_S3_URL_TTL` (seconds) | Buckets that must stay private; links only need to work for a while | Nothing; at most 604800 s (7 days), longer values are clamped |

When unsure, use presigned: nothing is opened to the public, and links expire on their own.

## Inference

When the endpoint matches a known format below, you can leave `AGENT_MEDIA_S3_REGION` and `AGENT_MEDIA_S3_VIRTUAL_HOSTED` unset; both are inferred. Explicit values win.

| Provider | Endpoint format | Inferred region | Inferred addressing |
|---|---|---|---|
| Cloudflare R2 | `https://<ACCOUNT_ID>.r2.cloudflarestorage.com` | `auto` | path-style |
| Aliyun OSS | `https://s3.oss-<region>.aliyuncs.com` | `<region>` (e.g. `cn-hangzhou`) | virtual-hosted |
| Tencent Cloud COS | `https://cos.<region>.myqcloud.com` | `<region>` (e.g. `ap-guangzhou`) | virtual-hosted |
| AWS S3 | `https://s3.<region>.amazonaws.com` | `<region>` (e.g. `us-east-1`) | virtual-hosted |
| Qiniu Kodo | `https://s3.<region>.qiniucs.com` | `<region>` (e.g. `cn-east-1`) | virtual-hosted |
| Anything else (MinIO, …) | Your server's URL | `us-east-1` | path-style |

## Cloudflare R2

Free tier, no egress fees, no ICP filing: the easiest option.

**Key**: R2 → API Tokens → Manage → create an Account or User API token with **Object Read & Write**, scoped to this bucket. The Access Key ID and Secret Access Key are shown once, right after creation.

**Endpoint**: `https://<ACCOUNT_ID>.r2.cloudflarestorage.com`, region `auto`.

**Public reads**:

- Production: bucket → Settings → Custom Domains, connect a domain that is a zone in the same Cloudflare account, and set it as `AGENT_MEDIA_S3_PUBLIC_BASE_URL`.
- Development: bucket → Settings → Public Development URL → Enable gives an `r2.dev` address. It is rate-limited; do not use it in production.
- Presigned URLs work only on the `r2.cloudflarestorage.com` S3 endpoint, not on custom domains. The presigned URLs agent-media returns already point at the S3 endpoint.

**Lifecycle**: bucket → Settings → Object lifecycle rules, delete objects under a prefix (e.g. `agent-media/`) after N days; or `wrangler r2 bucket lifecycle add`. Expired objects are usually removed within 24 hours.

```bash
AGENT_MEDIA_S3_ENDPOINT=https://<ACCOUNT_ID>.r2.cloudflarestorage.com
AGENT_MEDIA_S3_BUCKET=agent-media
AGENT_MEDIA_S3_ACCESS_KEY_ID=<Access Key ID>
AGENT_MEDIA_S3_SECRET_ACCESS_KEY=<Secret Access Key>
AGENT_MEDIA_S3_PUBLIC_BASE_URL=https://media.example.com
```

Official docs: [S3 API get started](https://developers.cloudflare.com/r2/get-started/s3/) · [Public buckets](https://developers.cloudflare.com/r2/buckets/public-buckets/) · [Presigned URLs](https://developers.cloudflare.com/r2/api/s3/presigned-urls/) · [Object lifecycles](https://developers.cloudflare.com/r2/buckets/object-lifecycles/)

## Aliyun OSS

**Key**: in Resource Access Management (RAM), create a RAM user with an AccessKey and attach a custom policy whose resources are only this bucket: `acs:oss:*:*:<bucket>` and `acs:oss:*:*:<bucket>/*`. A bucket policy (Permission control → Bucket Policy) works too. Never use the root account's AccessKey.

**Endpoint**: use the S3-compatible endpoint `https://s3.oss-<region>.aliyuncs.com` (e.g. `https://s3.oss-cn-hangzhou.aliyuncs.com`). The signing region is the region ID without the `oss-` prefix (e.g. `cn-hangzhou`). OSS **only accepts virtual-hosted addressing**. Both are inferred.

**Public reads**:

- New buckets have Block Public Access on, which keeps them private. For public reads, first turn it off under Permission control → Block Public Access, then set Permission control → ACL to public-read.
- **The default domain forces images to download** (`x-oss-force-download: true`), so browsers and chat apps cannot preview them. Previews need a custom domain.
- Custom domains for buckets in mainland China regions **require an ICP filing**; Hong Kong and overseas regions do not.
- Without public reads or a filed domain, use presigned mode. Note: we have not yet verified S3-protocol presigned URLs (`X-Amz-Expires`) against OSS; try one before going live.

**Lifecycle**: bucket → Data management → Lifecycle → create a rule matching a prefix (e.g. `agent-media/`, must not start with `/`) that deletes after N days, counted from last modification.

```bash
AGENT_MEDIA_S3_ENDPOINT=https://s3.oss-cn-hangzhou.aliyuncs.com
AGENT_MEDIA_S3_BUCKET=my-agent-media
AGENT_MEDIA_S3_ACCESS_KEY_ID=<RAM user AccessKey ID>
AGENT_MEDIA_S3_SECRET_ACCESS_KEY=<RAM user AccessKey Secret>
AGENT_MEDIA_S3_PUBLIC_BASE_URL=https://img.example.com   # filed custom domain bound to the bucket
```

Official docs: [Use AWS SDKs to access OSS](https://help.aliyun.com/zh/oss/developer-reference/use-aws-sdks-to-access-oss) · [Compatibility with Amazon S3](https://help.aliyun.com/zh/oss/developer-reference/compatibility-with-amazon-s3) · [RAM policy](https://help.aliyun.com/zh/oss/user-guide/ram-policy/) · [Block public access](https://help.aliyun.com/zh/oss/user-guide/block-public-access) · [Make objects previewable](https://help.aliyun.com/zh/oss/how-to-ensure-an-object-is-previewed-when-you-access-the-object) · [Lifecycle](https://help.aliyun.com/zh/oss/user-guide/lifecycle-rules-based-on-the-last-modified-time)

## Tencent Cloud COS

**Key**: in Cloud Access Management (CAM), create a sub-user to get a SecretId / SecretKey and attach a custom policy whose resource is only this bucket: `qcs::cos:<region>:uid/<APPID>:<bucket>-<APPID>/*`. The preset policies cover all COS resources; do not use them as-is.

**Endpoint**: `https://cos.<region>.myqcloud.com` (e.g. `https://cos.ap-guangzhou.myqcloud.com`); the region is the `ap-guangzhou`-style name, inferred automatically. **The bucket name is the full `<name>-<APPID>`**, e.g. `examplebucket-1250000000`. Buckets created on or after 2024-01-01 reject path-style, so virtual-hosted is required (the default).

**Public reads**:

- Bucket → Permission management → Bucket ACL → public-read, private-write.
- For buckets created on or after 2024-01-01, the default domain serves files as attachments, so **images do not preview**. For previews, add a custom origin domain under Domains and transfer → Custom origin domain (needs website ICP filing), or put Tencent Cloud CDN in front.

**Lifecycle**: bucket → Basic configuration → Lifecycle → add a rule limited to a prefix that deletes N days after last modification.

```bash
AGENT_MEDIA_S3_ENDPOINT=https://cos.ap-guangzhou.myqcloud.com
AGENT_MEDIA_S3_BUCKET=agent-media-1250000000
AGENT_MEDIA_S3_ACCESS_KEY_ID=<SecretId>
AGENT_MEDIA_S3_SECRET_ACCESS_KEY=<SecretKey>
AGENT_MEDIA_S3_PUBLIC_BASE_URL=https://img.example.com
```

Official docs: [Access COS with the AWS S3 SDK](https://cloud.tencent.com/document/product/436/37421) · [Default domain changes](https://cloud.tencent.com/document/product/436/102489) · [Grant a sub-user access to one bucket](https://cloud.tencent.com/document/product/436/68280) · [Access permissions](https://cloud.tencent.com/document/product/436/13312) · [Custom origin domain](https://cloud.tencent.com/document/product/436/36638) · [Lifecycle](https://cloud.tencent.com/document/product/436/17031)

## AWS S3

**Key**: create an IAM user with an access key and attach a policy limited to this bucket:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    { "Effect": "Allow", "Action": ["s3:PutObject", "s3:GetObject"], "Resource": "arn:aws:s3:::my-agent-media/*" }
  ]
}
```

**Endpoint**: `https://s3.<region>.amazonaws.com`; the region must be the bucket's actual region. Region and virtual-hosted are inferred. Avoid dots in the bucket name, or the virtual-hosted TLS certificate will not match.

**Public reads**:

- Turn off Block Public Access on the bucket (and on the account, if set there), then add a bucket policy: `Principal: "*"`, `s3:GetObject`, resource `arn:aws:s3:::<bucket>/*`.
- Better: keep the bucket private and put CloudFront in front, or simply use presigned mode.

**Lifecycle**: bucket → Management → Create lifecycle rule, filter by prefix, choose "Expire current versions of objects" with a number of days. On versioned buckets, expiry only adds delete markers.

```bash
AGENT_MEDIA_S3_ENDPOINT=https://s3.us-east-1.amazonaws.com
AGENT_MEDIA_S3_BUCKET=my-agent-media
AGENT_MEDIA_S3_ACCESS_KEY_ID=<Access key ID>
AGENT_MEDIA_S3_SECRET_ACCESS_KEY=<Secret access key>
AGENT_MEDIA_S3_URL_MODE=presigned
```

Official docs: [Virtual hosting](https://docs.aws.amazon.com/AmazonS3/latest/userguide/VirtualHosting.html) · [Bucket policy examples](https://docs.aws.amazon.com/AmazonS3/latest/userguide/example-policies-s3.html) · [Public access permissions](https://docs.aws.amazon.com/AmazonS3/latest/userguide/WebsiteAccessPermissionsReqd.html) · [Presigned URLs](https://docs.aws.amazon.com/AmazonS3/latest/userguide/using-presigned-url.html) · [Lifecycle](https://docs.aws.amazon.com/AmazonS3/latest/userguide/how-to-set-lifecycle-configuration-intro.html)

## MinIO (self-hosted)

For on-premises deployments where data must stay inside your network.

**Key**: Console → Access Keys → create, with a policy limited to this bucket; or `mc admin accesskey create`. An access key can never have more permissions than its parent user.

**Endpoint**: your MinIO server URL, which must be HTTPS. Path-style addressing by default, region `us-east-1` by default (a cluster-wide setting). Virtual-hosted needs `MINIO_DOMAIN`, wildcard DNS and a wildcard certificate on the server.

**Public reads**: `mc anonymous set download <alias>/<bucket>/agent-media`. Public URLs are `<endpoint>/<bucket>/<key>`, so set `AGENT_MEDIA_S3_PUBLIC_BASE_URL` to `<endpoint>/<bucket>`.

**Lifecycle**: `mc ilm rule add <alias>/<bucket> --prefix "agent-media/" --expire-days 7`.

```bash
AGENT_MEDIA_S3_ENDPOINT=https://minio.example.com
AGENT_MEDIA_S3_BUCKET=agent-media
AGENT_MEDIA_S3_ACCESS_KEY_ID=<access key>
AGENT_MEDIA_S3_SECRET_ACCESS_KEY=<secret key>
AGENT_MEDIA_S3_PUBLIC_BASE_URL=https://minio.example.com/agent-media
```

Official docs: [mc anonymous set](https://min.io/docs/minio/linux/reference/minio-mc/mc-anonymous-set.html) · [Lifecycle expiration rules](https://min.io/docs/minio/linux/administration/object-management/create-lifecycle-management-expiration-rule.html). Many recent MinIO pages document the commercial AIStor product; check them against your community edition.

## Qiniu Kodo

**Key**: Qiniu AccessKey / SecretKey; to restrict to one bucket, use an IAM sub-account with a bucket policy.

**Endpoint**: `https://s3.<region>.qiniucs.com` (e.g. East China–Zhejiang `https://s3.cn-east-1.qiniucs.com`); the region is the S3 region ID such as `cn-east-1`, inferred automatically.

**Public reads**: the S3 domains **do not allow anonymous reads**; every request must be signed. Public access needs a custom domain bound to the bucket (ICP filing in mainland China). The test domain is reclaimed after 30 days and is not for production. Without a domain, use presigned mode.

**Lifecycle**: set per-prefix lifecycle rules in the console, minimum 1 day. Rules **apply only to files uploaded after the rule is set**.

```bash
AGENT_MEDIA_S3_ENDPOINT=https://s3.cn-east-1.qiniucs.com
AGENT_MEDIA_S3_BUCKET=agent-media
AGENT_MEDIA_S3_ACCESS_KEY_ID=<AccessKey>
AGENT_MEDIA_S3_SECRET_ACCESS_KEY=<SecretKey>
AGENT_MEDIA_S3_URL_MODE=presigned
```

Official docs: [S3 domains](https://developer.qiniu.com/kodo/4088/s3-access-domainname) · [S3 signing](https://developer.qiniu.com/kodo/4093/s3-authentication) · [Bucket policy](https://developer.qiniu.com/kodo/6317/BucketPolicy) · [Domain management](https://developer.qiniu.com/kodo/8527/kodo-domain-name-management) · [Lifecycle](https://developer.qiniu.com/kodo/8540/set-the-life-cycle)

## Verify your setup

With the variables set, try one upload:

```bash
printf '{"img":"data:image/png;base64,%s"}' "$(base64 < test.png | tr -d '\n')" \
  | npx -y @zhin.js/agent-media capture --public
```

`img` in the output should be a URL. Open it in a browser: if the image shows, upload and reads both work; if it downloads instead, you are on a default domain that forces downloads — switch to a custom domain or presigned mode.

## Keeping keys safe

- Give the key read and write on one bucket only; never use a root or administrator key.
- Keep keys in your shell environment, an uncommitted `.env`, or a secret manager — not in a committed `.mcp.json` or `config.toml`.
- If a key leaks, disable and rotate it in the console right away.
