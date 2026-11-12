import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalMediaStore } from '../src/stores/local.js';
import type { MediaBytes, PublicMediaRef, PublicMediaStore } from '../src/types.js';

/** A valid 1x1 PNG. */
export const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
/** A PNG padded so its base64 is long, like a real image. */
export const BIG_PNG = Buffer.concat([PNG, Buffer.alloc(30_000, 7)]);
export const b64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64');

export async function tempStore(options: Partial<ConstructorParameters<typeof LocalMediaStore>[0]> = {}): Promise<LocalMediaStore> {
  return new LocalMediaStore({ dir: await mkdtemp(join(tmpdir(), 'agent-media-')), ...options });
}

export class MemoryPublicStore implements PublicMediaStore {
  readonly published: MediaBytes[] = [];
  async publish(media: MediaBytes): Promise<PublicMediaRef> {
    this.published.push(media);
    return { url: `https://cdn.example.com/m/${this.published.length}.png`, mime: media.mime, size: media.bytes.byteLength };
  }
  ownsUrl(url: string): boolean { return url.startsWith('https://cdn.example.com/m/'); }
}
