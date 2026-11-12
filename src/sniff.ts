/** Media types this library recognises from file signatures. Declared MIME types are never trusted. */
export const MEDIA_EXTENSIONS: Readonly<Record<string, string>> = Object.freeze({
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'audio/mpeg': 'mp3',
  'audio/wav': 'wav',
  'audio/ogg': 'ogg',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'application/pdf': 'pdf',
});

const ascii = (bytes: Uint8Array, offset: number, text: string): boolean => {
  if (bytes.length < offset + text.length) return false;
  for (let i = 0; i < text.length; i++) if (bytes[offset + i] !== text.charCodeAt(i)) return false;
  return true;
};

/** Returns the MIME type proven by the file signature, or undefined. */
export function sniffMime(bytes: Uint8Array): string | undefined {
  if (bytes.length >= 8 && bytes[0] === 0x89 && ascii(bytes, 1, 'PNG\r\n\x1a\n')) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (ascii(bytes, 0, 'GIF87a') || ascii(bytes, 0, 'GIF89a')) return 'image/gif';
  if (ascii(bytes, 0, 'RIFF') && ascii(bytes, 8, 'WEBP')) return 'image/webp';
  if (ascii(bytes, 0, 'RIFF') && ascii(bytes, 8, 'WAVE')) return 'audio/wav';
  if (ascii(bytes, 0, 'OggS')) return 'audio/ogg';
  if (ascii(bytes, 0, 'ID3') || (bytes.length >= 2 && bytes[0] === 0xff && (bytes[1]! & 0xe0) === 0xe0)) return 'audio/mpeg';
  if (ascii(bytes, 4, 'ftyp')) return 'video/mp4';
  if (bytes.length >= 4 && bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) return 'video/webm';
  if (ascii(bytes, 0, '%PDF-')) return 'application/pdf';
  return undefined;
}

export const isImageMime = (mime: string): boolean => mime.startsWith('image/');

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/u;

/** Strict decode: rejects non-base64 text and payloads over maxBytes before allocating them. */
export function decodeBase64(value: string, maxBytes: number): Uint8Array | undefined {
  const text = value.replace(/\s+/gu, '');
  if (!text || text.length % 4 === 1 || !BASE64.test(text)) return undefined;
  const padding = text.endsWith('==') ? 2 : text.endsWith('=') ? 1 : 0;
  if (Math.floor((text.length * 3) / 4) - padding > maxBytes) return undefined;
  return new Uint8Array(Buffer.from(text, 'base64'));
}
