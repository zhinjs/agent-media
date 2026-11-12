import { mkdtemp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { InspectionQueue } from '../src/inspect.js';
import { LocalMediaStore, MediaUnavailableError } from '../src/stores/local.js';
import { S3PublicStore } from '../src/stores/s3.js';
import { sniffMime, decodeBase64 } from '../src/sniff.js';
import { BIG_PNG, PNG, tempStore } from './helpers.js';


describe('sniff', () => {
  it('detects by signature, not by claim', () => {
    expect(sniffMime(PNG)).toBe('image/png');
    expect(sniffMime(Buffer.from('%PDF-1.7'))).toBe('application/pdf');
    expect(sniffMime(Buffer.from('hello world'))).toBeUndefined();
  });
  it('rejects oversized base64 before decoding', () => {
    expect(decodeBase64('A'.repeat(4000), 100)).toBeUndefined();
    expect(decodeBase64('not*base64', 100)).toBeUndefined();
  });
});

describe('LocalMediaStore', () => {
  it('isolates scopes and expires assets', async () => {
    let now = 1_000;
    const store = await tempStore({ retentionMs: 100, now: () => now });
    const ref = await store.capture({ bytes: PNG, mime: 'image/png' }, 'alice');
    expect((await store.read(ref.asset_id, 'alice')).mime).toBe('image/png');
    await expect(store.read(ref.asset_id, 'bob')).rejects.toBeInstanceOf(MediaUnavailableError);
    await expect(store.read('../etc/passwd', 'alice')).rejects.toBeInstanceOf(MediaUnavailableError);
    now += 200;
    await expect(store.read(ref.asset_id, 'alice')).rejects.toBeInstanceOf(MediaUnavailableError);
  });

  it('evicts the oldest assets over the count limit', async () => {
    let now = 0;
    const store = await tempStore({ maxCount: 2, now: () => ++now });
    const a = await store.capture({ bytes: PNG, mime: 'image/png' }, 's');
    const b = await store.capture({ bytes: PNG, mime: 'image/png' }, 's');
    const c = await store.capture({ bytes: PNG, mime: 'image/png' }, 's');
    await expect(store.read(a.asset_id, 's')).rejects.toBeInstanceOf(MediaUnavailableError);
    expect((await store.read(b.asset_id, 's')).ref.asset_id).toBe(b.asset_id);
    expect((await store.read(c.asset_id, 's')).ref.asset_id).toBe(c.asset_id);
  });

  it('serialises concurrent captures', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agent-media-'));
    const store = new LocalMediaStore({ dir, maxCount: 3 });
    await Promise.all(Array.from({ length: 6 }, () => store.capture({ bytes: PNG, mime: 'image/png' }, 's')));
    expect((await readdir(dir)).filter(name => name.endsWith('.json'))).toHaveLength(3);
  });

  it('refuses unrecognised bytes', async () => {
    const store = await tempStore();
    await expect(store.capture({ bytes: Buffer.from('text'), mime: 'image/png' }, 's')).rejects.toThrow('Unrecognised');
  });
});

describe('S3PublicStore', () => {
  const base = { endpoint: 'https://acc.r2.cloudflarestorage.com', bucket: 'media', accessKeyId: 'k', secretAccessKey: 's', prefix: 'tmp/' };

  it('signs a PUT and returns the public URL', async () => {
    const fetchMock = vi.fn(async (_req: Request) => new Response(null, { status: 200 }));
    const store = new S3PublicStore({ ...base, publicBaseUrl: 'https://cdn.example.com', fetch: fetchMock as unknown as typeof fetch });
    const ref = await store.publish({ bytes: BIG_PNG, mime: 'image/png' });
    const request = fetchMock.mock.calls[0]![0];
    expect(request.method).toBe('PUT');
    expect(request.url).toMatch(/^https:\/\/acc\.r2\.cloudflarestorage\.com\/media\/tmp\/[0-9a-f-]{36}\.png$/u);
    expect(request.headers.get('authorization')).toContain('AWS4-HMAC-SHA256');
    expect(ref.url).toMatch(/^https:\/\/cdn\.example\.com\/tmp\/[0-9a-f-]{36}\.png$/u);
    expect(store.ownsUrl(ref.url)).toBe(true);
    expect(store.ownsUrl('https://cdn.example.com/tmp/../x.png')).toBe(false);
  });

  it('supports virtual-hosted style (Aliyun OSS) and presigned URLs', async () => {
    const fetchMock = vi.fn(async (_req: Request) => new Response(null, { status: 200 }));
    const store = new S3PublicStore({
      ...base, endpoint: 'https://oss-cn-hangzhou.aliyuncs.com', region: 'oss-cn-hangzhou', virtualHosted: true,
      urlMode: 'presigned', urlTtlSeconds: 600, fetch: fetchMock as unknown as typeof fetch,
    });
    const ref = await store.publish({ bytes: PNG, mime: 'image/png' });
    expect(fetchMock.mock.calls[0]![0].url).toMatch(/^https:\/\/media\.oss-cn-hangzhou\.aliyuncs\.com\/tmp\//u);
    expect(ref.url).toContain('X-Amz-Signature=');
    expect(ref.url).toContain('X-Amz-Expires=600');
  });

  it('surfaces upload failures', async () => {
    const store = new S3PublicStore({ ...base, publicBaseUrl: 'https://cdn.example.com', fetch: (async () => new Response(null, { status: 403 })) as unknown as typeof fetch });
    await expect(store.publish({ bytes: PNG, mime: 'image/png' })).rejects.toThrow('HTTP 403');
  });

  it('validates configuration', () => {
    expect(() => new S3PublicStore({ ...base })).toThrow('publicBaseUrl');
    expect(() => new S3PublicStore({ ...base, endpoint: 'http://x', publicBaseUrl: 'https://c' })).toThrow('HTTPS');
  });
});

describe('InspectionQueue', () => {
  it('loads requested images once and enforces the per-turn budget', async () => {
    const store = await tempStore();
    const ref = await store.capture({ bytes: PNG, mime: 'image/png' }, 's');
    const queue = new InspectionQueue(store, 's', { perTurn: 1 });
    expect(queue.request(ref.asset_id)).toContain('next model request');
    expect(queue.request(ref.asset_id)).toContain('limit');
    const images = await queue.drain();
    expect(images).toHaveLength(1);
    expect(images[0]!.base64).toBe(PNG.toString('base64'));
    expect(await queue.drain()).toHaveLength(0);
  });
});
