/**
 * The library's server, on whatever host it runs (`../host/`). It answers what the page's files
 * cannot, under `/auth/`, `/api/` and `/media/`:
 *
 * - signing in (`auth.ts`, `oidc.ts`), the library's people (`members.ts`, `people.ts`), and
 *   their tokens (`profile.ts`, `tokens.ts`);
 * - the uploads to the library, which anyone signed in makes, and its reviewers accept and
 *   publish (`uploads/api.ts`, `uploads/access.ts`, `media/publish.ts`);
 * - the published library itself, from its store (`media/serve.ts`), as a dev server serves it.
 *   media.slidr.studio is that bucket itself, and no Worker runs when it is read
 *   (`media/live.ts`).
 *
 * Everything else is the page's, which the host serves as it was built.
 */
import { callback, json, local, login, logout, me } from './auth.ts';
import type { Context } from './context.ts';
import { problem } from './http.ts';
import { MEDIA_PREFIX, serveMedia } from './media/serve.ts';
import { membersApi } from './members.ts';
import { profileApi } from './profile.ts';
import { settingsApi } from './settings.ts';
import { uploadsApi } from './uploads/api.ts';

type Route = (request: Request, ctx: Context) => Response | Promise<Response>;

const routes: Record<string, Partial<Record<string, Route>>> = {
  '/auth/login': { GET: login },
  '/auth/callback': { GET: callback },
  '/auth/logout': { POST: logout },
  '/auth/local': { GET: local },
  '/api/me': { GET: me },
};

const loopback = new Set(['127.0.0.1', 'localhost', '[::1]']);

/** Whether a request is the server's to answer; the rest is the page's. */
export const isServed = (pathname: string) =>
  pathname.startsWith(MEDIA_PREFIX) ||
  pathname.startsWith('/auth/') ||
  pathname.startsWith('/api/');

/** The answer to a request the server answers (`isServed`). */
export async function handle(request: Request, ctx: Context): Promise<Response> {
  const url = new URL(request.url);
  // The library is public, and read from anywhere: over HTTP too, on this machine.
  if (url.pathname.startsWith(MEDIA_PREFIX)) return serveMedia(request, ctx);
  // The cookies of a session, and what is uploaded, are only ever sent over HTTPS, but on this
  // machine.
  if (url.protocol === 'http:' && !loopback.has(url.hostname)) {
    url.protocol = 'https:';
    return Response.redirect(url.toString(), 308);
  }
  try {
    const methods = routes[url.pathname];
    if (methods) {
      const route = methods[request.method];
      if (!route) return json({ error: 'method-not-allowed' }, 405);
      return await route(request, ctx);
    }
    return (
      (await membersApi(request, ctx)) ??
      (await profileApi(request, ctx)) ??
      (await settingsApi(request, ctx)) ??
      (await uploadsApi(request, ctx)) ??
      json({ error: 'not-found' }, 404)
    );
  } catch (error) {
    console.error(error);
    return problem(500, 'failed', 'The server failed to answer. Try again.');
  }
}
