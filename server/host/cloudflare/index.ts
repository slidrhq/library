/**
 * The library on Cloudflare: the Worker `library` (`wrangler.jsonc`). It serves the built page as
 * static assets, and answers the rest, under `/auth/`, `/api/` and `/media/`
 * (`assets.run_worker_first`), with the library's server (`../../core`). The Worker's bindings and
 * secrets are what the server is given (`contextOf`).
 */
import type { Bucket } from '../../core/bucket.ts';
import type { Context } from '../../core/context.ts';
import { handle, isServed } from '../../core/index.ts';
import { purgerFor } from '../../core/media/cache.ts';
import { sweep } from '../../core/media/sweep.ts';
import { Vault, masterKeyFromText } from '../../core/vault.ts';

export interface Env {
  /** The built page (`dist/client`). */
  ASSETS: { fetch(request: Request): Promise<Response> };
  /** What the library keeps for itself: the uploads until they are published, its people. */
  UPLOADS?: Bucket;
  /** The published library (README, "Publishing the uploads"). */
  MEDIA?: Bucket;
  /** The site the library is read from before it is in its bucket: the published one by default. */
  MEDIA_LIBRARY_URL?: string;
  /** The zone of the library's address, and a token that purges its cache (`media/cache.ts`). */
  MEDIA_ZONE_ID?: string;
  MEDIA_PURGE_TOKEN?: string;
  /**
   * The master key of the library's vault (docs/SPEC.md §4.4), a secret of the Worker; without
   * it, the Worker keeps no keys of its own, and takes its session key from `SESSION_SECRET`.
   */
  LIBRARY_MASTER_KEY?: string;
  /** Secrets of the Worker (README, "Signing in"): what `AuthSettings` of the context says. */
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  SESSION_SECRET?: string;
  /** Who becomes the owner when the library names no one yet (`settlePeople`). */
  LIBRARY_OWNER?: string;
  LIBRARY_EDITORS?: string;
  LIBRARY_KEYS?: string;
}

/** What the server is given: the Worker's bindings and secrets, by what they are for. */
export async function contextOf(env: Partial<Env>): Promise<Context> {
  const vault =
    env.UPLOADS && env.LIBRARY_MASTER_KEY
      ? new Vault(env.UPLOADS, [await masterKeyFromText(env.LIBRARY_MASTER_KEY)])
      : undefined;
  return {
    state: env.UPLOADS,
    ...(vault ? { vault } : {}),
    media: env.MEDIA,
    site: env.MEDIA_LIBRARY_URL,
    purge: purgerFor(env),
    auth: {
      googleClientId: env.GOOGLE_CLIENT_ID,
      googleClientSecret: env.GOOGLE_CLIENT_SECRET,
      sessionSecret: env.SESSION_SECRET,
      owner: env.LIBRARY_OWNER,
      editors: env.LIBRARY_EDITORS,
      keys: env.LIBRARY_KEYS,
    },
  };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (!isServed(new URL(request.url).pathname)) return env.ASSETS.fetch(request);
    return handle(request, await contextOf(env));
  },

  /** Once a minute (`triggers.crons`): the library's own jobs. */
  async scheduled(_controller: unknown, env: Env): Promise<void> {
    const { outcome } = await sweep(await contextOf(env));
    if (outcome?.failed) console.warn(`The sweep wrote nothing: ${outcome.failed.message}`);
  },
};
