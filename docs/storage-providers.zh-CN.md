# 对象存储配置指南

[English](./storage-providers.md)

agent-media 用 S3 协议（AWS SigV4 签名）上传，任何兼容 S3 的对象存储都能用。本页给出六个常见平台的配置方法。每个平台都按同样的顺序讲：

1. 创建一个**只能访问这个桶**的密钥
2. endpoint、region、寻址方式怎么填
3. 怎样让图片可以被读取（公开 URL 或预签名 URL）
4. 配一条生命周期规则，自动清理过期对象
5. 需要注意的坑

> 控制台菜单名称以 2026 年 11 月各平台官方文档为准，界面改版后可能略有不同，以文中链接的官方文档为准。

## 先选 URL 模式

| 模式 | 设置 | 适合 | 前提 |
|---|---|---|---|
| 公开 URL | `AGENT_MEDIA_S3_URL_MODE=public`（默认）+ `AGENT_MEDIA_S3_PUBLIC_BASE_URL` | 生成的图片要发给用户、发到群里 | 桶或 CDN 允许匿名读取 |
| 预签名 URL | `AGENT_MEDIA_S3_URL_MODE=presigned` + `AGENT_MEDIA_S3_URL_TTL`（秒） | 桶必须保持私有；链接只需短期有效 | 无；有效期最长 604800 秒（7 天），超出会被截断 |

不确定时选预签名：不用开放公共读，链接过期后自动失效。

## 自动推断

endpoint 是下表中的已知格式时，`AGENT_MEDIA_S3_REGION` 和 `AGENT_MEDIA_S3_VIRTUAL_HOSTED` 都可以不填，工具会自动推断。显式设置的值优先。

| 平台 | endpoint 格式 | 推断的 region | 推断的寻址方式 |
|---|---|---|---|
| Cloudflare R2 | `https://<ACCOUNT_ID>.r2.cloudflarestorage.com` | `auto` | path-style |
| 阿里云 OSS | `https://s3.oss-<region>.aliyuncs.com` | `<region>`（如 `cn-hangzhou`） | virtual-hosted |
| 腾讯云 COS | `https://cos.<region>.myqcloud.com` | `<region>`（如 `ap-guangzhou`） | virtual-hosted |
| AWS S3 | `https://s3.<region>.amazonaws.com` | `<region>`（如 `us-east-1`） | virtual-hosted |
| 七牛云 Kodo | `https://s3.<region>.qiniucs.com` | `<region>`（如 `cn-east-1`） | virtual-hosted |
| 其他（MinIO 等） | 你的服务地址 | `us-east-1` | path-style |

## Cloudflare R2

有免费额度，出口流量不收费，没有 ICP 备案要求，最省事。

**密钥**：R2 → API Tokens → Manage → 创建 Account 或 User API Token，权限选 **Object Read & Write**，范围限定到这个桶。创建后页面会显示 Access Key ID 和 Secret Access Key，只显示一次。

**endpoint**：`https://<ACCOUNT_ID>.r2.cloudflarestorage.com`，region 为 `auto`。

**公开读取**：

- 正式使用：桶 → Settings → Custom Domains，绑定一个托管在同一个 Cloudflare 账号下的域名，把它填进 `AGENT_MEDIA_S3_PUBLIC_BASE_URL`。
- 开发测试：桶 → Settings → Public Development URL → Enable，会得到一个 `r2.dev` 地址。它有限流，不要用于正式环境。
- 预签名 URL 只能用在 `r2.cloudflarestorage.com` 这个 S3 endpoint 上，不能用在自定义域名上。agent-media 生成的预签名 URL 本来就指向 S3 endpoint。

**生命周期**：桶 → Settings → Object lifecycle rules，按前缀（如 `agent-media/`）设置 N 天后删除；也可以用 `wrangler r2 bucket lifecycle add`。到期对象一般在 24 小时内删除。

```bash
AGENT_MEDIA_S3_ENDPOINT=https://<ACCOUNT_ID>.r2.cloudflarestorage.com
AGENT_MEDIA_S3_BUCKET=agent-media
AGENT_MEDIA_S3_ACCESS_KEY_ID=<Access Key ID>
AGENT_MEDIA_S3_SECRET_ACCESS_KEY=<Secret Access Key>
AGENT_MEDIA_S3_PUBLIC_BASE_URL=https://media.example.com
```

官方文档：[S3 API 入门](https://developers.cloudflare.com/r2/get-started/s3/) · [公开桶](https://developers.cloudflare.com/r2/buckets/public-buckets/) · [预签名 URL](https://developers.cloudflare.com/r2/api/s3/presigned-urls/) · [生命周期](https://developers.cloudflare.com/r2/buckets/object-lifecycles/)

## 阿里云 OSS

**密钥**：在访问控制（RAM）里创建一个 RAM 用户并生成 AccessKey，再给它一条自定义权限策略，资源只写这个桶：`acs:oss:*:*:<bucket>` 和 `acs:oss:*:*:<bucket>/*`。也可以在桶的 权限控制 → Bucket 授权策略 里授权。不要使用主账号 AccessKey。

**endpoint**：用 S3 兼容 endpoint `https://s3.oss-<region>.aliyuncs.com`（如 `https://s3.oss-cn-hangzhou.aliyuncs.com`）。签名 region 是去掉 `oss-` 前缀的地域 ID（如 `cn-hangzhou`）。OSS **只支持 virtual-hosted 寻址**，这两项都会自动推断。

**公开读取**：

- 新建的桶默认开启“阻止公共访问”，此时只能是私有。需要公共读时，先在 权限控制 → 阻止公共访问 中关闭，再把 权限控制 → 读写权限 改为“公共读”。
- **默认域名会强制下载图片**（返回 `x-oss-force-download: true`），在浏览器和聊天软件里无法直接预览。要预览，必须绑定自定义域名。
- 中国内地地域的桶绑定自定义域名**需要 ICP 备案**；香港和海外地域不需要。
- 不想开公共读、也没有备案域名时，用预签名模式。注意：通过 S3 协议（`X-Amz-Expires`）生成的预签名 URL 我们还没有在 OSS 上验证过，上线前请先试一次。

**生命周期**：桶 → 数据管理 → 生命周期 → 创建规则，按前缀匹配（如 `agent-media/`，不能以 `/` 开头），指定天数后删除。天数从最后修改时间算起。

```bash
AGENT_MEDIA_S3_ENDPOINT=https://s3.oss-cn-hangzhou.aliyuncs.com
AGENT_MEDIA_S3_BUCKET=my-agent-media
AGENT_MEDIA_S3_ACCESS_KEY_ID=<RAM 用户 AccessKey ID>
AGENT_MEDIA_S3_SECRET_ACCESS_KEY=<RAM 用户 AccessKey Secret>
AGENT_MEDIA_S3_PUBLIC_BASE_URL=https://img.example.com   # 已备案并绑定到桶的自定义域名
```

官方文档：[使用 AWS SDK 访问 OSS](https://help.aliyun.com/zh/oss/developer-reference/use-aws-sdks-to-access-oss) · [与 S3 的兼容性](https://help.aliyun.com/zh/oss/developer-reference/compatibility-with-amazon-s3) · [RAM 策略](https://help.aliyun.com/zh/oss/user-guide/ram-policy/) · [阻止公共访问](https://help.aliyun.com/zh/oss/user-guide/block-public-access) · [确保文件可以预览](https://help.aliyun.com/zh/oss/how-to-ensure-an-object-is-previewed-when-you-access-the-object) · [生命周期](https://help.aliyun.com/zh/oss/user-guide/lifecycle-rules-based-on-the-last-modified-time)

## 腾讯云 COS

**密钥**：在访问管理（CAM）里创建子用户，获取 SecretId / SecretKey，再绑定一条自定义策略，资源只写这个桶：`qcs::cos:<region>:uid/<APPID>:<bucket>-<APPID>/*`。预设策略覆盖全部 COS 资源，不要直接使用。

**endpoint**：`https://cos.<region>.myqcloud.com`（如 `https://cos.ap-guangzhou.myqcloud.com`），region 就是 `ap-guangzhou` 这种地域名，会自动推断。**桶名要写完整的 `<名称>-<APPID>`**，如 `examplebucket-1250000000`。2024 年 1 月 1 日之后创建的桶不支持 path-style，必须用 virtual-hosted（默认就是）。

**公开读取**：

- 桶 → 权限管理 → 存储桶访问权限 → “公有读私有写”。
- 2024 年 1 月 1 日之后创建的桶，默认域名会以附件形式返回文件，**图片无法预览**。需要预览时，在 域名与传输管理 → 自定义源站域名 里绑定自定义域名（需要网站备案），或接入腾讯云 CDN。

**生命周期**：桶 → 基础配置 → 生命周期 → 添加规则，“指定范围”填前缀，设置最后修改时间之后 N 天删除。

```bash
AGENT_MEDIA_S3_ENDPOINT=https://cos.ap-guangzhou.myqcloud.com
AGENT_MEDIA_S3_BUCKET=agent-media-1250000000
AGENT_MEDIA_S3_ACCESS_KEY_ID=<SecretId>
AGENT_MEDIA_S3_SECRET_ACCESS_KEY=<SecretKey>
AGENT_MEDIA_S3_PUBLIC_BASE_URL=https://img.example.com
```

官方文档：[使用 AWS S3 SDK 访问 COS](https://cloud.tencent.com/document/product/436/37421) · [默认域名变更说明](https://cloud.tencent.com/document/product/436/102489) · [授权子用户访问指定桶](https://cloud.tencent.com/document/product/436/68280) · [设置访问权限](https://cloud.tencent.com/document/product/436/13312) · [自定义源站域名](https://cloud.tencent.com/document/product/436/36638) · [生命周期](https://cloud.tencent.com/document/product/436/17031)

## AWS S3

**密钥**：在 IAM 创建一个用户并生成访问密钥，附加只允许这个桶的策略：

```json
{
  "Version": "2012-10-17",
  "Statement": [
    { "Effect": "Allow", "Action": ["s3:PutObject", "s3:GetObject"], "Resource": "arn:aws:s3:::my-agent-media/*" }
  ]
}
```

**endpoint**：`https://s3.<region>.amazonaws.com`，region 必须是桶的实际地域。region 和 virtual-hosted 都会自动推断。桶名不要带点号，否则 virtual-hosted 的 TLS 证书不匹配。

**公开读取**：

- 关闭桶的 Block Public Access（账号级别也开着的话一并关闭），再加一条桶策略：`Principal: "*"`，`s3:GetObject`，资源 `arn:aws:s3:::<bucket>/*`。
- 更推荐的做法是保持桶私有，在前面放 CloudFront，或者直接用预签名模式。

**生命周期**：桶 → Management → Create lifecycle rule，按前缀过滤，选 “Expire current versions of objects”，设置天数。桶开启了版本控制时，过期只会生成删除标记。

```bash
AGENT_MEDIA_S3_ENDPOINT=https://s3.us-east-1.amazonaws.com
AGENT_MEDIA_S3_BUCKET=my-agent-media
AGENT_MEDIA_S3_ACCESS_KEY_ID=<Access key ID>
AGENT_MEDIA_S3_SECRET_ACCESS_KEY=<Secret access key>
AGENT_MEDIA_S3_URL_MODE=presigned
```

官方文档：[虚拟主机寻址](https://docs.aws.amazon.com/AmazonS3/latest/userguide/VirtualHosting.html) · [桶策略示例](https://docs.aws.amazon.com/AmazonS3/latest/userguide/example-policies-s3.html) · [公开访问权限](https://docs.aws.amazon.com/AmazonS3/latest/userguide/WebsiteAccessPermissionsReqd.html) · [预签名 URL](https://docs.aws.amazon.com/AmazonS3/latest/userguide/using-presigned-url.html) · [生命周期](https://docs.aws.amazon.com/AmazonS3/latest/userguide/how-to-set-lifecycle-configuration-intro.html)

## MinIO（自建）

适合内网部署，数据不出机房。

**密钥**：Console → Access Keys → 创建，附加一条只允许这个桶的策略；或者用 `mc admin accesskey create`。Access Key 的权限不能超过它所属用户的权限。

**endpoint**：你的 MinIO 服务地址，必须是 HTTPS。默认使用 path-style 寻址，region 默认 `us-east-1`（集群统一配置）。要用 virtual-hosted，服务端需要配置 `MINIO_DOMAIN`、泛域名解析和泛域名证书。

**公开读取**：`mc anonymous set download <alias>/<bucket>/agent-media`，公开 URL 是 `<endpoint>/<bucket>/<key>`，所以 `AGENT_MEDIA_S3_PUBLIC_BASE_URL` 填 `<endpoint>/<bucket>`。

**生命周期**：`mc ilm rule add <alias>/<bucket> --prefix "agent-media/" --expire-days 7`。

```bash
AGENT_MEDIA_S3_ENDPOINT=https://minio.example.com
AGENT_MEDIA_S3_BUCKET=agent-media
AGENT_MEDIA_S3_ACCESS_KEY_ID=<access key>
AGENT_MEDIA_S3_SECRET_ACCESS_KEY=<secret key>
AGENT_MEDIA_S3_PUBLIC_BASE_URL=https://minio.example.com/agent-media
```

官方文档：[mc anonymous set](https://min.io/docs/minio/linux/reference/minio-mc/mc-anonymous-set.html) · [生命周期过期规则](https://min.io/docs/minio/linux/administration/object-management/create-lifecycle-management-expiration-rule.html)。注意 MinIO 近期不少文档是商业版 AIStor 的，社区版以实际版本为准。

## 七牛云 Kodo

**密钥**：七牛的 AccessKey / SecretKey；要限制到单个桶，用 IAM 子账号配合 Bucket Policy。

**endpoint**：`https://s3.<region>.qiniucs.com`（如华东-浙江 `https://s3.cn-east-1.qiniucs.com`），region 为 `cn-east-1` 这种 S3 地域 ID，会自动推断。

**公开读取**：S3 域名**不允许匿名读取**，每个请求都要签名。要公开访问，需要给桶绑定自定义域名（中国内地需要备案）。测试域名 30 天后回收，不能用于生产。没有域名时用预签名模式。

**生命周期**：控制台按前缀设置生命周期，最少 1 天。规则**只对设置之后上传的文件生效**。

```bash
AGENT_MEDIA_S3_ENDPOINT=https://s3.cn-east-1.qiniucs.com
AGENT_MEDIA_S3_BUCKET=agent-media
AGENT_MEDIA_S3_ACCESS_KEY_ID=<AccessKey>
AGENT_MEDIA_S3_SECRET_ACCESS_KEY=<SecretKey>
AGENT_MEDIA_S3_URL_MODE=presigned
```

官方文档：[S3 兼容域名](https://developer.qiniu.com/kodo/4088/s3-access-domainname) · [S3 签名](https://developer.qiniu.com/kodo/4093/s3-authentication) · [Bucket Policy](https://developer.qiniu.com/kodo/6317/BucketPolicy) · [域名管理](https://developer.qiniu.com/kodo/8527/kodo-domain-name-management) · [生命周期](https://developer.qiniu.com/kodo/8540/set-the-life-cycle)

## 验证配置

配置好环境变量后，用一张图片试一次上传：

```bash
printf '{"img":"data:image/png;base64,%s"}' "$(base64 < test.png | tr -d '\n')" \
  | npx -y @zhin.js/agent-media capture --public
```

输出里的 `img` 应该是一个 URL。用浏览器打开它：能显示图片，说明上传和读取都正常；如果变成下载，说明用的是会强制下载的默认域名，换成自定义域名或预签名模式。

## 密钥安全

- 只给密钥一个桶的写入和读取权限，不要使用主账号或管理员密钥。
- 密钥放在 shell 环境、`.env`（不提交）或密钥管理服务里，不要写进会提交到仓库的 `.mcp.json`、`config.toml`。
- 泄露后立即在控制台禁用并重新生成。
