/**
 * The published library on another server, reached over SFTP (`sftp.ts`) or FTP (`ftp.ts`)
 * (docs/SPEC.md §4.5): a `Bucket` over the little such a server does, a `Remote`: read a file
 * whole, write one whole, take one away, list them all.
 *
 * - Only paths of the library are read or written, under the store's folder.
 * - These servers keep no etag: an object's etag is the SHA-256 of its bytes. A write over a
 *   version (the manifest's, §9.3) reads the file again just before, and compares; the lease keeps
 *   every other publication of the library out meanwhile.
 * - A file's SHA-256, in a list, is the one it was written with while it stays at that size and
 *   moment (`hashes.json` in the cache folder), or the manifest's at that size; otherwise it is
 *   unknown, and a seed copies the file again.
 * - What is read is kept in the cache folder by its SHA-256, filled from the server, or from the
 *   store's public address when it has one, checked against the manifest either way: the library's
 *   `/media/` crosses the network once for each version of a file.
 */
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Bucket, BucketObject, HttpMetadata } from '../../core/bucket.ts';
import {
  MANIFEST,
  PROBE,
  cacheControl,
  contentType,
  encodedPath,
  isLibraryPath,
} from '../../core/media/live.ts';

/** A file of the store, by its path in its folder. */
export interface RemoteFile {
  path: string;
  size: number;
  /** When it was last written, in milliseconds; 0 where the server does not say. */
  mtime: number;
}

/** What the library needs of a server. Each path is one of the library's, under the folder. */
export interface Remote {
  /** A file's bytes; none when it is not there. */
  read(path: string): Promise<Uint8Array | undefined>;
  /** Writes a file whole: under a hidden name in its folder, made as needed, then renamed. */
  write(path: string, bytes: Uint8Array): Promise<RemoteFile>;
  /** Takes a file away; one not there is no matter. */
  remove(path: string): Promise<void>;
  /** Every file under the folder, the hidden ones aside. */
  list(): Promise<RemoteFile[]>;
  close(): Promise<void>;
}

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

const bytesOf = (value: string | ArrayBuffer | Uint8Array) =>
  typeof value === 'string'
    ? new TextEncoder().encode(value)
    : value instanceof Uint8Array
      ? value
      : new Uint8Array(value);

/** Whether a key is one of the store's: the manifest, a path of the library, or the probe. */
const isKey = (key: string) => key === MANIFEST || key === PROBE || isLibraryPath(key);

/** How long the manifest read is trusted for the hashes of the files it names. */
const MANIFEST_MS = 10_000;
/** How long after a write the hashes written are kept on disk. */
const SAVE_MS = 2_000;

type Entries = Record<string, { size: number; sha256: string }>;

export class RemoteMedia implements Bucket {
  private readonly remote: Remote;
  private readonly cache: string;
  private readonly publicUrl?: string;
  private manifest?: { at: number; files: Entries };
  private hashes?: Map<string, { size: number; mtime: number; sha256: string }>;
  private saving?: NodeJS.Timeout;

  /** `cache`: a folder of this machine, the store's own. */
  constructor(remote: Remote, cache: string, publicUrl?: string) {
    this.remote = remote;
    this.cache = cache;
    this.publicUrl = publicUrl?.replace(/\/?$/, '/');
  }

  private http = (key: string): HttpMetadata => ({
    contentType: contentType(key),
    cacheControl: cacheControl(key),
  });

  private object(key: string, data: Uint8Array, hash: string): BucketObject {
    return {
      etag: hash,
      size: data.length,
      body: new Blob([data as Uint8Array<ArrayBuffer>]).stream(),
      httpMetadata: this.http(key),
      customMetadata: { sha256: hash },
      text: () => Promise.resolve(new TextDecoder().decode(data)),
      arrayBuffer: () => Promise.resolve(data.slice().buffer),
    };
  }

  // ---- What is kept on this machine

  private cached = (hash: string) => join(this.cache, 'files', hash.slice(0, 2), hash);

  private async fromCache(hash: string) {
    try {
      const data = new Uint8Array(await readFile(this.cached(hash)));
      return sha256(data) === hash ? data : undefined;
    } catch {
      return undefined;
    }
  }

  private async toCache(hash: string, data: Uint8Array) {
    const file = this.cached(hash);
    await mkdir(dirname(file), { recursive: true });
    const temp = `${file}.${randomUUID()}`;
    await writeFile(temp, data);
    await rename(temp, file);
  }

  private async hashIndex() {
    if (!this.hashes) {
      try {
        const held = JSON.parse(await readFile(join(this.cache, 'hashes.json'), 'utf8')) as Record<
          string,
          { size: number; mtime: number; sha256: string }
        >;
        this.hashes = new Map(Object.entries(held));
      } catch {
        this.hashes = new Map();
      }
    }
    return this.hashes;
  }

  /** Keeps the hashes written on disk, a moment after the last write. */
  private saveSoon() {
    clearTimeout(this.saving);
    this.saving = setTimeout(() => void this.save(), SAVE_MS);
    this.saving.unref();
  }

  private async save() {
    clearTimeout(this.saving);
    if (!this.hashes) return;
    await mkdir(this.cache, { recursive: true });
    const file = join(this.cache, 'hashes.json');
    const temp = `${file}.${randomUUID()}`;
    await writeFile(temp, JSON.stringify(Object.fromEntries(this.hashes)));
    await rename(temp, file);
  }

  /** The files the manifest names, read again when it is older than a few seconds. */
  private async entries(): Promise<Entries> {
    if (!this.manifest || Date.now() - this.manifest.at > MANIFEST_MS) await this.get(MANIFEST);
    return this.manifest?.files ?? {};
  }

  private remember(data: Uint8Array) {
    try {
      const parsed = JSON.parse(new TextDecoder().decode(data)) as { files?: Entries };
      this.manifest = { at: Date.now(), files: parsed.files ?? {} };
    } catch {
      this.manifest = { at: Date.now(), files: {} };
    }
  }

  /** A file of the library from its public address, when it is the one the manifest names. */
  private async fromPublic(key: string, hash: string) {
    if (!this.publicUrl) return undefined;
    try {
      const response = await fetch(this.publicUrl + encodedPath(key));
      if (!response.ok) return undefined;
      const data = new Uint8Array(await response.arrayBuffer());
      return sha256(data) === hash ? data : undefined;
    } catch {
      return undefined;
    }
  }

  // ---- The bucket

  async get(key: string): Promise<BucketObject | null> {
    if (!isKey(key)) return null;
    if (key === MANIFEST) {
      const data = await this.remote.read(key);
      if (!data) {
        this.manifest = { at: Date.now(), files: {} };
        return null;
      }
      this.remember(data);
      return this.object(key, data, sha256(data));
    }
    const named = (await this.entries())[key];
    if (named) {
      const data =
        (await this.fromCache(named.sha256)) ??
        (await this.fromPublic(key, named.sha256)) ??
        (await this.remote.read(key));
      if (!data) return null;
      const hash = sha256(data);
      if (hash === named.sha256) await this.toCache(hash, data);
      return this.object(key, data, hash);
    }
    const data = await this.remote.read(key);
    return data ? this.object(key, data, sha256(data)) : null;
  }

  async put(
    key: string,
    value: string | ArrayBuffer | Uint8Array,
    options: Parameters<Bucket['put']>[2] = {},
  ): Promise<{ etag: string } | null> {
    if (!isKey(key)) throw new Error(`Not a path of the library: ${JSON.stringify(key)}`);
    const wanted = options.onlyIf?.etagMatches;
    if (wanted !== undefined) {
      // Read again, just before: these servers keep no version of their own.
      const now = await this.remote.read(key);
      if ((now ? sha256(now) : undefined) !== wanted) return null;
    }
    const data = bytesOf(value);
    const hash = options.customMetadata?.sha256 ?? sha256(data);
    const written = await this.remote.write(key, data);
    if (key === PROBE) return { etag: hash };
    (await this.hashIndex()).set(key, { size: written.size, mtime: written.mtime, sha256: hash });
    this.saveSoon();
    await this.toCache(hash, data);
    if (key === MANIFEST) this.remember(data);
    return { etag: hash };
  }

  async delete(keys: string | string[]): Promise<void> {
    for (const key of Array.isArray(keys) ? keys : [keys]) {
      if (!isKey(key)) continue;
      await this.remote.remove(key);
      (await this.hashIndex()).delete(key);
    }
    this.saveSoon();
  }

  async list(options: Parameters<Bucket['list']>[0] = {}) {
    const prefix = options.prefix ?? '';
    const limit = options.limit ?? 1000;
    const files = (await this.remote.list())
      .filter((file) => isKey(file.path) && file.path !== PROBE && file.path.startsWith(prefix))
      .filter((file) => options.startAfter === undefined || file.path > options.startAfter)
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    const page = files.slice(0, limit);
    const include = options.include ?? [];
    const hashes = include.includes('customMetadata') ? await this.hashIndex() : undefined;
    const named = hashes ? await this.entries() : {};
    return {
      objects: page.map((file) => {
        const held = hashes?.get(file.path);
        const known =
          held && held.size === file.size && held.mtime === file.mtime
            ? held.sha256
            : named[file.path]?.size === file.size && file.path !== MANIFEST
              ? named[file.path]!.sha256
              : undefined;
        return {
          key: file.path,
          ...(include.includes('httpMetadata') ? { httpMetadata: this.http(file.path) } : {}),
          ...(known ? { customMetadata: { sha256: known } } : {}),
        };
      }),
      truncated: files.length > limit,
    };
  }

  /** Lets the server go, keeping the hashes written. */
  async close(): Promise<void> {
    await this.save();
    await this.remote.close();
  }
}
