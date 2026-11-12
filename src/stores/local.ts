import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { MEDIA_EXTENSIONS, sniffMime } from '../sniff.js';
import type { MediaBytes, MediaScope, PrivateMediaRef, PrivateMediaStore } from '../types.js';

export interface LocalMediaStoreOptions {
  readonly dir: string;
  /** Default 7 days. */
  readonly retentionMs?: number;
  /** Total bytes kept on disk. Default 1 GiB. */
  readonly maxTotalBytes?: number;
  /** Assets kept on disk. Default 1000. */
  readonly maxCount?: number;
  readonly now?: () => number;
}

interface StoredRecord extends PrivateMediaRef {
  readonly scope: string;
  readonly source?: string;
  readonly created_at: number;
}

const ASSET_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export class MediaUnavailableError extends Error {
  constructor() {
    super('Media asset is unavailable, expired or outside this scope');
    this.name = 'MediaUnavailableError';
  }
}

/**
 * Private store on the local filesystem. One metadata file per asset; bytes are never cached in memory.
 * Writes are serialised so limits hold under concurrent captures.
 */
export class LocalMediaStore implements PrivateMediaStore {
  readonly #dir: string;
  readonly #retentionMs: number;
  readonly #maxTotalBytes: number;
  readonly #maxCount: number;
  readonly #now: () => number;
  #tail: Promise<unknown> = Promise.resolve();

  constructor(options: LocalMediaStoreOptions) {
    this.#dir = options.dir;
    this.#retentionMs = options.retentionMs ?? 7 * 86_400_000;
    this.#maxTotalBytes = options.maxTotalBytes ?? 1024 ** 3;
    this.#maxCount = options.maxCount ?? 1000;
    this.#now = options.now ?? Date.now;
  }

  capture(media: MediaBytes, scope: MediaScope, source?: string, signal?: AbortSignal): Promise<PrivateMediaRef> {
    return this.#serial(async () => {
      signal?.throwIfAborted();
      const mime = sniffMime(media.bytes);
      if (!mime) throw new Error('Unrecognised media type');
      if (media.bytes.byteLength > this.#maxTotalBytes) throw new Error('Media exceeds the store capacity');
      await mkdir(this.#dir, { recursive: true, mode: 0o700 });
      await this.#prune(media.bytes.byteLength);
      const now = this.#now();
      const record: StoredRecord = {
        asset_id: randomUUID(), mime, size: media.bytes.byteLength, expires_at: now + this.#retentionMs,
        scope: hashScope(scope), created_at: now, ...(source ? { source } : {}),
      };
      const base = join(this.#dir, record.asset_id);
      await writeAtomic(`${base}.${MEDIA_EXTENSIONS[mime]}`, media.bytes);
      await writeAtomic(`${base}.json`, Buffer.from(JSON.stringify(record)));
      return publicRef(record);
    });
  }

  async read(assetId: string, scope: MediaScope, signal?: AbortSignal): Promise<MediaBytes & { readonly ref: PrivateMediaRef }> {
    signal?.throwIfAborted();
    const record = await this.#record(assetId);
    if (!record || record.scope !== hashScope(scope) || record.expires_at <= this.#now()) throw new MediaUnavailableError();
    const bytes = await readFile(join(this.#dir, `${assetId}.${MEDIA_EXTENSIONS[record.mime]}`)).catch(() => undefined);
    if (!bytes || sniffMime(bytes) !== record.mime) throw new MediaUnavailableError();
    return { bytes: new Uint8Array(bytes), mime: record.mime, ref: publicRef(record) };
  }

  /** Remove expired assets. Called on every capture; call it yourself on a timer if you like. */
  prune(): Promise<void> {
    return this.#serial(() => this.#prune(0));
  }

  async #record(assetId: string): Promise<StoredRecord | undefined> {
    if (!ASSET_ID.test(assetId)) return undefined;
    try {
      const record = JSON.parse(await readFile(join(this.#dir, `${assetId}.json`), 'utf8')) as StoredRecord;
      return record.asset_id === assetId && MEDIA_EXTENSIONS[record.mime] ? record : undefined;
    } catch { return undefined; }
  }

  async #prune(incoming: number): Promise<void> {
    let names: string[];
    try { names = await readdir(this.#dir); } catch { return; }
    const records: StoredRecord[] = [];
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      const record = await this.#record(name.slice(0, -5));
      if (record) records.push(record);
    }
    records.sort((a, b) => a.created_at - b.created_at);
    const now = this.#now();
    let total = records.reduce((sum, r) => sum + r.size, 0) + incoming;
    let count = records.length + (incoming ? 1 : 0);
    for (const record of records) {
      const over = total > this.#maxTotalBytes || count > this.#maxCount;
      if (record.expires_at > now && !over) continue;
      await this.#remove(record);
      total -= record.size;
      count -= 1;
    }
  }

  async #remove(record: StoredRecord): Promise<void> {
    const base = join(this.#dir, record.asset_id);
    await rm(`${base}.json`, { force: true });
    await rm(`${base}.${MEDIA_EXTENSIONS[record.mime]}`, { force: true });
  }

  #serial<T>(task: () => Promise<T>): Promise<T> {
    const run = this.#tail.then(task, task);
    this.#tail = run.catch(() => undefined);
    return run;
  }
}

function publicRef(record: StoredRecord): PrivateMediaRef {
  return { asset_id: record.asset_id, mime: record.mime, size: record.size, expires_at: record.expires_at };
}

function hashScope(scope: MediaScope): string {
  return createHash('sha256').update(`agent-media-scope:${scope}`).digest('hex');
}

async function writeAtomic(path: string, data: Uint8Array): Promise<void> {
  const temp = `${path}.${randomUUID()}.tmp`;
  await writeFile(temp, data, { mode: 0o600, flag: 'wx' });
  await rename(temp, path);
}
