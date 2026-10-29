/**
 * A publication: the accepted uploads, written into the published library in its bucket
 * (`live.ts`), and then marked published. Nothing is copied to a machine or staged elsewhere:
 * each file an upload changes is read from the bucket, changed (`merge.ts`) and written back, and
 * the manifest, written last, says what the library is now. The app reads it the next time it
 * reads the manifest.
 *
 * - Each upload is checked once more, against the library as it is (as accepting it did); one
 *   that no longer holds, or cannot be written, is skipped, saying why (`settle.ts` decides what
 *   becomes of it).
 * - It writes as `writing.ts` does: what it replaces kept beside the uploads first, the manifest
 *   last, and the media put back as it was when it fails before then.
 * - It writes again what is made of the catalogs of the designs, the catalogs by language and the
 *   words of the designs and of their pictures made ahead (`designFiles.ts`). One that takes no
 *   upload writes them where they are of another library than the one published (**Try again**).
 * - One publication runs at a time (`lease.ts`).
 * - Once the manifest is written, the cache before the library is emptied of the files written
 *   (`cache.ts`), and what the publication did is kept, `media/publications/<published>.json`.
 */
import type { ContentLanguage } from '@slidr/model';
import type { Bucket } from '../bucket.ts';
import { isRecord, type Issue } from '../http.ts';
import { recordOf, type Actor, type Recorded } from '../uploads/access.ts';
import { handlerOf } from '../uploads/content.ts';
import { thumbLanguage } from '../uploads/designs.ts';
import { forgetLibrary, type Library } from '../uploads/library.ts';
import { listUploads, readFile, readUpload, saveUpload, type Upload } from '../uploads/store.ts';
import type { Purge, Purger } from './cache.ts';
import { writeDesignFiles, type Drawn } from './designFiles.ts';
import { Lease, NotNow } from './lease.ts';
import { PUBLICATIONS, readBytes, readManifest, sha256Hex, toBytes, toText } from './live.ts';
import {
  CATALOG,
  DESIGN_TAGS,
  DesignCatalog,
  SIZES,
  encodeSizes,
  foldManaged,
  putDesign,
  putDesignTags,
  putTranslation,
  sizesOf,
} from './designCatalog.ts';
import {
  PublishError,
  TEMPLATES,
  designOf,
  encodeTags,
  mergeTags,
  spliceSample,
  tagsPath,
} from './merge.ts';
import type { Parts } from './parts.ts';
import { Writing } from './writing.ts';

export { NotNow };

/**
 * The most uploads one publication takes: the rest wait for the next. A publication holds what
 * each upload brings until it writes (a design: its slides parsed, some 1 MB of JSON, and its
 * pictures), beside the catalog of the designs, within the Worker's 128 MB: 45 designs in one ran
 * out of memory on 2026-10-29, where one at a time were published.
 */
export const MOST_UPLOADS = 5;

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
  /**
   * The uploads not written, and why: not there, or not accepted; no longer holding against the
   * library (`invalid`); or not to be written now (`unwritable`).
   */
  skipped: {
    id: string;
    reason: 'missing' | 'status' | 'invalid' | 'unwritable';
    message: string;
    issues?: Issue[];
  }[];
  /** The library's files the publication added, those it changed, and those it took away. */
  added: string[];
  changed: string[];
  removed: string[];
  /** Accepted uploads left for the next publication. */
  remaining: number;
  /** What became of the cache before the library, once something was written. */
  cache?: Purge;
}

/**
 * The files a publication changes, as it changes them: read from the bucket once, written once.
 * The catalog of the designs is read by its structure (`designCatalog.ts`).
 */
class Changes {
  private readonly values = new Map<string, { value: unknown; encode: (value: never) => string }>();
  private readonly bytes = new Map<string, Uint8Array>();
  private catalog: DesignCatalog | undefined;
  private readonly bucket: Bucket;
  private readonly writing: Writing;

  constructor(bucket: Bucket, writing: Writing) {
    this.bucket = bucket;
    this.writing = writing;
  }

  /** A file as it is now: as changed here, or as the library has it. */
  async read(path: string): Promise<Uint8Array | undefined> {
    const held = this.values.get(path);
    if (held) return toBytes(held.encode(held.value as never));
    if (this.bytes.has(path)) return this.bytes.get(path);
    if (!this.writing.hashOf(path)) return undefined;
    return readBytes(this.bucket, path);
  }

  /** The catalog of the designs, to change in place; an empty one where the library has none. */
  async designs(): Promise<DesignCatalog> {
    this.catalog ??= DesignCatalog.of(await this.read(CATALOG));
    return this.catalog;
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

  /** Every file changed, by its path; the catalog of the designs in parts, when it was read. */
  *written(): Generator<[string, Uint8Array | Parts]> {
    for (const [path, held] of this.values) yield [path, toBytes(held.encode(held.value as never))];
    yield* this.bytes;
    if (this.catalog) yield [CATALOG, this.catalog.parts()];
  }

  /** Lets go of what was read: the catalog of the designs is read again once it is written. */
  forget() {
    this.values.clear();
    this.bytes.clear();
    this.catalog = undefined;
  }
}

/**
 * The files of an upload, each with its place in the library as its kind names it, checked
 * against the hash it was uploaded with. The pictures made ahead of a design (`thumb-<language>`)
 * of a language it does not write are left out.
 */
async function filesOf(upload: Upload, uploads: Bucket): Promise<[string, Uint8Array][]> {
  const rules = handlerOf(upload.type, upload.action)?.files ?? [];
  const files: [string, Uint8Array][] = [];
  for (const [name, stored] of Object.entries(upload.files)) {
    const wanted = rules.find((rule) => rule.name === name)?.path(upload.target);
    if (stored.path !== wanted) throw new PublishError(`Its file ${name} is for ${stored.path}.`);
    const lang = thumbLanguage(name);
    if (lang && !isRecord(upload.languages[lang as ContentLanguage])) continue;
    const object = await readFile(uploads, upload.id, name);
    const bytes = object ? new Uint8Array(await object.arrayBuffer()) : undefined;
    if (!bytes || (await sha256Hex(bytes)) !== stored.sha256) {
      throw new PublishError(`Its file ${name} is not the one it was uploaded with.`);
    }
    files.push([stored.path, bytes]);
  }
  return files;
}

/**
 * Notes which slides of a design the upload drew a picture of ahead (`thumb-<language>`), and
 * which it changed without one: the picture of an earlier slide is not of the new one. A drawing
 * (`draw`) names the word of the slide each picture is of; another upload drew the slide it brings.
 */
function noteDrawn(upload: Upload, languages: readonly string[], drawn: Drawn) {
  const of = drawn.get(upload.target) ?? new Map<string, string | undefined>();
  for (const lang of languages) {
    if (!upload.files[`thumb-${lang}`]) of.delete(lang);
    else if (upload.action !== 'draw') of.set(lang, undefined);
    else {
      const word = (upload.languages[lang as ContentLanguage] as { word?: unknown } | undefined)
        ?.word;
      of.set(lang, typeof word === 'string' ? word : '');
    }
  }
  drawn.set(upload.target, of);
}

/**
 * Writes one upload into the changes, as the kind of upload it is: the files it touches. What
 * cannot be written throws before anything of it is changed.
 */
async function apply(
  upload: Upload,
  changes: Changes,
  uploads: Bucket,
  drawn: Drawn,
): Promise<string[]> {
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
    const files = await filesOf(upload, uploads);
    const catalog = await changes.designs();
    const sizes = sizesOf(await changes.json(SIZES, encodeSizes));
    const tags = record.tags && (await changes.json(DESIGN_TAGS, encodeTags));
    putDesign(catalog, record);
    sizes[record.id] = record.size;
    changes.setJson(SIZES, sizes, encodeSizes);
    if (record.tags) {
      changes.setJson(DESIGN_TAGS, putDesignTags(tags, record.id, record.tags), encodeTags);
    }
    for (const [path, bytes] of files) changes.setBytes(path, bytes);
    noteDrawn(upload, Object.keys(record.slides), drawn);
    return [CATALOG, SIZES, ...(record.tags ? [DESIGN_TAGS] : []), ...files.map(([path]) => path)];
  }
  if (type === 'designs' && action === 'translate') {
    const catalog = await changes.designs();
    const files = await filesOf(upload, uploads);
    const written = putTranslation(catalog, target, upload.languages);
    for (const [path, bytes] of files) changes.setBytes(path, bytes);
    noteDrawn(upload, written, drawn);
    return [CATALOG, ...files.map(([path]) => path)];
  }
  if (type === 'designs' && action === 'draw') {
    const files = await filesOf(upload, uploads);
    for (const [path, bytes] of files) changes.setBytes(path, bytes);
    noteDrawn(upload, Object.keys(upload.languages), drawn);
    return files.map(([path]) => path);
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

/** What a publication did, kept beside the uploads under its moment (docs/SPEC.md §9.5). */
export async function recordPublication(
  state: Bucket,
  published: string,
  record: { kind: 'uploads' | 'files' | 'archive'; by: Recorded } & object,
) {
  await state.put(`${PUBLICATIONS}/${published}.json`, JSON.stringify({ published, ...record }), {
    httpMetadata: { contentType: 'application/json' },
  });
}

/** The uploads a publication takes: those named, or every accepted one, oldest first. */
export async function chosen(uploads: Bucket, ids: readonly string[] | undefined) {
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
    delete upload.publication;
    upload.history.push({ status: 'published', at, by: recordOf(actor) });
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
  const lease = await Lease.take(uploads, actor);
  const writing = new Writing(media, uploads, lease, live);
  try {
    // A library of before has the catalog of the designs in two: it is one before anything else.
    await foldManaged(media, writing);
    const changes = new Changes(media, writing);
    const drawn: Drawn = new Map();
    const result: Publication = {
      uploads: [],
      skipped: [],
      added: [],
      changed: [],
      removed: [],
      remaining: 0,
    };
    const picked = await chosen(uploads, ids);
    result.remaining = picked.remaining;
    for (const id of picked.ids) {
      const found = await readUpload(uploads, id);
      if (!found) {
        result.skipped.push({ id, reason: 'missing', message: `There is no upload ${id}.` });
        continue;
      }
      const { upload } = found;
      if (upload.status !== 'accepted') {
        result.skipped.push({
          id,
          reason: 'status',
          message: `It is ${upload.status}: only an accepted upload is published.`,
        });
        continue;
      }
      const handler = handlerOf(upload.type, upload.action);
      if (!handler) {
        result.skipped.push({
          id,
          reason: 'invalid',
          message: `The library no longer takes ${upload.type}: ${upload.action}.`,
        });
        continue;
      }
      const issues = await handler.check(upload, library);
      if (issues.length > 0) {
        result.skipped.push({
          id,
          reason: 'invalid',
          message: 'It no longer holds against the library.',
          issues,
        });
        continue;
      }
      try {
        const paths = await apply(upload, changes, uploads, drawn);
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
        result.skipped.push({ id, reason: 'unwritable', message: error.message });
      }
    }
    for (const [path, data] of changes.written()) await writing.put(path, data);
    changes.forget();
    // What is made of the catalog of the designs, as the library now is; with no upload, only
    // where it is of another library (`designFiles.ts`).
    await writeDesignFiles(media, writing, drawn);
    if (result.uploads.length === 0 && !writing.written) return result;
    await writing.finish();
    const { published } = writing;
    forgetLibrary();
    result.added = writing.added;
    result.changed = writing.changed;
    result.removed = writing.removed;
    if (purge) {
      result.cache = await purge([...result.added, ...result.changed, ...result.removed]);
    }
    for (const one of result.uploads) await markPublished(uploads, one.id, published, actor);
    result.published = published;
    await recordPublication(uploads, published, {
      kind: 'uploads',
      by: recordOf(actor),
      ...result,
    });
    return result;
  } catch (error) {
    if (!writing.finished) await undo(writing);
    throw error;
  } finally {
    await lease.release();
  }
}

/** Puts the media back after a publication failed; says so when even that cannot be done. */
export async function undo(writing: Writing) {
  try {
    await writing.undo();
  } catch (error) {
    console.error(`The media could not be put back as it was: ${String(error)}`);
  }
}
