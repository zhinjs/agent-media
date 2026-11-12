import { homedir } from 'node:os';
import { join } from 'node:path';
import { LocalMediaStore } from './stores/local.js';
import { S3PublicStore } from './stores/s3.js';

export interface EnvStores {
  readonly privateStore: LocalMediaStore;
  readonly publicStore?: S3PublicStore;
  readonly scope: string;
  readonly maxBytes?: number;
}

type Env = Readonly<Record<string, string | undefined>>;

/**
 * Configuration by environment variables, so every harness can configure it the same way:
 *
 * AGENT_MEDIA_DIR (default ~/.cache/agent-media), AGENT_MEDIA_RETENTION_DAYS (7), AGENT_MEDIA_MAX_MB (25),
 * AGENT_MEDIA_SCOPE (default 'default'),
 * AGENT_MEDIA_S3_ENDPOINT, AGENT_MEDIA_S3_BUCKET, AGENT_MEDIA_S3_REGION, AGENT_MEDIA_S3_ACCESS_KEY_ID,
 * AGENT_MEDIA_S3_SECRET_ACCESS_KEY, AGENT_MEDIA_S3_PREFIX, AGENT_MEDIA_S3_VIRTUAL_HOSTED=1,
 * AGENT_MEDIA_S3_URL_MODE=public|presigned, AGENT_MEDIA_S3_PUBLIC_BASE_URL, AGENT_MEDIA_S3_URL_TTL.
 */
export function storesFromEnv(env: Env = process.env): EnvStores {
  const days = Number(env.AGENT_MEDIA_RETENTION_DAYS ?? 7);
  const privateStore = new LocalMediaStore({
    dir: env.AGENT_MEDIA_DIR || join(env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'agent-media'),
    retentionMs: (Number.isFinite(days) && days > 0 ? days : 7) * 86_400_000,
  });
  const megabytes = Number(env.AGENT_MEDIA_MAX_MB);
  const s3 = env.AGENT_MEDIA_S3_BUCKET;
  const publicStore = s3 ? new S3PublicStore({
    endpoint: required(env, 'AGENT_MEDIA_S3_ENDPOINT'),
    bucket: s3,
    region: env.AGENT_MEDIA_S3_REGION,
    accessKeyId: required(env, 'AGENT_MEDIA_S3_ACCESS_KEY_ID'),
    secretAccessKey: required(env, 'AGENT_MEDIA_S3_SECRET_ACCESS_KEY'),
    prefix: env.AGENT_MEDIA_S3_PREFIX,
    virtualHosted: env.AGENT_MEDIA_S3_VIRTUAL_HOSTED === '1' || env.AGENT_MEDIA_S3_VIRTUAL_HOSTED === 'true',
    urlMode: env.AGENT_MEDIA_S3_URL_MODE === 'presigned' ? 'presigned' : 'public',
    publicBaseUrl: env.AGENT_MEDIA_S3_PUBLIC_BASE_URL,
    urlTtlSeconds: env.AGENT_MEDIA_S3_URL_TTL ? Number(env.AGENT_MEDIA_S3_URL_TTL) : undefined,
  }) : undefined;
  return {
    privateStore, publicStore, scope: env.AGENT_MEDIA_SCOPE || 'default',
    ...(Number.isFinite(megabytes) && megabytes > 0 ? { maxBytes: megabytes * 1024 * 1024 } : {}),
  };
}

function required(env: Env, name: string): string {
  const value = env[name];
  if (!value) throw new Error(`${name} is required when AGENT_MEDIA_S3_BUCKET is set`);
  return value;
}
