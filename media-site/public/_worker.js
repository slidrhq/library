// media.slidr.studio, and slidr-media.pages.dev before it: the address the app reads the media
// library at (docs/media-library.md of the app). The library lives in a bucket of the library's
// Worker, which serves it at /media/ (worker/media/serve.ts) and publishes the accepted uploads
// into it; this site sends it every request, as it came, through a service binding
// (wrangler.toml), so an installed app reads the library where it always did.
export default {
  async fetch(request, env) {
    if (!env.LIBRARY) {
      return new Response('The media library is not bound to this site (LIBRARY).', {
        status: 503,
        headers: { 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' },
      });
    }
    const url = new URL(request.url);
    const target = new URL(`/media${url.pathname}${url.search}`, 'https://library.internal');
    return env.LIBRARY.fetch(new Request(target, request));
  },
};
