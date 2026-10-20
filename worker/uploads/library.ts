/**
 * The published library, as an upload is checked against it: whether an id is taken, the fonts a
 * text may be set in, a template a sample is written for. Each file is read from the site itself
 * (`MEDIA_LIBRARY_URL`, the published library unless the Worker names another) and kept for a
 * minute, so a burst of uploads reads it once.
 */
import { MEDIA_LIBRARY_URL } from '@slidr/media-library';
import type { AssetMeta, FontFamilyEntry } from '@slidr/model';
import { Template } from '@slidr/templates';
import { fontShelf, type FontShelf } from '../../vendor/apps/desktop/src/elements/designFonts.ts';

export interface Library {
  /** Whether the published library has a file, by its path. */
  has(path: string): Promise<boolean>;
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

function readJson<T>(url: string): Promise<T> {
  const held = kept.get(url);
  if (held && held.until > Date.now()) return held.value as Promise<T>;
  const value = (async () => {
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
  })();
  kept.set(url, { until: Date.now() + KEEP_MS, value });
  value.catch(() => kept.delete(url));
  return value;
}

interface Manifest {
  files?: Record<string, unknown>;
}

interface FontCatalog {
  families?: FontFamilyEntry[];
  faces?: { family: string; style: string; weight: string }[];
}

/** The library at an address: the published one by default. */
export function libraryAt(base = MEDIA_LIBRARY_URL): Library {
  const root = base.endsWith('/') ? base : `${base}/`;
  const url = (path: string) => root + path.split('/').map(encodeURIComponent).join('/');
  const files = async () => (await readJson<Manifest>(url('manifest.json'))).files ?? {};
  const has = async (path: string) => Object.hasOwn(await files(), path);

  return {
    has,
    async fonts() {
      const catalog = await readJson<FontCatalog>(url('fonts/catalog.json'));
      return fontShelf({ families: catalog.families ?? [], faces: catalog.faces ?? [] });
    },
    async template(id) {
      const path = `templates/${id}/template.json`;
      if (!(await has(path))) return undefined;
      const parsed = Template.safeParse(await readJson(url(path)));
      if (!parsed.success) throw new LibraryUnreachable(`${path} is not a template`);
      return parsed.data;
    },
    async pictures() {
      const records = await readJson<Record<string, AssetMeta>>(url('templates/pictures.json'));
      return new Map(Object.values(records).map((record) => [record.id, record]));
    },
  };
}
