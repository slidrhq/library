/**
 * Archives of the library: tar (POSIX ustar, with a PAX header before a file whose path ustar
 * cannot hold), plain or gzipped. The page writes its exports with it (`src/exportArchive.ts`),
 * and reads the manifest of an archive before it is sent; the server reads what is brought in
 * (`archive.ts`). It takes regular files and folders; anything else (a link, a device) is said to
 * be other, and the reader of the entries decides what becomes of it.
 *
 * It stands on the web's APIs alone, the same in a browser, in a Worker and in Node.
 */

const BLOCK = 512;
/** The largest size an octal field of ustar holds: 8 GiB, more than any file of the library. */
const OCTAL_MOST = 8 ** 11 - 1;
/** The most bytes a PAX header or a GNU long name takes. */
const META_MOST = 1024 * 1024;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** An archive that is not one, or that ends before it should. */
export class TarError extends Error {}

// ---- Writing

function octal(field: Uint8Array, at: number, width: number, value: number) {
  const digits = value.toString(8).padStart(width - 1, '0');
  field.set(encoder.encode(`${digits}\0`), at);
}

/** A header block: `name` and `prefix` as ustar holds them, of a file (`0`) or a PAX header (`x`). */
function block(prefix: Uint8Array, name: Uint8Array, size: number, mtime: number, type: '0' | 'x') {
  if (size > OCTAL_MOST)
    throw new TarError(`A file of ${size} bytes is more than an archive holds.`);
  const header = new Uint8Array(BLOCK);
  header.set(name.subarray(0, 100), 0);
  octal(header, 100, 8, 0o644);
  octal(header, 108, 8, 0);
  octal(header, 116, 8, 0);
  octal(header, 124, 12, size);
  octal(header, 136, 12, Math.max(0, Math.floor(mtime)));
  header.fill(0x20, 148, 156);
  header[156] = type.charCodeAt(0);
  header.set(encoder.encode('ustar\0'), 257);
  header.set(encoder.encode('00'), 263);
  header.set(encoder.encode('slidr'), 265);
  header.set(encoder.encode('slidr'), 297);
  octal(header, 329, 8, 0);
  octal(header, 337, 8, 0);
  header.set(prefix.subarray(0, 155), 345);
  const sum = header.reduce((total, byte) => total + byte, 0);
  header.set(encoder.encode(`${sum.toString(8).padStart(6, '0')}\0 `), 148);
  return header;
}

/** A path as ustar holds it, in a name of 100 bytes after a prefix of 155; none when it cannot. */
function ustarParts(path: Uint8Array): { prefix: Uint8Array; name: Uint8Array } | undefined {
  if (path.length <= 100) return { prefix: new Uint8Array(0), name: path };
  for (let at = Math.min(155, path.length - 2); at > 0; at -= 1) {
    if (path[at] === 0x2f && path.length - at - 1 <= 100) {
      return { prefix: path.subarray(0, at), name: path.subarray(at + 1) };
    }
  }
  return undefined;
}

/** A record of a PAX header: its length, written in it, counts itself. */
function paxRecord(key: string, value: string): Uint8Array {
  const body = ` ${key}=${value}\n`;
  const bytes = encoder.encode(body).length;
  let length = bytes + 1;
  while (String(length).length + bytes !== length) length = String(length).length + bytes;
  return encoder.encode(`${length}${body}`);
}

/** The zeros that round `size` bytes up to whole blocks. */
export const tarPadding = (size: number) => new Uint8Array((BLOCK - (size % BLOCK)) % BLOCK);

/** The end of an archive: two empty blocks. */
export const tarEnd = () => new Uint8Array(BLOCK * 2);

/**
 * The header of a file of `size` bytes at `path`, written at `mtime` (seconds): one block, or a
 * PAX header with its path before it where ustar cannot hold the path. The file's bytes follow
 * it, then `tarPadding(size)`.
 */
export function tarHeader(path: string, size: number, mtime: number): Uint8Array {
  const name = encoder.encode(path);
  const parts = ustarParts(name);
  if (parts) return block(parts.prefix, parts.name, size, mtime, '0');
  const record = paxRecord('path', path);
  const short = encoder.encode(path.slice(-90));
  const pax = block(new Uint8Array(0), encoder.encode('PaxHeader'), record.length, mtime, 'x');
  const all = new Uint8Array(BLOCK + record.length + tarPadding(record.length).length + BLOCK);
  all.set(pax, 0);
  all.set(record, BLOCK);
  all.set(block(new Uint8Array(0), short, size, mtime, '0'), all.length - BLOCK);
  return all;
}

/** A whole archive of `files`, in their order: for what is small enough to hold at once. */
export function tarOf(files: [path: string, bytes: Uint8Array][], mtime = 0): Uint8Array {
  const parts = files.flatMap(([path, bytes]) => [
    tarHeader(path, bytes.length, mtime),
    bytes,
    tarPadding(bytes.length),
  ]);
  parts.push(tarEnd());
  const all = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    all.set(part, at);
    at += part.length;
  }
  return all;
}

// ---- Reading

/** An entry of an archive: a file with its bytes, a folder, or something else. */
export interface TarEntry {
  path: string;
  type: 'file' | 'folder' | 'other';
  size: number;
  /** A file's bytes; empty for anything else. */
  bytes: Uint8Array;
}

/** Bytes read from a stream as they are asked for, block by block. */
class Bytes {
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>;
  private chunks: Uint8Array[] = [];
  private held = 0;
  private ended = false;

  constructor(reader: ReadableStreamDefaultReader<Uint8Array>) {
    this.reader = reader;
  }

  private async fill(wanted: number) {
    while (this.held < wanted && !this.ended) {
      let read: ReadableStreamReadResult<Uint8Array>;
      try {
        read = await this.reader.read();
      } catch (error) {
        throw new TarError(
          `The archive could not be read: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      if (read.done) this.ended = true;
      else if (read.value.length > 0) {
        this.chunks.push(read.value);
        this.held += read.value.length;
      }
    }
  }

  /** The next `count` bytes; fewer only where the stream ends. */
  async take(count: number): Promise<Uint8Array> {
    await this.fill(count);
    const size = Math.min(count, this.held);
    const out = new Uint8Array(size);
    let at = 0;
    while (at < size) {
      const chunk = this.chunks[0]!;
      const part = Math.min(chunk.length, size - at);
      out.set(chunk.subarray(0, part), at);
      at += part;
      if (part === chunk.length) this.chunks.shift();
      else this.chunks[0] = chunk.subarray(part);
    }
    this.held -= size;
    return out;
  }

  /** The next `count` bytes, which must be there. */
  async exactly(count: number): Promise<Uint8Array> {
    const bytes = await this.take(count);
    if (bytes.length < count) throw new TarError('The archive ends in the middle of a file.');
    return bytes;
  }

  /** Passes over the next `count` bytes. */
  async skip(count: number) {
    let left = count;
    while (left > 0) {
      const part = (await this.take(Math.min(left, 1024 * 1024))).length;
      if (part === 0) throw new TarError('The archive ends in the middle of a file.');
      left -= part;
    }
  }
}

/**
 * The bytes of a stream, ungzipped where they are gzipped (they start with 1f 8b): a tar is read
 * from either.
 */
async function plain(stream: ReadableStream<Uint8Array>): Promise<ReadableStream<Uint8Array>> {
  const reader = stream.getReader();
  const first: Uint8Array[] = [];
  let held = 0;
  while (held < 2) {
    const read = await reader.read();
    if (read.done) break;
    first.push(read.value);
    held += read.value.length;
  }
  const head = first.flatMap((chunk) => [...chunk.subarray(0, 2)]);
  const whole = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of first) controller.enqueue(chunk);
    },
    async pull(controller) {
      const read = await reader.read();
      if (read.done) controller.close();
      else controller.enqueue(read.value);
    },
    cancel: (reason) => reader.cancel(reason),
  });
  if (head[0] !== 0x1f || head[1] !== 0x8b) return whole;
  return whole.pipeThrough(
    new DecompressionStream('gzip') as unknown as ReadableWritablePair<Uint8Array, Uint8Array>,
  );
}

const isZero = (bytes: Uint8Array) => bytes.every((byte) => byte === 0);

/** A text field of a header: up to its first NUL. */
function text(header: Uint8Array, at: number, width: number) {
  const field = header.subarray(at, at + width);
  const end = field.indexOf(0);
  return decoder.decode(end === -1 ? field : field.subarray(0, end));
}

/** A number field: octal, or base-256 where its first bit is set (GNU's, for large values). */
function number(header: Uint8Array, at: number, width: number) {
  const field = header.subarray(at, at + width);
  if (field[0]! & 0x80) {
    let value = field[0]! & 0x7f;
    for (const byte of field.subarray(1)) value = value * 256 + byte;
    return value;
  }
  const digits = text(header, at, width).trim();
  if (!/^[0-7]*$/.test(digits)) throw new TarError('The archive is not a tar archive.');
  return digits === '' ? 0 : parseInt(digits, 8);
}

/** Whether a header's checksum is its own: the sum of its bytes, the checksum's counted as spaces. */
function checks(header: Uint8Array) {
  const stated = number(header, 148, 8);
  let unsigned = 0;
  let signed = 0;
  for (let at = 0; at < BLOCK; at += 1) {
    const byte = at >= 148 && at < 156 ? 0x20 : header[at]!;
    unsigned += byte;
    signed += byte > 127 ? byte - 256 : byte;
  }
  return stated === unsigned || stated === signed;
}

/** The records of a PAX header, by key. */
function paxRecords(bytes: Uint8Array): Map<string, string> {
  const records = new Map<string, string>();
  let at = 0;
  while (at < bytes.length) {
    const space = bytes.indexOf(0x20, at);
    if (space === -1) break;
    const length = Number(decoder.decode(bytes.subarray(at, space)));
    if (!Number.isInteger(length) || length <= 0 || at + length > bytes.length) {
      throw new TarError('A PAX header of the archive is not one.');
    }
    const record = decoder.decode(bytes.subarray(space + 1, at + length - 1));
    const equals = record.indexOf('=');
    if (equals > 0) records.set(record.slice(0, equals), record.slice(equals + 1));
    at += length;
  }
  return records;
}

/**
 * The entries of an archive, plain or gzipped, in their order, each file's bytes whole: at most
 * `most` of them, or the archive is refused. It ends at the archive's first empty block, or where
 * the stream ends between two entries; the rest of the stream is not read, and is let go.
 */
export async function* readTar(
  stream: ReadableStream<Uint8Array>,
  most = Number.MAX_SAFE_INTEGER,
): AsyncGenerator<TarEntry> {
  const reader = (await plain(stream)).getReader();
  const bytes = new Bytes(reader);
  let longPath: string | undefined;
  let longSize: number | undefined;
  try {
    for (;;) {
      const header = await bytes.take(BLOCK);
      if (header.length === 0 || isZero(header)) return;
      if (header.length < BLOCK) throw new TarError('The archive ends in the middle of a header.');
      if (!checks(header)) throw new TarError('The archive is not a tar archive, or is damaged.');
      const type = String.fromCharCode(header[156]!);
      const size = longSize ?? number(header, 124, 12);
      const padded = size + tarPadding(size).length;
      if (type === 'x' || type === 'g' || type === 'L' || type === 'K') {
        if (size > META_MOST) throw new TarError('A header of the archive is too long.');
        const meta = (await bytes.exactly(padded)).subarray(0, size);
        if (type === 'x') {
          const records = paxRecords(meta);
          longPath = records.get('path') ?? longPath;
          const stated = records.get('size');
          if (stated !== undefined) longSize = Number(stated);
        } else if (type === 'L') {
          const end = meta.indexOf(0);
          longPath = decoder.decode(end === -1 ? meta : meta.subarray(0, end));
        }
        continue;
      }
      // POSIX's ustar holds a prefix of the path; GNU's own format (`ustar  `) holds other things.
      const posix = text(header, 257, 6) === 'ustar' && header[262] === 0;
      const prefix = posix ? text(header, 345, 155) : '';
      const name = text(header, 0, 100);
      const path = longPath ?? (prefix ? `${prefix}/${name}` : name);
      longPath = undefined;
      longSize = undefined;
      const kind =
        type === '0' || type === '\0' || type === '7' ? 'file' : type === '5' ? 'folder' : 'other';
      if (kind === 'file') {
        if (size > most) {
          throw new TarError(`${path} is ${size} bytes: a file of the library is at most ${most}.`);
        }
        const body = (await bytes.exactly(padded)).subarray(0, size);
        yield { path, type: kind, size, bytes: body };
      } else {
        await bytes.skip(padded);
        yield { path, type: kind, size, bytes: new Uint8Array(0) };
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}
