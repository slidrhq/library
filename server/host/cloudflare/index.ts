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

export interface Env {
  /** The built page (`dist/client`). */
  ASSETS: { fetch(request: Request): Promise<Response> };
  /** What is uploaded, until it is published (README, "Uploading"). */
  UPLOADS?: Bucket;
  /** The published library (README, "Publishing the uploads"). */
  MEDIA?: Bucket;
  /** The site the library is read from before it is in its bucket: the published one by default. */
  MEDIA_LIBRARY_URL?: string;
  /** The zone of the library's address, and a token that purges its cache (`media/cache.ts`). */
  MEDIA_ZONE_ID?: string;
  MEDIA_PURGE_TOKEN?: string;
  /** Secrets of the Worker (README, "Signing in"): what `AuthSettings` of the context says. */
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  SESSION_SECRET?: string;
  LIBRARY_EDITORS?: string;
  LIBRARY_KEYS?: string;
}

/** What the server is given: the Worker's bindings and secrets, by what they are for. */
export function contextOf(env: Partial<Env>): Context {
  return {
    state: env.UPLOADS,
    media: env.MEDIA,
    site: env.MEDIA_LIBRARY_URL,
    purge: purgerFor(env),
    auth: {
      googleClientId: env.GOOGLE_CLIENT_ID,
      googleClientSecret: env.GOOGLE_CLIENT_SECRET,
      sessionSecret: env.SESSION_SECRET,
      editors: env.LIBRARY_EDITORS,
      keys: env.LIBRARY_KEYS,
    },
  };
}

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    if (!isServed(new URL(request.url).pathname)) return env.ASSETS.fetch(request);
    return handle(request, contextOf(env));
  },
};
