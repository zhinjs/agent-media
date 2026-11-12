import { randomUUID } from 'node:crypto';
import { AwsClient } from 'aws4fetch';
import { MEDIA_EXTENSIONS, sniffMime } from '../sniff.js';
import type { MediaBytes, PublicMediaRef, PublicMediaStore } from '../types.js';

export interface S3PublicStoreOptions {
  /** S3-compatible API endpoint, e.g. `https://<account>.r2.cloudflarestorage.com`, `https://s3.oss-cn-hangzhou.aliyuncs.com`, `https://s3.us-east-1.amazonaws.com`. */
  readonly endpoint: string;
  readonly bucket: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  /** SigV4 signing region. Default: inferred from the endpoint (see inferS3Defaults). */
  readonly region?: string;
  /** Object directory ending in `/`. Configure a bucket lifecycle rule on it; this library never deletes. */
  readonly prefix?: string;
  /** `https://<bucket>.<endpoint host>/key` instead of `<endpoint>/<bucket>/key`. Default: inferred from the endpoint. */
  readonly virtualHosted?: boolean;
  /**
   * `public` (default): return `publicBaseUrl + prefix + key`; the bucket or CDN must allow anonymous reads.
   * `presigned`: return a signed GET URL valid for `urlTtlSeconds`; the bucket can stay private.
   */
  readonly urlMode?: 'public' | 'presigned';
  /** Required for `public`: HTTPS base URL that serves the bucket (custom domain / CDN). */
  readonly publicBaseUrl?: string;
  /** Default 3600, max 604800 (S3 limit). */
  readonly urlTtlSeconds?: number;
  readonly fetch?: typeof fetch;
}

const KEY = /^[0-9a-f-]{36}\.[a-z0-9]+$/u;

export interface S3EndpointDefaults {
  readonly provider: 'r2' | 'aliyun-oss' | 'tencent-cos' | 'aws' | 'qiniu' | 'unknown';
  readonly region: string;
  readonly virtualHosted: boolean;
}

/**
 * Region and addressing implied by well-known endpoints, so most users only set endpoint + bucket.
 * Aliyun OSS only accepts virtual-hosted requests; Tencent COS buckets created since 2024 reject path-style.
 * Unknown endpoints (MinIO and other self-hosted servers) default to path-style and `us-east-1`.
 */
export function inferS3Defaults(endpoint: string): S3EndpointDefaults {
  const host = new URL(endpoint).hostname.toLowerCase();
  let m: RegExpExecArray | null;
  if (host.endsWith('.r2.cloudflarestorage.com')) return { provider: 'r2', region: 'auto', virtualHosted: false };
  if ((m = /^(?:s3\.)?oss-([a-z0-9-]+?)(?:-internal)?\.aliyuncs\.com$/u.exec(host))) return { provider: 'aliyun-oss', region: m[1]!, virtualHosted: true };
  if ((m = /^cos\.([a-z0-9-]+)\.(?:myqcloud\.com|tencentcos\.cn)$/u.exec(host))) return { provider: 'tencent-cos', region: m[1]!, virtualHosted: true };
  if ((m = /^s3[.-]([a-z0-9-]+)\.amazonaws\.com(?:\.cn)?$/u.exec(host))) return { provider: 'aws', region: m[1]!, virtualHosted: true };
  if (host === 's3.amazonaws.com') return { provider: 'aws', region: 'us-east-1', virtualHosted: true };
  if ((m = /^s3\.([a-z0-9-]+)\.qiniucs\.com$/u.exec(host))) return { provider: 'qiniu', region: m[1]!, virtualHosted: true };
  return { provider: 'unknown', region: 'us-east-1', virtualHosted: false };
}

/** Publishes to any S3-compatible bucket: AWS S3, Cloudflare R2, Aliyun OSS, Tencent COS, MinIO. */
export class S3PublicStore implements PublicMediaStore {
  readonly #client: AwsClient;
  readonly #objectBase: string;
  readonly #publicBase?: string;
  readonly #urlMode: 'public' | 'presigned';
  readonly #ttl: number;
  readonly #fetch: typeof fetch;

  constructor(options: S3PublicStoreOptions) {
    const prefix = options.prefix ?? 'agent-media/';
    if (!/^(?:[A-Za-z0-9_-]+\/)*$/u.test(prefix)) throw new Error('prefix must be a relative directory ending in /');
    if (!options.accessKeyId?.trim() || !options.secretAccessKey?.trim()) throw new Error('S3 credentials are required');
    if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/u.test(options.bucket)) throw new Error('bucket name is invalid');
    const endpoint = httpsUrl(options.endpoint, 'endpoint');
    const inferred = inferS3Defaults(options.endpoint);
    this.#objectBase = (options.virtualHosted ?? inferred.virtualHosted)
      ? `${endpoint.protocol}//${options.bucket}.${endpoint.host}/${prefix}`
      : `${endpoint.origin}/${options.bucket}/${prefix}`;
    this.#urlMode = options.urlMode ?? 'public';
    if (this.#urlMode === 'public') {
      if (!options.publicBaseUrl) throw new Error('publicBaseUrl is required when urlMode is public');
      this.#publicBase = `${httpsUrl(options.publicBaseUrl, 'publicBaseUrl').href.replace(/\/+$/u, '')}/${prefix}`;
    }
    this.#ttl = Math.min(Math.max(Math.floor(options.urlTtlSeconds ?? 3600), 1), 604_800);
    this.#fetch = options.fetch ?? fetch;
    this.#client = new AwsClient({
      service: 's3', region: options.region || inferred.region,
      accessKeyId: options.accessKeyId, secretAccessKey: options.secretAccessKey, retries: 0,
    });
  }

  /**
   * Exactly an object URL this store mints. Public URLs carry no query or fragment;
   * presigned URLs carry the signature query and nothing after it.
   */
  ownsUrl(url: string): boolean {
    const base = this.#urlMode === 'public' ? this.#publicBase! : this.#objectBase;
    if (!url.startsWith(base) || url.includes('#')) return false;
    const rest = url.slice(base.length);
    const query = rest.indexOf('?');
    if (this.#urlMode === 'public') return query === -1 && KEY.test(rest);
    return query !== -1 && KEY.test(rest.slice(0, query)) && rest.slice(query).includes('X-Amz-Signature=');
  }

  async publish(media: MediaBytes, signal?: AbortSignal): Promise<PublicMediaRef> {
    signal?.throwIfAborted();
    const mime = sniffMime(media.bytes);
    if (!mime) throw new Error('Unrecognised media type');
    const key = `${randomUUID()}.${MEDIA_EXTENSIONS[mime]}`;
    const request = await this.#client.sign(`${this.#objectBase}${key}`, {
      method: 'PUT',
      headers: { 'Content-Type': mime, 'Cache-Control': 'no-store' },
      body: new Uint8Array(media.bytes),
    });
    const response = await this.#fetch(request, { signal, redirect: 'error' });
    await response.body?.cancel();
    if (!response.ok) throw new Error(`Upload failed (HTTP ${response.status})`);
    signal?.throwIfAborted();
    const url = this.#urlMode === 'public'
      ? `${this.#publicBase}${key}`
      : (await this.#client.sign(`${this.#objectBase}${key}?X-Amz-Expires=${this.#ttl}`, { method: 'GET', aws: { signQuery: true } })).url;
    return { url, mime, size: media.bytes.byteLength };
  }
}

function httpsUrl(value: string, field: string): URL {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new Error(`${field} must be an HTTPS URL without credentials, query or fragment`);
  }
  return url;
}
