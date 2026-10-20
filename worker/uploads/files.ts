/** The files an upload brings: what their bytes are, their size in pixels, their hash. */

const ascii = (bytes: Uint8Array, from: number, to: number) =>
  String.fromCharCode(...bytes.subarray(from, to));

/** The media type the bytes are, of those the library takes. */
export function sniff(bytes: Uint8Array): string | undefined {
  if (bytes.length >= 30 && ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 12) === 'WEBP') {
    return 'image/webp';
  }
  return undefined;
}

/**
 * The width and height of a WebP picture, from its first chunk, as the app's
 * `docs/reference-decks/scripts/pictures.mjs` reads them.
 */
export function webpSize(bytes: Uint8Array): [number, number] | undefined {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u24 = (at: number) => view.getUint16(at, true) | (view.getUint8(at + 2) << 16);
  switch (ascii(bytes, 12, 16)) {
    case 'VP8 ':
      return [view.getUint16(26, true) & 0x3fff, view.getUint16(28, true) & 0x3fff];
    case 'VP8L': {
      const bits = view.getUint32(21, true);
      return [(bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1];
    }
    case 'VP8X':
      return [u24(24) + 1, u24(27) + 1];
    default:
      return undefined;
  }
}

export async function sha256(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
