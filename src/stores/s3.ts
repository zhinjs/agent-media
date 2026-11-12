import { randomUUID } from 'node:crypto';
import { AwsClient } from 'aws4fetch';
import { MEDIA_EXTENSIONS, sniffMime } from '../sniff.js';
import type { MediaBytes, PublicMediaRef, PublicMediaStore } from '../types.js';

export interface S3PublicStoreOptions {
  /** S3-compatible API endpoint, e.g. `https://<account>.r2.cloudflarestorage.com`, `https://oss-cn-hangzhou.aliyuncs.com`, `https://s3.us-east-1.amazonaws.com`. */
  readonly endpoint: string;
  readonly bucket: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  /** Default `auto` (R2). Use the bucket's region for AWS / OSS. */
  readonly region?: string;
  /** Object directory ending in `/`. Configure a bucket lifecycle rule on it; this library never deletes. */
  readonly prefix?: string;
  /** `https://<bucket>.<endpoint host>/key` instead of `<endpoint>/<bucket>/key`. Aliyun OSS requires it. */
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
    this.#objectBase = options.virtualHosted
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
      service: 's3', region: options.region ?? 'auto',
      accessKeyId: options.accessKeyId, secretAccessKey: options.secretAccessKey, retries: 0,
    });
  }

  ownsUrl(url: string): boolean {
    const base = this.#urlMode === 'public' ? this.#publicBase! : this.#objectBase;
    if (!url.startsWith(base)) return false;
    return KEY.test(url.slice(base.length).split('?')[0]!);
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
