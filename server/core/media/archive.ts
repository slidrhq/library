/**
 * An archive brought into the library (README, "Exporting and importing"): a tar, plain or
 * gzipped, of files of the library at their paths, and the manifest that names them, as the
 * page's export writes it (`src/exportArchive.ts`), or as a copy of the library is when it is put
 * into one (docs/media-library.md of the app, "A copy"). It is how a library that does not reach
 * the network is filled, and kept up, from another.
 *
 * - It adds each file the library lacks, and writes over each it has with other bytes. Every other
 *   file of the library stays as it is: an archive of some parts of a library changes no other.
 * - The catalogs a library's own publications write into it merges into the library's rather than
 *   writing over them (`merged.ts`, `archiveMerge.ts`): the catalog of the designs a design at a
 *   time, the search tags an item at a time, the samples of the templates a language at a time. A
 *   design, an item or a sample the library has and the archive has not stays.
 * - Each file is checked against the archive's manifest, by its size and SHA-256, and the archive
 *   holds every file its manifest names; or nothing is written.
 * - It is written as a publication writes (`writing.ts`): under the lease, what it replaces kept
 *   in the history, the media put back as it was when it fails before the manifest, the cache
 *   emptied of what it wrote, and recorded among the publications. Into an empty media, it is the
 *   library's first publication.
 * - Of the designs, an archive may hold the files of some languages only (the page exports them by
 *   language): those of the library's other languages are written again from the catalog
 *   (`refreshLanguages` of `designFiles.ts`). A library of before has its two catalogs of the
 *   designs made one first (`foldManaged`), and so has an archive of one.
 *
 * The body is read as it comes, a file at a time: an archive of the whole library is some 400 MB.
 */
import type { Context } from '../context.ts';
import { isRecord } from '../http.ts';
import { recordOf, type Recorded } from '../uploads/access.ts';
import { forgetLibrary } from '../uploads/library.ts';
import { mergeHeld } from './archiveMerge.ts';
import type { Purge } from './cache.ts';
import { foldManaged } from './designCatalog.ts';
import { refreshLanguages, writeDesignFiles } from './designFiles.ts';
import { MOST_BYTES } from './files.ts';
import { Lease } from './lease.ts';
import {
  MANIFEST,
  isLibraryPath,
  readManifest,
  sha256Hex,
  toText,
  type Manifest,
  type ManifestEntry,
} from './live.ts';
import { isMerged } from './merged.ts';
import { recordPublication, undo } from './publish.ts';
import { TarError, readTar } from './tar.ts';
import { Writing } from './writing.ts';

/** The largest archive taken: the whole library is some 400 MB. */
export const MOST_ARCHIVE = 8 * 1024 ** 3;

const HASH = /^[0-9a-f]{64}$/;

export class ArchiveRefused extends Error {
  readonly code: string;
  readonly paths: string[];

  constructor(code: string, message: string, paths: string[] = []) {
    super(message);
    this.code = code;
    this.paths = paths;
  }
}

export interface ArchiveImported {
  /** The publication it made; none where the library had every file of it already. */
  published?: string;
  /** When the library the archive was made of was published. */
  from: string;
  /** The files of the library the archive holds, and their bytes. */
  files: number;
  bytes: number;
  added: string[];
  changed: string[];
  /**
   * Files of a language of the designs the catalog no longer has, and the catalog of the designs
   * of before (`foldManaged`).
   */
  removed: string[];
  /** How many files the library had already as they are in the archive. */
  same: number;
  /** What the system that made it leaves beside files (`.DS_Store`, `._…`): left out. */
  skipped: string[];
  cache?: Purge;
}

const mib = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MiB`;

const isEntry = (value: unknown): value is ManifestEntry =>
  isRecord(value) &&
  Number.isInteger(value.size) &&
  (value.size as number) >= 0 &&
  typeof value.sha256 === 'string' &&
  HASH.test(value.sha256);

/** The archive's manifest, which names each of its files with its size and SHA-256. */
function manifestOf(bytes: Uint8Array): Manifest {
  let value: unknown;
  try {
    value = JSON.parse(toText(bytes));
  } catch {
    throw new ArchiveRefused('not-a-library', 'The manifest.json of the archive is not JSON.');
  }
  if (!isRecord(value) || !isRecord(value.files)) {
    throw new ArchiveRefused('not-a-library', 'The manifest.json of the archive is no manifest.');
  }
  const wrong = Object.entries(value.files)
    .filter(([path, entry]) => !isLibraryPath(path) || path === MANIFEST || !isEntry(entry))
    .map(([path]) => path);
  if (wrong.length > 0) {
    throw new ArchiveRefused(
      'not-a-library',
      'The manifest of the archive names what is no file of the library.',
      wrong.slice(0, 50),
    );
  }
  return {
    version: 1,
    published: typeof value.published === 'string' ? value.published : '',
    files: value.files as Manifest['files'],
  };
}

/** Throws where a file of the archive is not the one its manifest names. */
function check(named: Manifest, path: string, file: ManifestEntry) {
  const want = named.files[path];
  if (!want) {
    throw new ArchiveRefused('not-named', 'The archive holds a file its manifest does not name.', [
      path,
    ]);
  }
  if (want.size !== file.size || want.sha256 !== file.sha256) {
    throw new ArchiveRefused(
      'damaged',
      'A file of the archive is not the one its manifest names: the archive is damaged.',
      [path],
    );
  }
}

/** Whether a path of an entry leads out of the folder it is unpacked into. */
const outside = (path: string) =>
  path.startsWith('/') ||
  /^[A-Za-z]:/.test(path) ||
  path.includes('\\') ||
  path.includes('\0') ||
  path.split('/').includes('..');

/** Throws where the disk of a local library's media has no room for what the archive writes. */
async function roomFor(ctx: Context, live: Manifest | undefined, named: Manifest) {
  const room = await ctx.mediaFolder?.room().catch(() => undefined);
  if (!room) return;
  const needed = Object.entries(named.files)
    .filter(([path, file]) => live?.files[path]?.sha256 !== file.sha256)
    .reduce((sum, [, file]) => sum + file.size, 0);
  if (needed > room.free) {
    throw new ArchiveRefused(
      'no-room',
      `The archive writes ${mib(needed)} into the media, and its disk has ${mib(room.free)} free.`,
    );
  }
}

/**
 * The body of a request, read to its end even where its reader stops before: on a machine,
 * letting a request's body go closes its connection, and the answer with it.
 */
function drained(body: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const read = await reader.read();
      if (read.done) controller.close();
      else controller.enqueue(read.value);
    },
    async cancel() {
      try {
        while (!(await reader.read()).done);
      } catch {
        // The request is gone.
      }
    },
  });
}

/**
 * Reads the archive into `writing`: each file checked, and written as it comes; those merged into
 * the library's (`merged.ts`), once it is read whole.
 */
async function unpack(
  ctx: Context,
  live: Manifest | undefined,
  writing: Writing,
  body: ReadableStream<Uint8Array>,
) {
  const received = new Map<string, ManifestEntry>();
  const held = new Map<string, Uint8Array>();
  const skipped: string[] = [];
  let named: Manifest | undefined;
  let same = 0;
  for await (const entry of readTar(body, MOST_BYTES)) {
    const path = entry.path.replace(/^(?:\.\/)+/, '').replace(/\/+$/, '');
    if (path === '' || path === '.' || entry.type === 'folder') continue;
    if (outside(path)) {
      throw new ArchiveRefused('not-a-library', 'The archive names a path outside the library.', [
        entry.path,
      ]);
    }
    if (path.split('/').some((part) => part.startsWith('.'))) {
      skipped.push(path);
      continue;
    }
    if (entry.type !== 'file') {
      throw new ArchiveRefused(
        'not-a-library',
        'The archive holds a link, or another thing that is no file: a library holds files alone.',
        [path],
      );
    }
    if (path === MANIFEST) {
      if (named) throw new ArchiveRefused('twice', 'The archive holds two manifests.', [path]);
      named = manifestOf(entry.bytes);
      for (const [had, file] of received) check(named, had, file);
      await roomFor(ctx, live, named);
      continue;
    }
    if (!isLibraryPath(path)) {
      throw new ArchiveRefused(
        'not-a-library',
        'The archive holds a file that is no file of the library.',
        [path],
      );
    }
    if (received.has(path)) {
      throw new ArchiveRefused('twice', 'The archive holds a file twice.', [path]);
    }
    const sha256 = await sha256Hex(entry.bytes);
    const file = { size: entry.bytes.length, sha256 };
    if (named) check(named, path, file);
    received.set(path, file);
    if (isMerged(path)) held.set(path, entry.bytes);
    else if (!(await writing.put(path, entry.bytes, sha256))) same += 1;
  }
  if (!named) {
    throw new ArchiveRefused(
      'no-manifest',
      'The archive holds no manifest.json: it is no archive of the library.',
    );
  }
  const missing = Object.keys(named.files).filter((path) => !received.has(path));
  if (missing.length > 0) {
    throw new ArchiveRefused(
      'incomplete',
      `The archive lacks ${missing.length} of the files its manifest names.`,
      missing.slice(0, 50),
    );
  }
  if (received.size === 0) {
    throw new ArchiveRefused('empty', 'The archive holds no file of the library.');
  }
  same += await mergeHeld(ctx.media!, writing, held);
  const bytes = [...received.values()].reduce((sum, file) => sum + file.size, 0);
  return { named, files: received.size, bytes, same, skipped };
}

/**
 * Brings an archive into the library of `ctx`, all or none, as `actor`: the whole of `body`,
 * a tar or a gzipped tar. Answers what it wrote, and the publication it made of it.
 */
export async function importArchive(
  ctx: Context,
  actor: Recorded,
  body: ReadableStream<Uint8Array>,
): Promise<ArchiveImported> {
  const { media, state } = ctx;
  if (!media || !state) {
    throw new ArchiveRefused('not-set-up', 'This server has no media to bring an archive into.');
  }
  const source = drained(body);
  let live: Awaited<ReturnType<typeof readManifest>>;
  let lease: Lease;
  try {
    live = await readManifest(media);
    lease = await Lease.take(state, actor);
  } catch (error) {
    // Refused before it is read: the archive is read through all the same, and let go.
    void source.cancel();
    throw error;
  }
  try {
    const writing = new Writing(
      media,
      state,
      lease,
      live ?? { manifest: { version: 1, published: '', files: {} } },
    );
    let unpacked: Awaited<ReturnType<typeof unpack>>;
    try {
      // A library of before has its catalog of the designs in two: it is one first.
      await foldManaged(media, writing);
      unpacked = await unpack(ctx, live?.manifest, writing, source);
      if (writing.written) {
        // What is made of the catalog of the designs, as the archive leaves it.
        await writeDesignFiles(media, writing);
        await refreshLanguages(media, writing);
        await writing.finish();
      }
    } catch (error) {
      await undo(writing);
      if (error instanceof TarError) throw new ArchiveRefused('not-an-archive', error.message);
      throw error;
    }
    const { named, ...counted } = unpacked;
    const result: ArchiveImported = {
      from: named.published,
      ...counted,
      added: writing.added,
      changed: writing.changed,
      removed: writing.removed,
    };
    if (!writing.written) return result;
    forgetLibrary();
    if (ctx.purge) {
      result.cache = await ctx.purge([...result.added, ...result.changed, ...result.removed]);
    }
    result.published = writing.published;
    await recordPublication(state, writing.published, {
      kind: 'archive',
      by: recordOf(actor),
      ...result,
    });
    return result;
  } finally {
    await lease.release();
  }
}
