/**
 * The media library (docs/media-library.md): the icon sets, the built-in fonts of decks, the
 * built-in templates and their photographs, and the content of Elements. It is a site of its own,
 * published apart from the app and read while the app runs:
 *
 *   https://media.slidr.studio/manifest.json        every file of the library, its size and hash
 *   https://media.slidr.studio/fonts/catalog.json
 *   https://media.slidr.studio/images/templates/shvil-ridge.webp
 *
 * Where a page reads it from:
 * - in the app, through the core's `media` protocol, which keeps the library on the machine and
 *   answers from there without the network (`src-tauri/src/media_library.rs`);
 * - in a plain browser (the dev server, the browser tests), through the dev server's stand-in for
 *   that protocol, at the path the server names (`desktop/build/media.ts`);
 * - anywhere else (Node: the unit tests, scripts), from the site itself.
 *
 * Any read may come to nothing: the network is gone, the library was never published, it is
 * empty, or a file is not in it. A read then answers `undefined`, never throws, and each reader
 * goes on without the file.
 *
 * Without the DOM: `@slidr/templates` reads its catalog through here, and stays without it
 * (SPEC 14.2). What it takes of the page is typed below.
 */

/** Where the library is published. */
export const MEDIA_LIBRARY_URL = 'https://media.slidr.studio/';

/** The path a dev server serves the library at, defined by its plugin; absent elsewhere. */
declare const __SLIDR_MEDIA_PATH__: string | undefined;

/** An answer to a read, as far as the library uses it. */
interface Answer {
  ok: boolean;
  status: number;
  text(): Promise<string>;
}

/** What a read needs of where it runs: a page of the app, a plain browser, or Node. */
interface Surroundings {
  isTauri?: boolean;
  navigator?: { userAgent?: string };
  location?: { origin?: string };
  fetch?: (url: string, init?: { signal?: unknown }) => Promise<Answer>;
  AbortSignal?: { timeout?: (ms: number) => unknown };
  console?: { error(message: string, error: unknown): void };
}

const surroundings = () => globalThis as unknown as Surroundings;

/** How long one read may take: the largest files are catalogs of a few megabytes. */
const TIMEOUT_MS = 60_000;

/** The address the library's files are under, ending with a slash. */
export function mediaBase(): string {
  const page = surroundings();
  if (page.isTauri) {
    // As the core's protocols are spelled: by WebView2 and on Android, a host of `localhost`.
    return /Windows|Android/.test(page.navigator?.userAgent ?? '')
      ? 'http://media.localhost/'
      : 'media://localhost/';
  }
  const served = typeof __SLIDR_MEDIA_PATH__ === 'string' ? __SLIDR_MEDIA_PATH__ : undefined;
  if (served && page.location?.origin) return page.location.origin + served;
  return MEDIA_LIBRARY_URL;
}

/** The address of a file of the library, by its place in it: `fonts/heebo/heebo-latin.woff2`. */
export function mediaUrl(path: string): string {
  return mediaBase() + path.split('/').map(encodeURIComponent).join('/');
}

/** The file that lists the library. */
const MANIFEST = 'manifest.json';

/** The text of a file, asked for whether the library has it or not. */
async function fetchText(path: string): Promise<string | undefined> {
  const page = surroundings();
  if (!page.fetch) return undefined;
  try {
    const signal = page.AbortSignal?.timeout?.(TIMEOUT_MS);
    const answer = await page.fetch(mediaUrl(path), signal ? { signal } : undefined);
    return answer.ok ? await answer.text() : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The text of a file of the library; undefined when it cannot be had. A file the manifest does
 * not name is not asked for: a library that is empty, or not there, costs no request.
 */
export async function readMediaText(path: string): Promise<string | undefined> {
  if (!(await mediaFiles()).has(path)) return undefined;
  return fetchText(path);
}

/** A JSON file of the library; undefined when it cannot be had or is not JSON. */
export async function readMediaJson<T = unknown>(path: string): Promise<T | undefined> {
  const text = await readMediaText(path);
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text) as T;
  } catch {
    return undefined;
  }
}

/** A JSON file of the library, for a reader that reports a failure itself: it throws. */
export async function requireMediaJson<T = unknown>(path: string): Promise<T> {
  const read = await readMediaJson<T>(path);
  if (read === undefined) throw new Error(`The media library has no ${path}.`);
  return read;
}

/** A JSON file of the library, read the first time it is asked for. A failed read is tried again. */
export function lazyMediaJson<T>(path: string): () => Promise<T> {
  let loaded: Promise<T> | undefined;
  return () => {
    loaded ??= requireMediaJson<T>(path).catch((error: unknown) => {
      loaded = undefined;
      throw error;
    });
    return loaded;
  };
}

/** The list of the library's files, as Slidr Library writes it. */
export interface MediaManifest {
  version: number;
  /** When the library was published. */
  published?: string;
  files: Readonly<Record<string, { size: number; sha256: string }>>;
}

const NO_FILES: MediaManifest = { version: 1, files: {} };

let manifest: Promise<MediaManifest> | undefined;
let files: Promise<ReadonlySet<string>> | undefined;

/** The manifest of the library, read once; one without files when it cannot be had. */
export function mediaManifest(): Promise<MediaManifest> {
  manifest ??= fetchText(MANIFEST).then((text) => {
    try {
      const read = JSON.parse(text ?? '') as Partial<MediaManifest> | null;
      return read && typeof read.files === 'object' && read.files !== null
        ? (read as MediaManifest)
        : NO_FILES;
    } catch {
      return NO_FILES;
    }
  });
  return manifest;
}

/** The places of the library's files: what a reader may ask for. Empty without a library. */
export function mediaFiles(): Promise<ReadonlySet<string>> {
  files ??= mediaManifest().then((read) => {
    const known = new Set(Object.keys(read.files));
    filesNow = known;
    changed();
    return known;
  });
  return files;
}

/** The places of the library's files as far as they are known now: none until the manifest came. */
let filesNow: ReadonlySet<string> = new Set();
/** Bumped whenever something read from the library comes, or comes again. */
let epoch = 0;
const listeners = new Set<() => void>();

function changed(): void {
  epoch += 1;
  for (const listener of [...listeners]) listener();
}

/**
 * The places of the library's files known now, without waiting: empty until the manifest has
 * come, which asking for it starts. A reader that draws with it draws again on
 * {@link subscribeMedia}.
 */
export function mediaFilesNow(): ReadonlySet<string> {
  void mediaFiles();
  return filesNow;
}

/**
 * Calls `listener` whenever something of the library comes: the manifest, a catalog, or either
 * again after the library changed. For a page that draws what it holds, so it draws again.
 */
export function subscribeMedia(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** A number that changes whenever {@link subscribeMedia} calls its listeners. */
export const mediaEpoch = (): number => epoch;

/**
 * A value made of the library's files, read in the background the first time it is wanted and
 * never waited for: until it has come, readers get what stands in for it, and draw again when it
 * comes (`subscribe`). The app starts without the library this way, and a library that is slow,
 * or not there, costs it nothing.
 */
export interface MediaCatalog<T> {
  /** The value now: `empty` until it has been read. Asking starts the read. */
  readonly get: () => T;
  /** The value now, without starting the read: for a reader that has it read when it chooses. */
  readonly peek: () => T;
  /** The value once read (`empty` when the library has nothing); starts the read. Never rejects. */
  readonly load: () => Promise<T>;
  /** Whether a read has come, whatever it found. */
  readonly ready: boolean;
  /** Calls `listener` when the value changes; returns what stops it. */
  readonly subscribe: (listener: () => void) => () => void;
}

/** The catalogs read so far, read again when the library changes. */
const catalogs = new Set<{ reload(): void }>();

/** A value of the library that `read` makes, `empty` until it has: see {@link MediaCatalog}. */
export function mediaCatalog<T>(read: () => Promise<T>, empty: T): MediaCatalog<T> {
  let value = empty;
  let ready = false;
  let reading: Promise<T> | undefined;
  const own = new Set<() => void>();
  const start = (): Promise<T> =>
    read()
      .catch((error: unknown) => {
        surroundings().console?.error('A file of the media library could not be read', error);
        return empty;
      })
      .then((next) => {
        value = next;
        ready = true;
        for (const listener of [...own]) listener();
        changed();
        return next;
      });
  const catalog: MediaCatalog<T> = {
    get: () => {
      void catalog.load();
      return value;
    },
    peek: () => value,
    load: () => {
      if (!reading) {
        reading = start();
        catalogs.add({
          reload: () => {
            reading = start();
          },
        });
      }
      return reading;
    },
    get ready() {
      return ready;
    },
    subscribe: (listener) => {
      own.add(listener);
      return () => own.delete(listener);
    },
  };
  return catalog;
}

/**
 * The library changed while the app runs (the core read a newer manifest than the one it answered
 * from at the start): the manifest is read again, and so is every catalog read so far, and
 * whoever draws them draws again.
 */
export function refreshMediaLibrary(): void {
  // What is known stays known until the new manifest has come.
  manifest = undefined;
  files = undefined;
  void mediaFiles().then(() => {
    for (const catalog of catalogs) catalog.reload();
  });
}

/** Forgets the manifest read, so the next call reads it again: for tests. */
export function forgetMediaManifest(): void {
  manifest = undefined;
  files = undefined;
  filesNow = new Set();
}
