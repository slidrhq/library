/**
 * Bringing the published library into its bucket, once: every file the site's manifest names,
 * read from the site (slidr-media.pages.dev, as Cloudflare Pages served it), checked against its
 * SHA-256 and written under its path. A call copies a batch and says how many are left, so it is
 * called until it says it is done (`scripts/import-library.mjs`); a file already there with its
 * hash is not read again. The manifest is written last, once every file is in: from then on the
 * library is the bucket's (`live.ts`), and a publication writes into it.
 *
 * The site's own files (`_headers`, `404.html`, the parts of large catalogs and the Worker that
 * joins them) are not the library's, and stay behind: the Worker serves the library itself
 * (`serve.ts`).
 */
import type { Bucket } from '../uploads/store.ts';
import {
  MANIFEST,
  encodeManifest,
  encodedPath,
  isLibraryPath,
  putFile,
  readManifest,
  sha256Hex,
  type Manifest,
} from './live.ts';

/** How many files a call copies, unless it names another number. */
export const BATCH = 60;
export const MOST_BATCH = 400;
/** How many bytes are read at once: the largest catalog is some 43 MB. */
const BYTES_AT_ONCE = 48 * 1024 * 1024;
const TIMEOUT_MS = 120_000;

export interface Imported {
  from: string;
  /** When the site's library was published. */
  published: string;
  files: number;
  /** Files in the bucket with the site's bytes, after this call. */
  present: number;
  copied: number;
  failed: { path: string; message: string }[];
  remaining: number;
  /** Whether the bucket has the whole library, and its manifest. */
  done: boolean;
}

export class ImportRefused extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

/** The hash of each file the bucket has, as written with it. */
async function hashesIn(bucket: Bucket): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  let startAfter: string | undefined;
  for (;;) {
    const page = await bucket.list({ startAfter, limit: 1000, include: ['customMetadata'] });
    for (const object of page.objects) {
      const hash = object.customMetadata?.sha256;
      if (hash) found.set(object.key, hash);
    }
    if (!page.truncated || page.objects.length === 0) return found;
    startAfter = page.objects.at(-1)!.key;
  }
}

async function siteManifest(from: string): Promise<Manifest> {
  let response: Response;
  try {
    response = await fetch(`${from}${MANIFEST}`, {
      headers: { 'Cache-Control': 'no-cache' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (cause) {
    throw new ImportRefused('site-unreachable', `${from} could not be read: ${String(cause)}`);
  }
  if (!response.ok) {
    throw new ImportRefused('site-unreachable', `${from}${MANIFEST} answered ${response.status}.`);
  }
  if (response.headers.get('X-Slidr-Library') === 'live') {
    throw new ImportRefused(
      'live',
      `${from} is served from the bucket already: there is nothing to bring in.`,
    );
  }
  const manifest = (await response.json()) as Partial<Manifest>;
  if (!manifest.files || typeof manifest.files !== 'object') {
    throw new ImportRefused('site-unreachable', `${from}${MANIFEST} is not a manifest.`);
  }
  return { version: 1, published: String(manifest.published ?? ''), files: manifest.files };
}

/** Copies one file of the site into the bucket, checked against what the manifest says of it. */
async function copy(bucket: Bucket, from: string, path: string, entry: Manifest['files'][string]) {
  const response = await fetch(from + encodedPath(path), {
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`the site answered ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  const hash = await sha256Hex(bytes);
  if (bytes.length !== entry.size || hash !== entry.sha256) {
    throw new Error(`its bytes are not those the manifest names (${bytes.length} bytes, ${hash})`);
  }
  await putFile(bucket, path, bytes, hash);
}

/** Copies the next files of the site's library into the bucket: up to `limit` of them. */
export async function importLibrary(
  bucket: Bucket,
  from: string,
  limit = BATCH,
): Promise<Imported> {
  if (await readManifest(bucket)) {
    throw new ImportRefused(
      'live',
      'The bucket has the library already: it is published through the uploads now (POST /api/publish).',
    );
  }
  const site = from.endsWith('/') ? from : `${from}/`;
  const manifest = await siteManifest(site);
  const paths = Object.keys(manifest.files).sort();
  const wrong = paths.filter((path) => !isLibraryPath(path));
  if (wrong.length > 0) {
    throw new ImportRefused(
      'not-a-library',
      `The site's manifest names paths that are not the library's: ${wrong.slice(0, 5).join(', ')}.`,
    );
  }
  const held = await hashesIn(bucket);
  const missing = paths.filter((path) => held.get(path) !== manifest.files[path]!.sha256);
  const batch = missing.slice(0, Math.max(1, Math.min(limit, MOST_BATCH)));
  const failed: Imported['failed'] = [];
  let copied = 0;
  // A few at a time, as many bytes at once as a Worker holds.
  let at = 0;
  while (at < batch.length) {
    const group: string[] = [];
    let bytes = 0;
    while (at < batch.length && group.length < 6) {
      const size = manifest.files[batch[at]!]!.size;
      if (group.length > 0 && bytes + size > BYTES_AT_ONCE) break;
      group.push(batch[at]!);
      bytes += size;
      at += 1;
    }
    await Promise.all(
      group.map(async (path) => {
        try {
          await copy(bucket, site, path, manifest.files[path]!);
          copied += 1;
        } catch (error) {
          failed.push({ path, message: error instanceof Error ? error.message : String(error) });
        }
      }),
    );
  }
  const remaining = missing.length - copied;
  if (remaining === 0) {
    const text = encodeManifest(manifest);
    await bucket.put(MANIFEST, text, {
      httpMetadata: { contentType: 'application/json' },
      customMetadata: { sha256: await sha256Hex(new TextEncoder().encode(text)) },
    });
  }
  return {
    from: site,
    published: manifest.published,
    files: paths.length,
    present: paths.length - remaining,
    copied,
    failed,
    remaining,
    done: remaining === 0,
  };
}
