/**
 * The Worker that serves the library's page (`wrangler.jsonc`). The page and its files are static
 * assets; the Worker itself answers only what they cannot: signing in with Google (`auth.ts`),
 * under `/auth/` and `/api/` (`assets.run_worker_first`).
 */
import { callback, json, login, logout, me, type AuthEnv } from './auth.ts';

interface Env extends AuthEnv {
  /** The built page (`dist/client`). */
  ASSETS: { fetch(request: Request): Promise<Response> };
}

type Route = (request: Request, env: Env) => Response | Promise<Response>;

const routes: Record<string, Partial<Record<string, Route>>> = {
  '/auth/login': { GET: login },
  '/auth/callback': { GET: callback },
  '/auth/logout': { POST: logout },
  '/api/me': { GET: me },
};

const loopback = new Set(['127.0.0.1', 'localhost', '[::1]']);

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const methods = routes[url.pathname];
    if (!methods) {
      if (url.pathname.startsWith('/auth/') || url.pathname.startsWith('/api/')) {
        return json({ error: 'not-found' }, 404);
      }
      return env.ASSETS.fetch(request);
    }
    // The cookies of a session are only ever sent over HTTPS, but on this machine.
    if (url.protocol === 'http:' && !loopback.has(url.hostname)) {
      url.protocol = 'https:';
      return Response.redirect(url.toString(), 308);
    }
    const route = methods[request.method];
    if (!route) return json({ error: 'method-not-allowed' }, 405);
    return route(request, env);
  },
};
