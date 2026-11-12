import { describe, expect, it } from 'vitest';
import { captureMedia } from '../src/capture.js';
import { BIG_PNG, MemoryPublicStore, b64, tempStore } from './helpers.js';

const longest = (value: unknown): number => {
  let max = 0;
  JSON.stringify(value, (_k, v) => { if (typeof v === 'string') max = Math.max(max, v.length); return v; });
  return max;
};

describe('captureMedia', () => {
  it('replaces MCP image blocks with a private reference', async () => {
    const store = await tempStore();
    const result = { content: [{ type: 'text', text: 'shot' }, { type: 'image', data: b64(BIG_PNG), mimeType: 'image/png' }] };
    const out = await captureMedia(result, { privateStore: store, scope: 's1' });
    expect(out.captured).toHaveLength(1);
    expect(out.captured[0]!.kind).toBe('private');
    const block = (out.value as typeof result).content[1] as { type: string; text: string };
    expect(block.type).toBe('text');
    expect(block.text).toContain('asset_id');
    expect(block.text).toContain('inspect_media');
    expect(longest(out.value)).toBeLessThan(400);
    const ref = out.captured[0]!.ref as { asset_id: string };
    expect(Buffer.from((await store.read(ref.asset_id, 's1')).bytes)).toEqual(BIG_PNG);
  });

  it('replaces Anthropic base64 blocks, MCP resources, data URIs and b64_json', async () => {
    const store = await tempStore();
    const data = b64(BIG_PNG);
    const result = {
      a: { type: 'image', source: { type: 'base64', media_type: 'image/png', data } },
      r: { type: 'resource', resource: { uri: 'x://y', mimeType: 'image/png', blob: data } },
      html: `<img src="data:image/png;base64,${data}"> done`,
      openai: { data: [{ b64_json: data }] },
    };
    const out = await captureMedia(result, { privateStore: store });
    // One payload → stored once, every copy replaced
    expect(out.captured).toHaveLength(1);
    const v = out.value as Record<string, any>;
    expect(v.a.type).toBe('text');
    expect(v.r.type).toBe('text');
    expect(v.html).toMatch(/^<img src="agent-media:[0-9a-f-]{36}"> done$/u);
    expect(v.openai.data[0].b64_json).toMatch(/^agent-media:/u);
  });

  it('parses JSON mirrored in text blocks and removes structuredContent copies', async () => {
    const store = await tempStore();
    const data = b64(BIG_PNG);
    const result = {
      content: [{ type: 'text', text: JSON.stringify({ image: `data:image/png;base64,${data}` }) }],
      structuredContent: { raw: data },
    };
    const out = await captureMedia(result, { privateStore: store });
    expect(longest(out.value)).toBeLessThan(400);
    expect(JSON.stringify(out.value)).not.toContain(data.slice(0, 100));
  });

  it('publishes to the public store when policy is public', async () => {
    const pub = new MemoryPublicStore();
    const out = await captureMedia({ type: 'image', data: b64(BIG_PNG), mimeType: 'image/png' }, { policy: 'public', publicStore: pub });
    expect(pub.published).toHaveLength(1);
    expect((out.value as unknown as { text: string }).text).toContain('https://cdn.example.com/m/1.png');
  });

  it('leaves ordinary strings and base64-looking tokens alone', async () => {
    const store = await tempStore();
    const result = { token: 'A'.repeat(500), note: 'hello', n: 3 };
    const out = await captureMedia(result, { privateStore: store });
    expect(out.value).toBe(result);
    expect(out.captured).toHaveLength(0);
  });

  it('drops invalid, unrecognised and oversized payloads instead of passing them through', async () => {
    const store = await tempStore();
    const result = [
      { type: 'image', data: '!!!not base64!!!', mimeType: 'image/png' },
      { type: 'image', data: b64(Buffer.alloc(2000, 1)), mimeType: 'image/png' },
      { type: 'image', data: b64(BIG_PNG), mimeType: 'image/png' },
    ];
    const out = await captureMedia(result, { privateStore: store, maxBytes: 1000 });
    expect(out.captured).toHaveLength(0);
    expect(out.dropped).toBe(3);
    const texts = (out.value as unknown as Array<{ text: string }>).map(b => b.text);
    expect(texts[0]).toContain('invalid base64');
    expect(texts[1]).toContain('exceeds size limit');
    expect(texts[2]).toContain('exceeds size limit');
  });

  it('keepBlocks leaves structured blocks but still captures text-borne base64', async () => {
    const store = await tempStore();
    const data = b64(BIG_PNG);
    const block = { type: 'image', data, mimeType: 'image/png' };
    const out = await captureMedia([block, { type: 'text', text: `data:image/png;base64,${data}` }], { privateStore: store, keepBlocks: true });
    const v = out.value as Array<Record<string, string>>;
    expect(v[0]).toEqual(block);
    expect(v[1]!.text).toMatch(/^agent-media:/u);
  });

  it('reports missing stores as dropped, never leaking bytes', async () => {
    const out = await captureMedia({ type: 'image', data: b64(BIG_PNG), mimeType: 'image/png' });
    expect(out.dropped).toBe(1);
    expect((out.value as unknown as { text: string }).text).toContain('no private store configured');
  });
});
