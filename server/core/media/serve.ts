/**
 * The published library, served from its bucket at `/media/<path>`, as Cloudflare Pages served
 * it before (`desktop/build/media.ts` of the app, its `_headers`): any page may read it, the
 * manifest is asked for again each time, and every file answers with its SHA-256 as its ETag, so
 * a reader that has it gets 304. This is how a dev server serves its library (`pnpm dev`, and the
 * app's `pnpm media:publish --site`); media.slidr.studio is the bucket itself, with the same
 * headers set by the zone's rules (README, "Serving the library").
 *
 * Nothing here needs signing in: the library is public.
 */
import type { Context } from '../context.ts';
import { cacheControl, contentType, isLibraryPath } from './live.ts';

export const MEDIA_PREFIX = '/media/';

/** Says that the library is served from its bucket: `pnpm media:publish` of the app reads it. */
export const LIVE_HEADER = 'X-Slidr-Library';

const SHARED = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, If-None-Match',
  'Access-Control-Expose-Headers': 'ETag',
  'X-Content-Type-Options': 'nosniff',
  [LIVE_HEADER]: 'live',
};

const NOT_FOUND =
  '<!doctype html><meta charset="utf-8"><title>Not found</title><p>Slidr media library: no such file.</p>\n';

const notFound = () =>
  new Response(NOT_FOUND, {
    status: 404,
    headers: { ...SHARED, 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
  });

/** The path of the library a request names, or none when it names none. */
function pathOf(pathname: string): string | undefined {
  try {
    const path = pathname
      .slice(MEDIA_PREFIX.length)
      .split('/')
      .map((part) => decodeURIComponent(part))
      .join('/');
    return isLibraryPath(path) ? path : undefined;
  } catch {
    return undefined;
  }
}

/** Whether an `If-None-Match` names this ETag. */
function matches(header: string | null, etag: string) {
  const named = header?.split(',').map((one) => one.trim().replace(/^W\//, '')) ?? [];
  return named.includes('*') || named.includes(etag);
}

export async function serveMedia(request: Request, ctx: Context): Promise<Response> {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: SHARED });
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response(null, { status: 405, headers: { ...SHARED, Allow: 'GET, HEAD, OPTIONS' } });
  }
  if (!ctx.media) {
    return new Response('The library has no bucket here (MEDIA).', {
      status: 503,
      headers: { ...SHARED, 'Cache-Control': 'no-store' },
    });
  }
  const path = pathOf(new URL(request.url).pathname);
  if (!path) return notFound();
  const object = await ctx.media.get(path);
  if (!object) return notFound();
  const etag = `"${object.customMetadata?.sha256 ?? object.etag}"`;
  const headers: Record<string, string> = {
    ...SHARED,
    'Content-Type': object.httpMetadata?.contentType ?? contentType(path),
    'Cache-Control': cacheControl(path),
    ETag: etag,
  };
  if (matches(request.headers.get('If-None-Match'), etag)) {
    await object.body.cancel();
    return new Response(null, { status: 304, headers });
  }
  headers['Content-Length'] = String(object.size);
  if (request.method === 'HEAD') {
    await object.body.cancel();
    return new Response(null, { headers });
  }
  return new Response(object.body, { headers });
}
