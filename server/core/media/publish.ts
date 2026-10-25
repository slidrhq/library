/**
 * A publication: the accepted uploads, written into the published library in its bucket
 * (`live.ts`), and then marked published. Nothing is copied to a machine or staged elsewhere:
 * each file an upload changes is read from the bucket, changed (`merge.ts`) and written back, and
 * the manifest, written last, says what the library is now. The app reads it the next time it
 * reads the manifest.
 *
 * - Each upload is checked once more, against the library as it is (as accepting it did), and
 *   one that no longer holds stays accepted, saying why. So does one that cannot be written.
 * - What a publication replaces is kept beside the uploads, under `media/history/<published>/`:
 *   the manifest before it, and each file it wrote over.
 * - One publication runs at a time (`media/lock.json`, beside the uploads too); the manifest is
 *   written only over the one read at the start, so two never write over each other.
 * - Once the manifest is written, the cache before the library is emptied of the files written
 *   (`cache.ts`).
 */
import type { Bucket } from '../bucket.ts';
import type { Issue } from '../http.ts';
import type { Actor } from '../uploads/access.ts';
import { handlerOf } from '../uploads/content.ts';
import { forgetLibrary, type Library } from '../uploads/library.ts';
import { listUploads, readFile, readUpload, saveUpload, type Upload } from '../uploads/store.ts';
import type { Purge, Purger } from './cache.ts';
import {
  HISTORY,
  LOCK,
  MANIFEST,
  encodeManifest,
  putFile,
  putManifest,
  readBytes,
  readManifest,
  sha256Hex,
  toBytes,
  toText,
  type Manifest,
} from './live.ts';
import {
  MANAGED,
  PublishError,
  TEMPLATES,
  designOf,
  emptyCatalog,
  encodeTags,
  mergeDesign,
  mergeTags,
  mergeTranslation,
  spliceSample,
  tagsPath,
  type ManagedCatalog,
} from './merge.ts';

/** The most uploads one publication takes: the rest wait for the next. */
export const MOST_UPLOADS = 50;
/** How long a publication may hold the library before another may take it. */
const LOCK_MS = 10 * 60 * 1000;

/** What came of a publication. */
export interface Publication {
  /** When the library was published, as its manifest says; none when nothing was written. */
  published?: string;
  /** The uploads now in the library, and the files each wrote. */
  uploads: {
    id: string;
    type: string;
    action: string;
    target: string;
    languages: string[];
    paths: string[];
  }[];
  /** The uploads left accepted, and why. */
  skipped: { id: string; message: string; issues?: Issue[] }[];
  /** The library's files the publication added, and those it changed. */
  added: string[];
  changed: string[];
  /** Accepted uploads left for the next publication. */
  remaining: number;
  /** What became of the cache before the library, once something was written. */
  cache?: Purge;
}

/** Why a publication cannot run now. */
export class NotNow extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

/** The files a publication changes, as it changes them: read from the bucket once, written once. */
class Changes {
  private readonly values = new Map<string, { value: unknown; encode: (value: never) => string }>();
  private readonly bytes = new Map<string, Uint8Array>();
  private readonly bucket: Bucket;
  private readonly manifest: Manifest;

  constructor(bucket: Bucket, manifest: Manifest) {
    this.bucket = bucket;
    this.manifest = manifest;
  }

  /** A file as it is now: as changed here, or as the library has it. */
  async read(path: string): Promise<Uint8Array | undefined> {
    const held = this.values.get(path);
    if (held) return toBytes(held.encode(held.value as never));
    if (this.bytes.has(path)) return this.bytes.get(path);
    if (!this.manifest.files[path]) return undefined;
    return readBytes(this.bucket, path);
  }

  /** A JSON file as it is now, to change in place; written with `encode`. */
  async json<T>(path: string, encode: (value: T) => string): Promise<T | undefined> {
    const held = this.values.get(path);
    if (held) return held.value as T;
    const bytes = await this.read(path);
    if (!bytes) return undefined;
    const value = JSON.parse(toText(bytes)) as T;
    this.bytes.delete(path);
    this.values.set(path, { value, encode: encode });
    return value;
  }

  setJson<T>(path: string, value: T, encode: (value: T) => string) {
    this.bytes.delete(path);
    this.values.set(path, { value, encode: encode });
  }

  setBytes(path: string, bytes: Uint8Array) {
    this.values.delete(path);
    this.bytes.set(path, bytes);
  }

  /** Every file changed, by its path. */
  *written(): Generator<[string, Uint8Array]> {
    for (const [path, held] of this.values) yield [path, toBytes(held.encode(held.value as never))];
    yield* this.bytes;
  }
}

const compact = (value: unknown) => JSON.stringify(value);

/**
 * Writes one upload into the changes, as the kind of upload it is: the files it touches. What
 * cannot be written throws before anything of it is changed.
 */
async function apply(upload: Upload, changes: Changes, uploads: Bucket): Promise<string[]> {
  const { type, action, target } = upload;
  if (action === 'tag') {
    if (target !== type) throw new PublishError(`It tags ${target}, but is an upload of ${type}.`);
    const path = tagsPath(type);
    const file = await changes.json(path, encodeTags);
    changes.setJson(path, mergeTags(file, upload.languages), encodeTags);
    return [path];
  }
  if (type === 'designs' && action === 'add') {
    const record = designOf(upload);
    const pictures: [string, Uint8Array][] = [];
    for (const [name, stored] of Object.entries(upload.files)) {
      const wanted =
        name === 'backdrop' ? `images/designs/${target}-bg.webp` : `images/designs/${target}.webp`;
      if (stored.path !== wanted) throw new PublishError(`Its file ${name} is for ${stored.path}.`);
      const object = await readFile(uploads, upload.id, name);
      const bytes = object ? new Uint8Array(await object.arrayBuffer()) : undefined;
      if (!bytes || (await sha256Hex(bytes)) !== stored.sha256) {
        throw new PublishError(`Its file ${name} is not the one it was uploaded with.`);
      }
      pictures.push([stored.path, bytes]);
    }
    const catalog = (await changes.json<ManagedCatalog>(MANAGED, compact)) ?? emptyCatalog();
    mergeDesign(catalog, record);
    changes.setJson(MANAGED, catalog, compact);
    for (const [path, bytes] of pictures) changes.setBytes(path, bytes);
    return [MANAGED, ...pictures.map(([path]) => path)];
  }
  if (type === 'designs' && action === 'translate') {
    const catalog = await changes.json<ManagedCatalog>(MANAGED, compact);
    if (!catalog) throw new PublishError(`The library has no ${MANAGED}.`);
    mergeTranslation(catalog, target, upload.languages);
    return [MANAGED];
  }
  if (type === 'templates' && action === 'translate') {
    let catalog = await changes.read(TEMPLATES);
    if (!catalog) throw new PublishError(`The library has no ${TEMPLATES}.`);
    for (const [lang, content] of Object.entries(upload.languages)) {
      const sample = (content as { sample?: unknown } | undefined)?.sample;
      if (!Array.isArray(sample) || sample.length === 0) {
        throw new PublishError(`It holds no sample in ${lang}.`);
      }
      catalog = spliceSample(catalog, target, lang, sample);
    }
    changes.setBytes(TEMPLATES, catalog);
    return [TEMPLATES];
  }
  throw new PublishError(`The library does not publish ${type}: ${action}.`);
}

/** Holds the library for one publication, or says who holds it: in the bucket of the uploads. */
export async function lock(bucket: Bucket, actor: Actor) {
  const held = await bucket.get(LOCK);
  if (held) {
    const { by, at } = JSON.parse(await held.text()) as { by?: string; at?: string };
    if (at && Date.now() - Date.parse(at) < LOCK_MS) {
      throw new NotNow(
        'publishing',
        `A publication by ${by} runs since ${at}. Try again once it is done.`,
      );
    }
  }
  await bucket.put(LOCK, JSON.stringify({ by: actor.id, at: new Date().toISOString() }), {
    httpMetadata: { contentType: 'application/json' },
  });
}

/** The uploads a publication takes: those named, or every accepted one, oldest first. */
async function chosen(uploads: Bucket, ids: readonly string[] | undefined) {
  if (ids) return { ids: [...ids], remaining: 0 };
  const { uploads: found } = await listUploads(uploads, { status: 'accepted' }, 1000);
  const oldest = found.map((one) => one.id).reverse();
  return {
    ids: oldest.slice(0, MOST_UPLOADS),
    remaining: Math.max(0, oldest.length - MOST_UPLOADS),
  };
}

/** Marks an upload published, made again on what it is now if it changed meanwhile. */
async function markPublished(uploads: Bucket, id: string, at: string, actor: Actor) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const found = await readUpload(uploads, id);
    if (!found || found.upload.status !== 'accepted') return;
    const { upload, etag } = found;
    upload.status = 'published';
    upload.updated = at;
    delete upload.note;
    upload.history.push({ status: 'published', at, by: actor });
    if (await saveUpload(uploads, upload, etag)) return;
  }
}

/**
 * Publishes the accepted uploads (or those named) into the library in `media`, checking each
 * against `library`, the library as it is, and then empties the cache of what it wrote (`purge`).
 */
export async function publish(
  media: Bucket,
  uploads: Bucket,
  library: Library,
  actor: Actor,
  ids?: readonly string[],
  purge?: Purger,
): Promise<Publication> {
  const live = await readManifest(media);
  if (!live) {
    throw new NotNow(
      'not-live',
      'The library is not in its bucket yet: bring it in first (POST /api/library/import).',
    );
  }
  await lock(uploads, actor);
  try {
    const { manifest, etag } = live;
    const changes = new Changes(media, manifest);
    const result: Publication = { uploads: [], skipped: [], added: [], changed: [], remaining: 0 };
    const picked = await chosen(uploads, ids);
    result.remaining = picked.remaining;
    for (const id of picked.ids) {
      const found = await readUpload(uploads, id);
      if (!found) {
        result.skipped.push({ id, message: `There is no upload ${id}.` });
        continue;
      }
      const { upload } = found;
      if (upload.status !== 'accepted') {
        result.skipped.push({
          id,
          message: `It is ${upload.status}: only an accepted upload is published.`,
        });
        continue;
      }
      const handler = handlerOf(upload.type, upload.action);
      if (!handler) {
        result.skipped.push({
          id,
          message: `The library no longer takes ${upload.type}: ${upload.action}.`,
        });
        continue;
      }
      const issues = await handler.check(upload, library);
      if (issues.length > 0) {
        result.skipped.push({ id, message: 'It no longer holds against the library.', issues });
        continue;
      }
      try {
        const paths = await apply(upload, changes, uploads);
        result.uploads.push({
          id,
          type: upload.type,
          action: upload.action,
          target: upload.target,
          languages: Object.keys(upload.languages),
          paths,
        });
      } catch (error) {
        if (!(error instanceof PublishError)) throw error;
        result.skipped.push({ id, message: error.message });
      }
    }
    if (result.uploads.length === 0) return result;

    const published = new Date().toISOString();
    const history = `${HISTORY}/${published}`;
    await uploads.put(`${history}/${MANIFEST}`, encodeManifest(manifest), {
      httpMetadata: { contentType: 'application/json' },
    });
    const files = { ...manifest.files };
    for (const [path, bytes] of changes.written()) {
      const sha256 = await sha256Hex(bytes);
      const before = files[path];
      if (before?.sha256 === sha256) continue;
      if (before) {
        const old = await media.get(path);
        if (old) await uploads.put(`${history}/${path}`, await old.arrayBuffer());
        result.changed.push(path);
      } else result.added.push(path);
      await putFile(media, path, bytes, sha256);
      files[path] = { size: bytes.length, sha256 };
    }
    const written = await putManifest(
      media,
      encodeManifest({ version: 1, published, files }),
      etag,
    );
    if (!written) {
      throw new NotNow('changed-meanwhile', 'The library was published meanwhile. Try again.');
    }
    forgetLibrary();
    result.added.sort();
    result.changed.sort();
    if (purge) result.cache = await purge([...result.added, ...result.changed]);
    for (const one of result.uploads) await markPublished(uploads, one.id, published, actor);
    result.published = published;
    return result;
  } finally {
    await uploads.delete(LOCK);
  }
}
