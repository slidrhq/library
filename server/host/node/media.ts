/**
 * The published library in a folder of this machine (docs/SPEC.md §4.5): the media store of a
 * library on a machine, as the bucket `MEDIA` is on Cloudflare. The folder is the library itself,
 * every file under its own path and `manifest.json` beside them, and nothing else, so any web
 * server may publish it as it is.
 *
 * - A file is written to a hidden name in its own folder and renamed into place, so no reader ever
 *   sees half of it.
 * - No path leaves the folder: only paths of the library are taken, and a link is never followed.
 * - A file's SHA-256 is the manifest's, when the manifest names it at its size; otherwise it is
 *   read, once, and kept while the file stays as it was. Its etag is its size and the moment it
 *   was written, as a web server's is; one process writes the folder, and what it does to a path
 *   waits for what it was doing to it before, so a conditional write is atomic.
 */
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import type { Bucket, BucketObject, HttpMetadata } from '../../core/bucket.ts';
import {
  MANIFEST,
  PROBE,
  cacheControl,
  contentType,
  isLibraryPath,
} from '../../core/media/live.ts';

/** Hidden names of what is being written; a list of the library never shows them. */
const TEMP = '.slidr-';

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

const bytesOf = (value: string | ArrayBuffer | Uint8Array) =>
  typeof value === 'string'
    ? new TextEncoder().encode(value)
    : value instanceof Uint8Array
      ? value
      : new Uint8Array(value);

const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';

/** A path that the system resolves outside the library, through a link. */
export class OutsideLibrary extends Error {}

/**
 * Whether a key is one of the folder's: the manifest, a path of the library, or the hidden file a
 * test of the folder writes and takes away.
 */
const isKey = (key: string) => key === MANIFEST || key === PROBE || isLibraryPath(key);

export class FolderMedia implements Bucket {
  readonly root: string;
  private readonly busy = new Map<string, Promise<unknown>>();
  /** The SHA-256 of files read, while they stay at the size and moment they were read at. */
  private readonly hashes = new Map<string, { etag: string; sha256: string }>();
  private manifest?: { etag: string; files: Record<string, { size: number; sha256: string }> };

  constructor(root: string) {
    this.root = resolve(root);
  }

  /** The file of a key; throws for a key that is no path of the library. */
  private fileOf(key: string) {
    if (!isKey(key)) throw new Error(`Not a path of the library: ${JSON.stringify(key)}`);
    const file = resolve(this.root, ...key.split('/'));
    if (!file.startsWith(this.root + sep)) throw new Error(`Outside the library: ${key}`);
    return file;
  }

  private realRoot?: string;

  /**
   * Throws when the folder of a file is not in the library as the system resolves it: a link to a
   * folder elsewhere leads nowhere.
   */
  private async inside(file: string) {
    this.realRoot ??= await realpath(this.root);
    let dir = dirname(file);
    for (;;) {
      try {
        const real = await realpath(dir);
        if (real !== this.realRoot && !real.startsWith(this.realRoot + sep)) {
          throw new OutsideLibrary(`Outside the library: ${file}`);
        }
        return;
      } catch (error) {
        // A folder not made yet: its parent says where it would be.
        if (error instanceof OutsideLibrary || !missing(error) || dir === this.root) throw error;
        dir = dirname(dir);
      }
    }
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

  /** A file's size and the moment it was written; none when it is not a plain file there. */
  private async statOf(key: string) {
    try {
      const file = this.fileOf(key);
      await this.inside(file);
      const found = await lstat(file);
      if (!found.isFile()) return undefined;
      return { size: found.size, etag: `${found.size.toString(16)}-${found.mtimeMs.toString(16)}` };
    } catch (error) {
      // What is not in the library, as far as reading goes, is not there.
      if (missing(error) || error instanceof OutsideLibrary) return undefined;
      throw error;
    }
  }

  /** The manifest's entries, read again when the manifest changed. */
  private async entries() {
    const stat = await this.statOf(MANIFEST);
    if (!stat) return {};
    if (this.manifest?.etag !== stat.etag) {
      try {
        const parsed = JSON.parse(await readFile(this.fileOf(MANIFEST), 'utf8')) as {
          files?: Record<string, { size: number; sha256: string }>;
        };
        this.manifest = { etag: stat.etag, files: parsed.files ?? {} };
      } catch {
        this.manifest = { etag: stat.etag, files: {} };
      }
    }
    return this.manifest.files;
  }

  /** A file's SHA-256: the manifest's, or its own, read once. */
  private async hashOf(key: string, stat: { size: number; etag: string }, bytes?: Uint8Array) {
    const named = key === MANIFEST ? undefined : (await this.entries())[key];
    if (named && named.size === stat.size) return named.sha256;
    const held = this.hashes.get(key);
    if (held?.etag === stat.etag) return held.sha256;
    const hash = sha256(bytes ?? (await readFile(this.fileOf(key))));
    this.hashes.set(key, { etag: stat.etag, sha256: hash });
    return hash;
  }

  private http = (key: string): HttpMetadata => ({
    contentType: contentType(key),
    cacheControl: cacheControl(key),
  });

  get(key: string): Promise<BucketObject | null> {
    if (!isKey(key)) return Promise.resolve(null);
    return this.exclusive(key, async () => {
      const stat = await this.statOf(key);
      if (!stat) return null;
      let data: Uint8Array;
      try {
        data = await readFile(this.fileOf(key));
      } catch (error) {
        if (missing(error)) return null;
        throw error;
      }
      return {
        etag: stat.etag,
        size: data.length,
        body: new Blob([data as Uint8Array<ArrayBuffer>]).stream(),
        httpMetadata: this.http(key),
        customMetadata: { sha256: await this.hashOf(key, stat, data) },
        text: () => Promise.resolve(new TextDecoder().decode(data)),
        arrayBuffer: () => Promise.resolve(data.slice().buffer),
      };
    });
  }

  async put(
    key: string,
    value: string | ArrayBuffer | Uint8Array,
    options: Parameters<Bucket['put']>[2] = {},
  ): Promise<{ etag: string } | null> {
    const file = this.fileOf(key);
    return this.exclusive(key, async () => {
      const wanted = options.onlyIf?.etagMatches;
      if (wanted !== undefined && (await this.statOf(key))?.etag !== wanted) return null;
      const data = bytesOf(value);
      // The library's first file makes its folder.
      await mkdir(this.root, { recursive: true });
      await this.inside(file);
      await mkdir(dirname(file), { recursive: true });
      await this.inside(file);
      const temp = join(dirname(file), `${TEMP}${randomUUID()}`);
      await writeFile(temp, data);
      await rename(temp, file);
      const stat = await this.statOf(key);
      if (!stat) throw new Error(`${key} was not written.`);
      const hash = options.customMetadata?.sha256 ?? sha256(data);
      this.hashes.set(key, { etag: stat.etag, sha256: hash });
      return { etag: stat.etag };
    });
  }

  async delete(keys: string | string[]): Promise<void> {
    for (const key of Array.isArray(keys) ? keys : [keys]) {
      if (!isKey(key)) continue;
      await this.exclusive(key, async () => {
        const file = this.fileOf(key);
        try {
          await this.inside(file);
        } catch (error) {
          if (error instanceof OutsideLibrary) return;
          throw error;
        }
        await rm(file, { force: true });
        this.hashes.delete(key);
      });
    }
  }

  /** Every path under a folder of the library, whose parts so far are `parts`. */
  private async pathsUnder(parts: string[]): Promise<string[]> {
    let entries;
    try {
      entries = await readdir(join(this.root, ...parts), { withFileTypes: true });
    } catch (error) {
      if (missing(error)) return [];
      throw error;
    }
    const paths: string[] = [];
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const path = [...parts, entry.name].join('/');
      if (entry.isDirectory()) paths.push(...(await this.pathsUnder([...parts, entry.name])));
      else if (entry.isFile() && isKey(path)) paths.push(path);
    }
    return paths;
  }

  async list(options: Parameters<Bucket['list']>[0] = {}) {
    const prefix = options.prefix ?? '';
    const limit = options.limit ?? 1000;
    const folder = prefix.split('/').slice(0, -1);
    const keys = (await this.pathsUnder(folder))
      .filter((key) => key.startsWith(prefix))
      .filter((key) => options.startAfter === undefined || key > options.startAfter)
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const page = keys.slice(0, limit);
    const include = options.include ?? [];
    const objects = [];
    for (const key of page) {
      const stat = include.includes('customMetadata') ? await this.statOf(key) : undefined;
      objects.push({
        key,
        ...(include.includes('httpMetadata') ? { httpMetadata: this.http(key) } : {}),
        ...(stat ? { customMetadata: { sha256: await this.hashOf(key, stat) } } : {}),
      });
    }
    return { objects, truncated: keys.length > limit };
  }
}
