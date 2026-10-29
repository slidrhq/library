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
import { Sha256 } from './sha256.ts';

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

/** The SHA-256 of a file, in hex, whether it is one part or many: WebCrypto takes one alone. */
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
