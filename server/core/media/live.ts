/**
 * The published library itself, kept by the Worker in a bucket of R2 (`MEDIA`, `wrangler.jsonc`):
 * every file of the library under its own path (`fonts/catalog.json`, `tags/emoji.json`), and
 * `manifest.json`, which names each with its size and SHA-256 as the app reads it
 * (docs/media-library.md of the app). media.slidr.studio is the bucket itself, a custom domain of
 * R2 with Cloudflare's cache before it (README, "Serving the library"): no Worker runs when the
 * app reads the library, and each file is answered with the type and the caching it was written
 * with. The Worker serves the same bucket at `/media/` (`serve.ts`), as a dev server does.
 *
 * What is published comes through the uploads: a publication writes the accepted ones into the
 * bucket (`publish.ts`), and empties the cache of the files it wrote (`cache.ts`). It came into
 * the bucket once, from the site as it was (`import.ts`).
 *
 *   manifest.json                  the library's files, their sizes and hashes
 *   <path>                         each file, with its SHA-256 in its metadata
 *
 * The bucket is public, so it holds the library and nothing else. A publication's own records are
 * kept beside the uploads (`UPLOADS`, `../uploads/store.ts`):
 *
 *   media/history/<published>/…    what a publication replaced: the manifest before it, and each
 *                                  file it wrote over
 *   media/staged/<sha256>          a file of an author's publication, until it is published
 *   media/lock.json                while a publication runs
 *
 * A path that starts with `_` is never one of the library's: the Worker kept its records there
 * before.
 */
import type { Bucket } from '../bucket.ts';

export const MANIFEST = 'manifest.json';
/** A file a media store is tried with (`settings.ts`): never one of the library's, and hidden. */
export const PROBE = '.slidr-library-probe.json';
/** In the bucket of the uploads. */
export const HISTORY = 'media/history';
export const LOCK = 'media/lock.json';
/** What each publication did, under its moment: `<published>.json`. */
export const PUBLICATIONS = 'media/publications';

export interface ManifestEntry {
  size: number;
  sha256: string;
}

/** The list of the library's files, as the app and the pages read it. */
export interface Manifest {
  version: 1;
  published: string;
  files: Record<string, ManifestEntry>;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export const toBytes = (text: string) => encoder.encode(text);
export const toText = (bytes: Uint8Array) => decoder.decode(bytes);

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * The type of each file of the library, by its extension. The image's Nginx answers `/media/` with
 * the same (`docker/media-types.conf`, written from this by `pnpm nginx-types`).
 */
export const MEDIA_TYPES: Record<string, string> = {
  json: 'application/json',
  svg: 'image/svg+xml',
  webp: 'image/webp',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  woff2: 'font/woff2',
  woff: 'font/woff',
  ttf: 'font/ttf',
  otf: 'font/otf',
  html: 'text/html; charset=utf-8',
  md: 'text/plain; charset=utf-8',
  txt: 'text/plain; charset=utf-8',
};

/** The type a file of the library is served as, by its extension (as `desktop/build/media.ts`). */
export function contentType(path: string): string {
  const extension = /\.([a-z0-9]+)$/i.exec(path)?.[1]?.toLowerCase() ?? '';
  return MEDIA_TYPES[extension] ?? 'application/octet-stream';
}

/**
 * How a browser keeps a file of the library, as Cloudflare Pages served it: the manifest is asked
 * for again each time, and every other file is checked again before it is used. Cloudflare's own
 * cache keeps them longer, until a publication empties it (`cache.ts`).
 */
export const cacheControl = (path: string) =>
  path === MANIFEST ? 'no-cache' : 'public, max-age=0, must-revalidate';

/**
 * Whether a path is one of a file of the library: plain parts joined by `/`, none of them hidden
 * (`.…`, as `..`, `.ssh` or `.git`, which a folder of a machine may hold), and not the Worker's own
 * (`_…`).
 */
export function isLibraryPath(path: string): boolean {
  if (!path || path.startsWith('_') || path.startsWith('/') || path.endsWith('/')) return false;
  if (path.includes('\\') || path.includes(':') || path.includes('\0')) return false;
  return path.split('/').every((part) => part !== '' && !part.startsWith('.'));
}

/** The manifest as `pnpm media:publish` wrote it: its files by path, indented. */
export function encodeManifest(manifest: Manifest): string {
  const files = Object.fromEntries(
    Object.keys(manifest.files)
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
      .map((path) => [path, manifest.files[path]]),
  );
  return `${JSON.stringify({ version: 1, published: manifest.published, files }, null, 2)}\n`;
}

const isManifest = (value: unknown): value is Manifest =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as Manifest).files === 'object' &&
  (value as Manifest).files !== null;

/** The manifest of the bucket, and the version of it read; none before the library came in. */
export async function readManifest(
  bucket: Bucket,
): Promise<{ manifest: Manifest; etag: string } | undefined> {
  const object = await bucket.get(MANIFEST);
  if (!object) return undefined;
  const value = JSON.parse(await object.text()) as unknown;
  if (!isManifest(value)) throw new Error(`The bucket's ${MANIFEST} is not a manifest.`);
  return {
    manifest: { version: 1, published: String(value.published ?? ''), files: value.files },
    etag: object.etag,
  };
}

/** The bytes of a file of the bucket; none when it is not there. */
export async function readBytes(bucket: Bucket, path: string): Promise<Uint8Array | undefined> {
  const object = await bucket.get(path);
  return object ? new Uint8Array(await object.arrayBuffer()) : undefined;
}

/** Writes a file of the library into the bucket, with what it is served as. */
export async function putFile(bucket: Bucket, path: string, bytes: Uint8Array, sha256: string) {
  await bucket.put(path, bytes, {
    httpMetadata: { contentType: contentType(path), cacheControl: cacheControl(path) },
    customMetadata: { sha256 },
  });
}

/**
 * Writes the manifest, last, which makes the files written before it the library. With `etag`,
 * only over the manifest of that version: none when another was written meanwhile.
 */
export async function putManifest(bucket: Bucket, text: string, etag?: string) {
  return bucket.put(MANIFEST, text, {
    httpMetadata: { contentType: 'application/json', cacheControl: cacheControl(MANIFEST) },
    customMetadata: { sha256: await sha256Hex(toBytes(text)) },
    ...(etag === undefined ? {} : { onlyIf: { etagMatches: etag } }),
  });
}

/** `path`, ready to be joined to the address of a site. */
export const encodedPath = (path: string) => path.split('/').map(encodeURIComponent).join('/');
