import { decodeBase64, isImageMime, sniffMime } from './sniff.js';
import type { MediaBytes, MediaScope, PrivateMediaRef, PrivateMediaStore, PublicMediaRef, PublicMediaStore } from './types.js';

export const DEFAULT_MAX_BYTES = 25 * 1024 * 1024;

export type CapturePolicy = 'private' | 'public';

export interface CaptureOptions {
  /** Where captured media goes. Default 'private': nothing becomes public unless you say so. */
  readonly policy?: CapturePolicy;
  readonly privateStore?: PrivateMediaStore;
  readonly publicStore?: PublicMediaStore;
  readonly scope?: MediaScope;
  /** Recorded with private assets, e.g. the tool name. */
  readonly source?: string;
  /** Larger payloads are dropped, not stored. Default 25 MiB. */
  readonly maxBytes?: number;
  /** Object keys whose string value is known to be raw base64 media (e.g. OpenAI `b64_json`). */
  readonly base64Keys?: readonly string[];
  /** Name of the tool the model calls to view a private asset. Default `inspect_media`. */
  readonly inspectTool?: string;
  /**
   * Leave structured image/audio content blocks untouched and capture only text-borne base64
   * (data URIs, base64 fields). Use when the harness already turns blocks into native model images.
   */
  readonly keepBlocks?: boolean;
  readonly signal?: AbortSignal;
}

export interface CapturedMedia {
  readonly kind: CapturePolicy;
  readonly ref: PrivateMediaRef | PublicMediaRef;
}

export interface CaptureResult<T> {
  readonly value: T;
  readonly captured: readonly CapturedMedia[];
  /** Payloads that looked like media but were invalid, oversized or could not be stored. */
  readonly dropped: number;
}

const DEFAULT_BASE64_KEYS = ['b64_json', 'image_base64', 'base64_image', 'audio_base64'];
const DATA_URI = /data:([a-z]+\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=\s]+)/giu;
const MIN_COPY_LENGTH = 64;

type Json = unknown;
const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * Replace media payloads in a tool result with short references.
 *
 * Recognised shapes, and only these (arbitrary base64-looking strings are left alone — they may be tokens):
 * - MCP `{type:'image'|'audio', data, mimeType}` and `{type:'resource', resource:{mimeType, blob}}`
 * - Anthropic `{type:'image'|'document', source:{type:'base64', media_type, data}}`
 * - `data:<mime>;base64,...` URIs inside any string
 * - values of `base64Keys` (default `b64_json`, `image_base64`, …)
 * - JSON text inside MCP text blocks is parsed and visited the same way
 */
export async function captureMedia<T = Json>(result: T, options: CaptureOptions = {}): Promise<CaptureResult<T>> {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const base64Keys = new Set(options.base64Keys ?? DEFAULT_BASE64_KEYS);
  const inspectTool = options.inspectTool ?? 'inspect_media';
  const replacements = new Map<string, Promise<Replacement>>();
  const captured: CapturedMedia[] = [];
  const kept = new WeakSet<object>();
  let dropped = 0;

  const store = (payload: string, declared?: string): Promise<Replacement> => {
    const key = payload.replace(/\s+/gu, '');
    let pending = replacements.get(key);
    if (!pending) {
      pending = storeOne(key, declared).then(replacement => {
        if (replacement.captured) captured.push(replacement.captured);
        else dropped += 1;
        return replacement;
      });
      replacements.set(key, pending);
    }
    return pending;
  };

  const storeOne = async (payload: string, declared?: string): Promise<Replacement> => {
    options.signal?.throwIfAborted();
    const bytes = decodeBase64(payload, maxBytes);
    if (!bytes) return dropReplacement(declared, payload.length * 0.75 > maxBytes ? 'exceeds size limit' : 'invalid base64');
    const mime = sniffMime(bytes);
    if (!mime) return dropReplacement(declared, 'unrecognised media type');
    const media: MediaBytes = { bytes, mime };
    try {
      if ((options.policy ?? 'private') === 'public') {
        if (!options.publicStore) return dropReplacement(mime, 'no public store configured');
        const ref = await options.publicStore.publish(media, options.signal);
        return { captured: { kind: 'public', ref }, text: JSON.stringify({ url: ref.url, mime: ref.mime, size: ref.size }), uri: ref.url };
      }
      if (!options.privateStore) return dropReplacement(mime, 'no private store configured');
      const ref = await options.privateStore.capture(media, options.scope ?? 'default', options.source, options.signal);
      const label = isImageMime(mime) ? 'image' : 'media';
      return {
        captured: { kind: 'private', ref },
        text: `[private ${label} ${JSON.stringify(ref)}; call ${inspectTool} with asset_id to view it. Do not publish without being asked.]`,
        uri: `agent-media:${ref.asset_id}`,
      };
    } catch (error) {
      options.signal?.throwIfAborted();
      const reason = error instanceof Error && error.message.length < 120 ? error.message : 'storage failed';
      return dropReplacement(mime, reason);
    }
  };

  const replaceDataUris = async (text: string): Promise<string> => {
    if (!text.includes(';base64,')) return text;
    let out = '';
    let last = 0;
    for (const match of text.matchAll(DATA_URI)) {
      const replacement = await store(match[2]!, match[1]);
      out += text.slice(last, match.index) + replacement.uri;
      last = match.index! + match[0].length;
    }
    return out + text.slice(last);
  };

  const visit = async (value: unknown, key?: string): Promise<unknown> => {
    if (typeof value === 'string') {
      if (key && base64Keys.has(key) && value.length >= MIN_COPY_LENGTH) return (await store(value)).uri;
      return replaceDataUris(value);
    }
    if (Array.isArray(value)) {
      const items: unknown[] = [];
      for (const item of value) items.push(await visit(item));
      return items;
    }
    if (!isObject(value)) return value;
    if (options.keepBlocks && (value.type === 'image' || value.type === 'audio' || value.type === 'document'
      || (value.type === 'resource' && isObject(value.resource) && typeof value.resource.blob === 'string'))) {
      kept.add(value);
      return value;
    }
    // MCP image / audio content block
    if ((value.type === 'image' || value.type === 'audio') && typeof value.data === 'string') {
      return { type: 'text', text: (await store(value.data, str(value.mimeType))).text };
    }
    // MCP embedded binary resource
    if (value.type === 'resource' && isObject(value.resource) && typeof value.resource.blob === 'string') {
      return { type: 'text', text: (await store(value.resource.blob, str(value.resource.mimeType))).text };
    }
    // Anthropic image / document block
    if ((value.type === 'image' || value.type === 'document') && isObject(value.source)
      && value.source.type === 'base64' && typeof value.source.data === 'string') {
      return { type: 'text', text: (await store(value.source.data, str(value.source.media_type))).text };
    }
    // JSON mirrored into a text block
    if (value.type === 'text' && typeof value.text === 'string') {
      const trimmed = value.text.trim();
      if ((trimmed.startsWith('{') || trimmed.startsWith('[')) && trimmed.length >= MIN_COPY_LENGTH) {
        try {
          const parsed = JSON.parse(trimmed) as unknown;
          return { ...value, text: JSON.stringify(await visit(parsed)) };
        } catch { /* not JSON */ }
      }
      return { ...value, text: await replaceDataUris(value.text) };
    }
    const next: Record<string, unknown> = {};
    for (const [k, item] of Object.entries(value)) next[k] = await visit(item, k);
    return next;
  };

  const visited = await visit(result);
  if (!replacements.size) return { value: result, captured, dropped };
  // Hosts often mirror one payload into several fields (structuredContent, text). Remove every copy.
  const settled = new Map<string, Replacement>();
  for (const [payload, pending] of replacements) settled.set(payload, await pending);
  const removeCopies = (value: unknown): unknown => {
    if (typeof value === 'string') {
      if (value.length < MIN_COPY_LENGTH) return value;
      let text = value;
      for (const [payload, replacement] of settled) {
        if (payload.length >= MIN_COPY_LENGTH && text.includes(payload)) text = text.split(payload).join(replacement.uri);
      }
      return text;
    }
    if (Array.isArray(value)) return value.map(removeCopies);
    if (isObject(value) && kept.has(value)) return value;
    if (isObject(value)) return Object.fromEntries(Object.entries(value).map(([k, item]) => [k, removeCopies(item)]));
    return value;
  };
  return { value: removeCopies(visited) as T, captured, dropped };
}

interface Replacement {
  readonly captured?: CapturedMedia;
  /** Text that replaces a whole content block. */
  readonly text: string;
  /** Text that replaces an inline payload (data URI or base64 field). */
  readonly uri: string;
}

function dropReplacement(mime: string | undefined, reason: string): Replacement {
  const text = `[media omitted${mime ? ` (${mime})` : ''}: ${reason}]`;
  return { text, uri: text };
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}
