/**
 * A publication of an author's files: what the app's generators write (the catalogs of icons,
 * frames and designs, the templates, the fonts), published by `pnpm media:publish` of the app
 * from an author's copy, through the API, into the library in its bucket (`live.ts`). Nothing is
 * deployed to Pages any more, and nothing of the library is replaced but the files changed.
 *
 *   PUT  /api/library/staged/<sha256>    a file's bytes, kept by their hash until a publication
 *   POST /api/library/files              the publication: each path, the file it was, and the
 *                                        file it is to be (or none, to take it away)
 *
 * A publication names, for each path, the file the author changed (`from`: the hash the author's
 * copy was pulled with, none for a new file). A path the library changed meanwhile, as an upload
 * that was published, is a conflict, and nothing is written: the author pulls, and publishes
 * again. A path the author did not change is not named, and stays as the library has it.
 *
 * The staged files, the history and the lease are kept beside the uploads (`state`), as a
 * publication of uploads keeps them (`live.ts`). It writes as that does (`writing.ts`): the media
 * is put back as it was when it fails before the manifest; and the cache is emptied of what was
 * written.
 */
import { MANIFEST, isLibraryPath, readManifest, sha256Hex, type ManifestEntry } from './live.ts';
import { recordOf, type Actor } from '../uploads/access.ts';
import type { Bucket } from '../bucket.ts';
import { forgetLibrary } from '../uploads/library.ts';
import type { Purge, Purger } from './cache.ts';
import { writeDesignFiles } from './designFiles.ts';
import { Lease, NotNow } from './lease.ts';
import { recordPublication, undo } from './publish.ts';
import { Writing } from './writing.ts';

/** In the bucket of the uploads. */
export const STAGED = 'media/staged';
/** The largest file: a catalog of all the designs in every language is some 43 MB. */
export const MOST_BYTES = 95 * 1024 * 1024;
const HASH = /^[0-9a-f]{64}$/;

export const stagedKey = (sha256: string) => `${STAGED}/${sha256}`;

export class Refused extends Error {
  readonly code: string;
  readonly paths: string[];

  constructor(code: string, message: string, paths: string[] = []) {
    super(message);
    this.code = code;
    this.paths = paths;
  }
}

/** Keeps a file's bytes by their hash, checked against it. Whether the bucket had them already. */
export async function stage(bucket: Bucket, sha256: string, bytes: Uint8Array) {
  if (!HASH.test(sha256)) throw new Refused('bad-hash', 'A file is staged by its SHA-256, in hex.');
  if ((await sha256Hex(bytes)) !== sha256) {
    throw new Refused('bad-hash', 'The bytes are not those of the hash they were sent under.');
  }
  const held = await bucket.get(stagedKey(sha256));
  if (held) {
    await held.body.cancel();
    return { sha256, size: bytes.length, already: true };
  }
  await bucket.put(stagedKey(sha256), bytes, { customMetadata: { sha256 } });
  return { sha256, size: bytes.length, already: false };
}

/** What a publication of files does to one path. */
export interface FileChange {
  /** The hash of the file the author changed; none for a file the library did not have. */
  from: string | null;
  /** The file it is to be; none to take it away. */
  to: ManifestEntry | null;
}

export interface FilesPublished {
  published?: string;
  added: string[];
  changed: string[];
  removed: string[];
  /** Paths the library already had as they are to be. */
  same: string[];
  /** What became of the cache before the library, once something was written. */
  cache?: Purge;
}

function readChanges(value: unknown): Record<string, FileChange> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Refused(
      'bad-request',
      'files names each path, { "from": …, "to": { "size", "sha256" } | null }.',
    );
  }
  const changes: Record<string, FileChange> = {};
  const wrong: string[] = [];
  for (const [path, change] of Object.entries(value as Record<string, unknown>)) {
    const { from, to } = (change ?? {}) as { from?: unknown; to?: unknown };
    const okFrom = from === null || (typeof from === 'string' && HASH.test(from));
    const entry = to as ManifestEntry | null | undefined;
    const okTo =
      entry === null ||
      (typeof entry === 'object' &&
        entry !== undefined &&
        Number.isInteger(entry.size) &&
        entry.size >= 0 &&
        typeof entry.sha256 === 'string' &&
        HASH.test(entry.sha256));
    if (!isLibraryPath(path) || path === MANIFEST || !okFrom || !okTo) wrong.push(path);
    else changes[path] = { from: from, to: entry };
  }
  if (wrong.length > 0) {
    throw new Refused(
      'bad-request',
      'Paths of the library, each with the hash it was and the file it is to be.',
      wrong,
    );
  }
  if (Object.keys(changes).length === 0)
    throw new Refused('bad-request', 'Name one file at least.');
  return changes;
}

/**
 * Publishes an author's changed files into the library in `media`, all or none, from the files
 * staged in `state`; then empties the cache of what it wrote (`purge`).
 */
export async function publishFiles(
  media: Bucket,
  state: Bucket,
  actor: Actor,
  files: unknown,
  purge?: Purger,
): Promise<FilesPublished> {
  const changes = readChanges(files);
  const live = await readManifest(media);
  if (!live) {
    throw new NotNow(
      'not-live',
      'The library is not in its bucket yet: bring it in first (POST /api/library/import).',
    );
  }
  const lease = await Lease.take(state, actor);
  try {
    const { manifest } = live;
    const result: FilesPublished = { added: [], changed: [], removed: [], same: [] };
    const conflicts: string[] = [];
    const missing: string[] = [];
    const writes: [string, FileChange][] = [];
    for (const [path, change] of Object.entries(changes).sort(([a], [b]) => (a < b ? -1 : 1))) {
      const now = manifest.files[path]?.sha256 ?? null;
      const wanted = change.to?.sha256 ?? null;
      if (now === wanted) {
        result.same.push(path);
        continue;
      }
      if (now !== change.from) {
        conflicts.push(path);
        continue;
      }
      if (change.to) {
        const held = await state.get(stagedKey(change.to.sha256));
        if (!held) missing.push(path);
        else await held.body.cancel();
      }
      writes.push([path, change]);
    }
    if (conflicts.length > 0) {
      throw new Refused(
        'conflict',
        'The library changed these files since the copy was pulled: pull, and publish again.',
        conflicts,
      );
    }
    if (missing.length > 0) {
      throw new Refused(
        'not-staged',
        'These files were not sent first (PUT /api/library/staged/<sha256>).',
        missing,
      );
    }
    if (writes.length === 0) return result;

    const writing = new Writing(media, state, lease, live);
    try {
      for (const [path, change] of writes) {
        if (!change.to) {
          await writing.remove(path);
          continue;
        }
        const staged = await state.get(stagedKey(change.to.sha256));
        if (!staged) throw new Refused('not-staged', 'A staged file went missing.', [path]);
        const bytes = new Uint8Array(await staged.arrayBuffer());
        if (bytes.byteLength !== change.to.size) {
          throw new Refused('bad-request', 'A file is not of the size named for it.', [path]);
        }
        await writing.put(path, bytes, change.to.sha256);
      }
      // What is made of the catalogs of the designs, as the files leave them (`designFiles.ts`).
      await writeDesignFiles(media, writing);
      await writing.finish();
    } catch (error) {
      await undo(writing);
      throw error;
    }
    const { published } = writing;
    result.added.push(...writing.added);
    result.changed.push(...writing.changed);
    result.removed.push(...writing.removed);
    const used = [
      ...new Set(writes.flatMap(([, change]) => (change.to ? [stagedKey(change.to.sha256)] : []))),
    ];
    if (used.length > 0) await state.delete(used);
    forgetLibrary();
    if (purge) result.cache = await purge([...result.added, ...result.changed, ...result.removed]);
    result.published = published;
    await recordPublication(state, published, { kind: 'files', by: recordOf(actor), ...result });
    return result;
  } finally {
    await lease.release();
  }
}
