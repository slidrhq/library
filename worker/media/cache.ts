/**
 * Cloudflare's cache before the published library. media.slidr.studio is the library's bucket
 * itself (`live.ts`), and Cloudflare keeps each file it answered for a day, and the manifest for
 * five minutes (README, "Serving the library"). A publication writes files under the paths they
 * had, so once the manifest is written it empties the cache of every file it wrote, and of the
 * manifest: the next request for one reads it from the bucket. Every other file stays in the cache.
 *
 * Until it is emptied, an app would read the new manifest and an old file, whose bytes are not
 * those the manifest names: the app shows them, and fetches them again each time. A publication
 * whose cache could not be emptied says so; the cache then holds the old files until they expire.
 *
 * On this machine (`pnpm dev`) there is no cache before the library, and nothing is emptied.
 */
import { MEDIA_LIBRARY_URL } from '@slidr/media-library';
import { MANIFEST, encodedPath } from './live.ts';

export interface CacheEnv {
  /** The zone the library's address is in (slidr.studio): its id, on its Overview page. */
  MEDIA_ZONE_ID?: string;
  /** A token of the zone that may purge its cache (Zone → Cache Purge → Purge). */
  MEDIA_PURGE_TOKEN?: string;
  /** The library's address: the published one unless this names another. */
  MEDIA_LIBRARY_URL?: string;
}

/** What a publication did to the cache. */
export type Purge =
  /** The files it wrote, and the manifest, by their addresses. */
  | { emptied: 'files'; files: number }
  /** Every file of the library's host: there were too many to name. */
  | { emptied: 'host'; host: string }
  /** Nothing: the Worker is not set up to, or Cloudflare refused. */
  | { emptied: 'none'; message: string };

/** Empties the cache of the library's files at these paths, and of the manifest. */
export type Purger = (paths: readonly string[]) => Promise<Purge>;

const API = 'https://api.cloudflare.com/client/v4/zones';
/** The most addresses Cloudflare takes in one call. */
const PER_CALL = 100;
/** More files than this, and the whole host is emptied in one call instead. */
const MOST_FILES = 300;
const ATTEMPTS = 3;
const TIMEOUT_MS = 15_000;

interface Answer {
  success?: boolean;
  errors?: { code?: number; message?: string }[];
}

/** One call to Cloudflare's purge, tried again when it fails but for a token it refuses. */
async function purge(zone: string, token: string, body: object) {
  let failure = '';
  for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(`${API}/${zone}/purge_cache`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      const answer = (await response.json().catch(() => ({}))) as Answer;
      if (response.ok && answer.success) return;
      failure =
        answer.errors?.map((error) => error.message ?? `error ${error.code}`).join('; ') ||
        `Cloudflare answered ${response.status}`;
      if (response.status === 401 || response.status === 403) break;
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    }
    if (attempt < ATTEMPTS) await new Promise((done) => setTimeout(done, 200 * attempt));
  }
  throw new Error(failure);
}

/** The purge of the cache before the library this Worker publishes. */
export function purgerFor(env: CacheEnv): Purger {
  return async (paths) => {
    const zone = env.MEDIA_ZONE_ID;
    const token = env.MEDIA_PURGE_TOKEN;
    if (!zone || !token) {
      return {
        emptied: 'none',
        message:
          'The Worker has no MEDIA_ZONE_ID and MEDIA_PURGE_TOKEN: the cache keeps the old files until they expire.',
      };
    }
    const site = env.MEDIA_LIBRARY_URL ?? MEDIA_LIBRARY_URL;
    const base = site.endsWith('/') ? site : `${site}/`;
    const urls = [...new Set([...paths, MANIFEST])].map((path) => base + encodedPath(path));
    try {
      if (urls.length > MOST_FILES) {
        const host = new URL(base).host;
        await purge(zone, token, { hosts: [host] });
        return { emptied: 'host', host };
      }
      for (let at = 0; at < urls.length; at += PER_CALL) {
        await purge(zone, token, { files: urls.slice(at, at + PER_CALL) });
      }
      return { emptied: 'files', files: urls.length };
    } catch (error) {
      const message = `The cache was not emptied: ${error instanceof Error ? error.message : String(error)}`;
      console.error(message);
      return { emptied: 'none', message };
    }
  };
}
