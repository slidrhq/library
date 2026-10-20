/**
 * The Worker that serves the library's page (`wrangler.jsonc`). The page and its files are static
 * assets; the Worker itself answers only what they cannot: the uploads to the library
 * (`uploads/api.ts`), under `/api/` (`assets.run_worker_first`).
 */
import { problem } from './http.ts';
import { uploadsApi, type UploadsEnv } from './uploads/api.ts';

interface Env extends UploadsEnv {
  /** The built page (`dist/client`). */
  ASSETS: { fetch(request: Request): Promise<Response> };
}

const loopback = new Set(['127.0.0.1', 'localhost', '[::1]']);

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
    // What is uploaded is only ever sent over HTTPS, but on this machine.
    if (url.protocol === 'http:' && !loopback.has(url.hostname)) {
      url.protocol = 'https:';
      return Response.redirect(url.toString(), 308);
    }
    try {
      return (
        (await uploadsApi(request, env)) ??
        problem(404, 'not-found', `There is no ${url.pathname}.`)
      );
    } catch (error) {
      console.error(error);
      return problem(500, 'failed', 'The server failed to answer. Try again.');
    }
  },
};
