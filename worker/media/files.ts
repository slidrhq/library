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
 */
import {
  HISTORY,
  MANIFEST,
  encodeManifest,
  isLibraryPath,
  readManifest,
  sha256Hex,
  toBytes,
  type ManifestEntry,
} from './live.ts';
import type { Actor } from '../uploads/access.ts';
import type { Bucket } from '../uploads/store.ts';
import { forgetLibrary } from '../uploads/library.ts';
import { LOCK, contentType } from './live.ts';
import { NotNow, lock } from './publish.ts';

export const STAGED = '_staged';
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

/** Publishes an author's changed files into the library, all or none. */
export async function publishFiles(
  bucket: Bucket,
  actor: Actor,
  files: unknown,
): Promise<FilesPublished> {
  const changes = readChanges(files);
  const live = await readManifest(bucket);
  if (!live) {
    throw new NotNow(
      'not-live',
      'The library is not in its bucket yet: bring it in first (POST /api/library/import).',
    );
  }
  await lock(bucket, actor);
  try {
    const { manifest, etag } = live;
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
        const held = await bucket.get(stagedKey(change.to.sha256));
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

    const published = new Date().toISOString();
    const history = `${HISTORY}/${published}`;
    await bucket.put(`${history}/${MANIFEST}`, encodeManifest(manifest), {
      httpMetadata: { contentType: 'application/json' },
    });
    const next = { ...manifest.files };
    for (const [path, change] of writes) {
      if (next[path]) {
        const old = await bucket.get(path);
        if (old) await bucket.put(`${history}/${path}`, await old.arrayBuffer());
      }
      if (change.to) {
        const staged = await bucket.get(stagedKey(change.to.sha256));
        if (!staged) throw new Refused('not-staged', 'A staged file went missing.', [path]);
        const bytes = await staged.arrayBuffer();
        if (bytes.byteLength !== change.to.size) {
          throw new Refused('bad-request', 'A file is not of the size named for it.', [path]);
        }
        await bucket.put(path, bytes, {
          httpMetadata: { contentType: contentType(path) },
          customMetadata: { sha256: change.to.sha256 },
        });
        (next[path] ? result.changed : result.added).push(path);
        next[path] = { size: change.to.size, sha256: change.to.sha256 };
      } else {
        await bucket.delete(path);
        delete next[path];
        result.removed.push(path);
      }
    }
    const text = encodeManifest({ version: 1, published, files: next });
    const written = await bucket.put(MANIFEST, text, {
      httpMetadata: { contentType: 'application/json' },
      customMetadata: { sha256: await sha256Hex(toBytes(text)) },
      onlyIf: { etagMatches: etag },
    });
    if (!written)
      throw new NotNow('changed-meanwhile', 'The library was published meanwhile. Try again.');
    const used = [
      ...new Set(writes.flatMap(([, change]) => (change.to ? [stagedKey(change.to.sha256)] : []))),
    ];
    if (used.length > 0) await bucket.delete(used);
    forgetLibrary();
    result.published = published;
    return result;
  } finally {
    await bucket.delete(LOCK);
  }
}
