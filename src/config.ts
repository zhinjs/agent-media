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
 * AGENT_MEDIA_S3_SECRET_ACCESS_KEY, AGENT_MEDIA_S3_PREFIX, AGENT_MEDIA_S3_VIRTUAL_HOSTED=1|0 (default: inferred),
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
    virtualHosted: flag(env.AGENT_MEDIA_S3_VIRTUAL_HOSTED),
    urlMode: env.AGENT_MEDIA_S3_URL_MODE === 'presigned' ? 'presigned' : 'public',
    publicBaseUrl: env.AGENT_MEDIA_S3_PUBLIC_BASE_URL,
    urlTtlSeconds: env.AGENT_MEDIA_S3_URL_TTL ? Number(env.AGENT_MEDIA_S3_URL_TTL) : undefined,
  }) : undefined;
  return {
    privateStore, publicStore, scope: env.AGENT_MEDIA_SCOPE || 'default',
    ...(Number.isFinite(megabytes) && megabytes > 0 ? { maxBytes: megabytes * 1024 * 1024 } : {}),
  };
}

/** Unset → undefined (inferred from the endpoint); `1`/`true` → true; `0`/`false` → false. */
function flag(value: string | undefined): boolean | undefined {
  if (value === undefined || value === '') return undefined;
  if (value === '1' || value.toLowerCase() === 'true') return true;
  if (value === '0' || value.toLowerCase() === 'false') return false;
  throw new Error('AGENT_MEDIA_S3_VIRTUAL_HOSTED must be 1, 0, true or false');
}

function required(env: Env, name: string): string {
  const value = env[name];
  if (!value) throw new Error(`${name} is required when AGENT_MEDIA_S3_BUCKET is set`);
  return value;
}
