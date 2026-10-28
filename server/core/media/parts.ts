/**
 * A file written in parts: the bytes of a file read, with what is changed of it between them, as
 * the catalog of the designs is written (`designCatalog.ts`). That catalog is some 54 MB: a Worker
 * holds 128 MB, so it does not hold it twice. Its SHA-256 is taken over the parts as they are, and
 * where the bucket takes a stream of a known length (R2, in a Worker: `FixedLengthStream`) they
 * are written to it as one, a little at a time. Elsewhere (Node) they are joined first.
 *
 * And a file of the bucket kept in the history before it is written over (`writing.ts`): in a
 * Worker it goes from the one bucket to the other as it is read.
 */
import type { BucketObject } from '../bucket.ts';
import { sha256Hex } from './live.ts';

/** A file as parts of bytes, in order. */
export type Parts = readonly Uint8Array[];

export const sizeOf = (data: Uint8Array | Parts) =>
  data instanceof Uint8Array ? data.length : data.reduce((sum, part) => sum + part.length, 0);

/** The bytes of parts as one; the part itself when there is one. */
export function joined(data: Uint8Array | Parts): Uint8Array {
  if (data instanceof Uint8Array) return data;
  if (data.length === 1) return data[0]!;
  const whole = new Uint8Array(sizeOf(data));
  let at = 0;
  for (const part of data) {
    whole.set(part, at);
    at += part.length;
  }
  return whole;
}

// ---- SHA-256 (FIPS 180-4), over parts: WebCrypto takes the bytes of a file only as one.

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

class Sha256 {
  private readonly state = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  private readonly words = new Uint32Array(64);
  private readonly block = new Uint8Array(64);
  private filled = 0;
  private length = 0;

  update(bytes: Uint8Array) {
    this.length += bytes.length;
    this.take(bytes);
  }

  private take(bytes: Uint8Array) {
    let at = 0;
    if (this.filled > 0) {
      const room = Math.min(64 - this.filled, bytes.length);
      this.block.set(bytes.subarray(0, room), this.filled);
      this.filled += room;
      at = room;
      if (this.filled < 64) return;
      this.compress(this.block, 0);
      this.filled = 0;
    }
    for (; at + 64 <= bytes.length; at += 64) this.compress(bytes, at);
    if (at < bytes.length) {
      this.block.set(bytes.subarray(at), 0);
      this.filled = bytes.length - at;
    }
  }

  hex(): string {
    const bits = this.length * 8;
    const padding = new Uint8Array((this.filled < 56 ? 56 : 120) - this.filled + 8);
    padding[0] = 0x80;
    const view = new DataView(padding.buffer);
    view.setUint32(padding.length - 8, Math.floor(bits / 0x100000000));
    view.setUint32(padding.length - 4, bits >>> 0);
    this.take(padding);
    return [...this.state].map((word) => word.toString(16).padStart(8, '0')).join('');
  }

  private compress(bytes: Uint8Array, at: number) {
    const w = this.words;
    for (let i = 0; i < 16; i += 1) {
      const j = at + i * 4;
      w[i] = (bytes[j]! << 24) | (bytes[j + 1]! << 16) | (bytes[j + 2]! << 8) | bytes[j + 3]!;
    }
    for (let i = 16; i < 64; i += 1) {
      const x = w[i - 15]!;
      const y = w[i - 2]!;
      const s0 = ((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3);
      const s1 = ((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10);
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) | 0;
    }
    const s = this.state;
    let a = s[0]!;
    let b = s[1]!;
    let c = s[2]!;
    let d = s[3]!;
    let e = s[4]!;
    let f = s[5]!;
    let g = s[6]!;
    let h = s[7]!;
    for (let i = 0; i < 64; i += 1) {
      const s1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const t1 = (h + s1 + ((e & f) ^ (~e & g)) + K[i]! + w[i]!) | 0;
      const s0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const t2 = (s0 + ((a & b) ^ (a & c) ^ (b & c))) | 0;
      h = g;
      g = f;
      f = e;
      e = (d + t1) | 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) | 0;
    }
    s[0] = s[0]! + a;
    s[1] = s[1]! + b;
    s[2] = s[2]! + c;
    s[3] = s[3]! + d;
    s[4] = s[4]! + e;
    s[5] = s[5]! + f;
    s[6] = s[6]! + g;
    s[7] = s[7]! + h;
  }
}

/** The SHA-256 of a file, in hex, whether it is one part or many. */
export function sha256Of(data: Uint8Array | Parts): Promise<string> {
  if (data instanceof Uint8Array) return sha256Hex(data);
  if (data.length === 1) return sha256Hex(data[0]!);
  const hash = new Sha256();
  for (const part of data) hash.update(part);
  return Promise.resolve(hash.hex());
}

// ---- Writing in parts

interface FixedLength {
  readonly readable: ReadableStream<Uint8Array>;
  readonly writable: WritableStream<Uint8Array>;
}

/** A Worker's stream of a known length, which R2 takes; none elsewhere. */
const fixedLength = () =>
  (globalThis as { FixedLengthStream?: new (length: number | bigint) => FixedLength })
    .FixedLengthStream;

/** How much of a part is written at a time: a copy, so the bytes it is of stay as they are. */
const CHUNK = 1024 * 1024;

/**
 * What a bucket is given to write a file of parts: in a Worker, a stream of them; elsewhere, the
 * bytes joined.
 */
export function bodyOf(data: Uint8Array | Parts): Uint8Array | ReadableStream<Uint8Array> {
  const Fixed = fixedLength();
  if (data instanceof Uint8Array || data.length === 1 || !Fixed) return joined(data);
  const { readable, writable } = new Fixed(sizeOf(data));
  const writer = writable.getWriter();
  void (async () => {
    for (const part of data) {
      for (let at = 0; at < part.length; at += CHUNK) {
        await writer.write(part.slice(at, at + CHUNK));
      }
    }
    await writer.close();
  })().catch((error: unknown) => writer.abort(error).catch(() => undefined));
  return readable;
}

/**
 * What a bucket is given to write a file of another bucket: in a Worker, its stream, as it is
 * read; elsewhere, its bytes.
 */
export function copyOf(object: BucketObject): Promise<ArrayBuffer | ReadableStream> {
  const Fixed = fixedLength();
  if (!Fixed) return object.arrayBuffer();
  return Promise.resolve(
    (object.body as ReadableStream<Uint8Array>).pipeThrough(new Fixed(object.size)),
  );
}
