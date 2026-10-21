/**
 * The published library, as an upload is checked against it: whether an id is taken, the fonts a
 * text may be set in, a template a sample is written for, the items a part's tags are for. Each
 * file is read from the library's bucket once the library is there (`../media/live.ts`), and
 * before that from the site itself (`MEDIA_LIBRARY_URL`, the published library unless the Worker
 * names another); it is kept for a minute, so a burst of uploads reads it once, and a publication
 * forgets it.
 */
import { MEDIA_LIBRARY_URL } from '@slidr/media-library';
import type { AssetMeta, FontFamilyEntry } from '@slidr/model';
import { Template } from '@slidr/templates';
import { fontShelf, type FontShelf } from '../../vendor/desktop/src/elements/designFonts.ts';
import type { Bucket } from './store.ts';

export interface Library {
  /** Whether the published library has a file, by its path. */
  has(path: string): Promise<boolean>;
  /** The paths of every file of the published library. */
  paths(): Promise<string[]>;
  /** A JSON file of the published library, such as a catalog, by its path. */
  json<T>(path: string): Promise<T>;
  /** The families of `fonts/catalog.json`, and their weights. */
  fonts(): Promise<FontShelf>;
  /** A built-in template, as a deck takes it (`templates/<id>/template.json`). */
  template(id: string): Promise<Template | undefined>;
  /** The pictures of the templates' samples (`templates/pictures.json`), by asset id. */
  pictures(): Promise<ReadonlyMap<string, AssetMeta>>;
}

/** The library could not be read, so nothing can be checked against it. */
export class LibraryUnreachable extends Error {}

const KEEP_MS = 60_000;
const TIMEOUT_MS = 20_000;

const kept = new Map<string, { until: number; value: Promise<unknown> }>();

/** Every file is read again the next time it is asked for. */
export function forgetLibrary() {
  kept.clear();
}

/** A value read once a minute, by the key it is kept under. */
function keep<T>(key: string, produce: () => Promise<T>): Promise<T> {
  const held = kept.get(key);
  if (held && held.until > Date.now()) return held.value as Promise<T>;
  const value = produce();
  kept.set(key, { until: Date.now() + KEEP_MS, value });
  value.catch(() => kept.delete(key));
  return value;
}

function readJson<T>(url: string): Promise<T> {
  return keep(url, async () => {
    let response: Response;
    try {
      response = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (cause) {
      throw new LibraryUnreachable(`${url} could not be read: ${String(cause)}`);
    }
    if (!response.ok) throw new LibraryUnreachable(`${url} answered ${response.status}`);
    try {
      return (await response.json()) as T;
    } catch {
      throw new LibraryUnreachable(`${url} is not JSON`);
    }
  });
}

/** A JSON file of the library's bucket; none when the bucket does not have it. */
function readStored<T>(bucket: Bucket, path: string): Promise<T | undefined> {
  return keep(`bucket:${path}`, async () => {
    const object = await bucket.get(path);
    if (!object) return undefined;
    try {
      return JSON.parse(await object.text()) as T;
    } catch {
      throw new LibraryUnreachable(`${path} of the library's bucket is not JSON`);
    }
  });
}

interface Manifest {
  files?: Record<string, unknown>;
}

interface FontCatalog {
  families?: FontFamilyEntry[];
  faces?: { family: string; style: string; weight: string }[];
}

/** The library whose JSON files `read` reads, by their paths. */
function libraryOver(read: <T>(path: string) => Promise<T>): Library {
  const files = async () => (await read<Manifest>('manifest.json')).files ?? {};
  const has = async (path: string) => Object.hasOwn(await files(), path);

  return {
    has,
    paths: async () => Object.keys(await files()),
    json: (path) => read(path),
    async fonts() {
      const catalog = await read<FontCatalog>('fonts/catalog.json');
      return fontShelf({ families: catalog.families ?? [], faces: catalog.faces ?? [] });
    },
    async template(id) {
      const path = `templates/${id}/template.json`;
      if (!(await has(path))) return undefined;
      const parsed = Template.safeParse(await read(path));
      if (!parsed.success) throw new LibraryUnreachable(`${path} is not a template`);
      return parsed.data;
    },
    async pictures() {
      const records = await read<Record<string, AssetMeta>>('templates/pictures.json');
      return new Map(Object.values(records).map((record) => [record.id, record]));
    },
  };
}

/** The library at an address: the published one by default. */
export function libraryAt(base = MEDIA_LIBRARY_URL): Library {
  const root = base.endsWith('/') ? base : `${base}/`;
  return libraryOver((path) => readJson(root + path.split('/').map(encodeURIComponent).join('/')));
}

/** The library in its bucket (`../media/live.ts`). */
export function libraryIn(bucket: Bucket): Library {
  return libraryOver(async <T>(path: string) => {
    const value = await readStored<T>(bucket, path);
    if (value === undefined) throw new LibraryUnreachable(`The library's bucket has no ${path}`);
    return value;
  });
}

/**
 * The library uploads are checked against: in its bucket once it is there, and the site before
 * (`MEDIA_LIBRARY_URL`, or the published one).
 */
export function libraryFor(env: { MEDIA?: Bucket; MEDIA_LIBRARY_URL?: string }): Library {
  const site = libraryAt(env.MEDIA_LIBRARY_URL ?? MEDIA_LIBRARY_URL);
  const bucket = env.MEDIA;
  if (!bucket) return site;
  const stored = libraryIn(bucket);
  const which = async () =>
    (await readStored<Manifest>(bucket, 'manifest.json')) === undefined ? site : stored;
  return {
    has: async (path) => (await which()).has(path),
    paths: async () => (await which()).paths(),
    json: async (path) => (await which()).json(path),
    fonts: async () => (await which()).fonts(),
    template: async (id) => (await which()).template(id),
    pictures: async () => (await which()).pictures(),
  };
}
