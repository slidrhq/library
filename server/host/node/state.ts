/**
 * The library's own store on a machine (`StateStore` of `../../core/context.ts`): a folder,
 * answering as a bucket of R2 answers on Cloudflare (`../../core/bucket.ts`).
 *
 *   <root>/objects/<key>          each object's bytes, under its key
 *   <root>/meta/<key>.json        its etag (the SHA-256 of its bytes), size, type and metadata
 *   <root>/tmp/                   what is being written
 *
 * Each part of a key is kept as a name every file system takes, and tells apart what one that
 * ignores case would not (`partName`). An object is written to `tmp/` and renamed into place, so
 * it is never read half written. One process serves a data folder, and what it does to a key
 * waits for what it was doing to it before, so a conditional write is atomic.
 */
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Bucket, BucketObject } from '../../core/bucket.ts';

interface Meta {
  etag: string;
  size: number;
  contentType?: string;
  customMetadata?: Record<string, string>;
}

/** Names Windows keeps for its devices, which no file may take, whatever its extension. */
const DEVICE = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\.|$)/i;

const escape = (char: string) =>
  `%${char.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`;

/**
 * A part of a key as a file's name: what `encodeURIComponent` leaves, but for capitals (which a
 * file system that ignores case would take for small letters), `*`, a name of a device, and a
 * final dot, which Windows refuses.
 */
export function partName(part: string): string {
  let name = '';
  for (const char of part) name += /[A-Z*]/.test(char) ? escape(char) : encodeURIComponent(char);
  if (DEVICE.test(name)) name = escape(name[0]!) + name.slice(1);
  if (name.endsWith('.')) name = `${name.slice(0, -1)}%2E`;
  return name;
}

/** The parts of a key, refused when it is no key of an object. */
function partsOf(key: string): string[] {
  const parts = key.split('/');
  if (!key || parts.some((part) => part === '' || part === '.' || part === '..')) {
    throw new Error(`Not a key of the store: ${JSON.stringify(key)}`);
  }
  return parts;
}

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

const bytesOf = (value: string | ArrayBuffer | Uint8Array) =>
  typeof value === 'string'
    ? new TextEncoder().encode(value)
    : value instanceof Uint8Array
      ? value
      : new Uint8Array(value);

const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';

/** A rename, tried again while Windows holds the file (an antivirus, an indexer). */
async function replace(from: string, to: string) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(from, to);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (attempt >= 5 || (code !== 'EPERM' && code !== 'EACCES' && code !== 'EBUSY')) throw error;
      await new Promise((resolve) => setTimeout(resolve, 20 * 2 ** attempt));
    }
  }
}

export class FolderBucket implements Bucket {
  private readonly root: string;
  private readonly busy = new Map<string, Promise<unknown>>();

  constructor(root: string) {
    this.root = root;
  }

  private objectFile(key: string) {
    return join(this.root, 'objects', ...partsOf(key).map(partName));
  }

  private metaFile(key: string) {
    const parts = partsOf(key).map(partName);
    parts[parts.length - 1] += '.json';
    return join(this.root, 'meta', ...parts);
  }

  /** Does `work` on a key once what was being done to it is done. */
  private async exclusive<T>(key: string, work: () => Promise<T>): Promise<T> {
    const before = this.busy.get(key) ?? Promise.resolve();
    const mine = before.then(work, work);
    const settled = mine.catch(() => undefined);
    this.busy.set(key, settled);
    try {
      return await mine;
    } finally {
      if (this.busy.get(key) === settled) this.busy.delete(key);
    }
  }

  /** Writes a file whole: into `tmp/`, then renamed into place. */
  private async writeWhole(file: string, data: Uint8Array | string) {
    const temp = join(this.root, 'tmp', randomUUID());
    await mkdir(dirname(temp), { recursive: true });
    await writeFile(temp, data);
    await mkdir(dirname(file), { recursive: true });
    await replace(temp, file);
  }

  /** An object's bytes and what is known of them; none when there is no such object. */
  private async read(key: string): Promise<{ data: Uint8Array; meta: Meta } | undefined> {
    let data: Uint8Array;
    try {
      data = await readFile(this.objectFile(key));
    } catch (error) {
      if (missing(error)) return undefined;
      throw error;
    }
    let meta: Meta | undefined;
    try {
      meta = JSON.parse(await readFile(this.metaFile(key), 'utf8')) as Meta;
    } catch (error) {
      if (!missing(error) && !(error instanceof SyntaxError)) throw error;
    }
    // Bytes written without the metadata after them (the process stopped between the two) are
    // known by their own hash.
    if (!meta || meta.size !== data.length) meta = { etag: sha256(data), size: data.length };
    return { data, meta };
  }

  get(key: string): Promise<BucketObject | null> {
    return this.exclusive(key, async () => {
      const found = await this.read(key);
      if (!found) return null;
      const { data, meta } = found;
      return {
        etag: meta.etag,
        size: meta.size,
        body: new Blob([data as Uint8Array<ArrayBuffer>]).stream(),
        httpMetadata: { contentType: meta.contentType },
        customMetadata: meta.customMetadata,
        text: () => Promise.resolve(new TextDecoder().decode(data)),
        arrayBuffer: () => Promise.resolve(data.slice().buffer),
      };
    });
  }

  put(
    key: string,
    value: string | ArrayBuffer | Uint8Array,
    options: Parameters<Bucket['put']>[2] = {},
  ): Promise<{ etag: string } | null> {
    return this.exclusive(key, async () => {
      const wanted = options.onlyIf?.etagMatches;
      if (wanted !== undefined && (await this.read(key))?.meta.etag !== wanted) return null;
      const data = bytesOf(value);
      const meta: Meta = {
        etag: sha256(data),
        size: data.length,
        ...(options.httpMetadata?.contentType
          ? { contentType: options.httpMetadata.contentType }
          : {}),
        ...(options.customMetadata ? { customMetadata: options.customMetadata } : {}),
      };
      await this.writeWhole(this.objectFile(key), data);
      await this.writeWhole(this.metaFile(key), JSON.stringify(meta));
      return { etag: meta.etag };
    });
  }

  async delete(keys: string | string[]): Promise<void> {
    for (const key of Array.isArray(keys) ? keys : [keys]) {
      await this.exclusive(key, async () => {
        await rm(this.objectFile(key), { force: true });
        await rm(this.metaFile(key), { force: true });
      });
    }
  }

  /** Every key under a folder of `objects/`, whose parts so far are `parts`. */
  private async keysUnder(parts: string[]): Promise<string[]> {
    let entries;
    try {
      entries = await readdir(join(this.root, 'objects', ...parts.map(partName)), {
        withFileTypes: true,
      });
    } catch (error) {
      if (missing(error)) return [];
      throw error;
    }
    const keys: string[] = [];
    for (const entry of entries) {
      let part: string;
      try {
        part = decodeURIComponent(entry.name);
      } catch {
        continue; // Not a name the store gave: nothing of it.
      }
      if (entry.isDirectory()) keys.push(...(await this.keysUnder([...parts, part])));
      else if (entry.isFile()) keys.push([...parts, part].join('/'));
    }
    return keys;
  }

  async list(options: Parameters<Bucket['list']>[0] = {}) {
    const prefix = options.prefix ?? '';
    const limit = options.limit ?? 1000;
    // Only the folder the prefix is surely in is read.
    const folder = prefix.split('/').slice(0, -1);
    const keys = (await this.keysUnder(folder))
      .filter((key) => key.startsWith(prefix))
      .filter((key) => options.startAfter === undefined || key > options.startAfter)
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const page = keys.slice(0, limit);
    const withMeta = options.include?.includes('customMetadata') ?? false;
    const objects = [];
    for (const key of page) {
      const meta = withMeta ? (await this.read(key))?.meta : undefined;
      objects.push(meta?.customMetadata ? { key, customMetadata: meta.customMetadata } : { key });
    }
    return { objects, truncated: keys.length > limit };
  }
}
