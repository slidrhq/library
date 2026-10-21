import assert from 'node:assert/strict';
import { test } from 'node:test';
// @ts-expect-error: the site's Worker is plain JavaScript, deployed as it is (media-site/).
import site from '../../media-site/public/_worker.js';

interface Site {
  fetch(
    request: Request,
    env: { LIBRARY?: { fetch(request: Request): Promise<Response> } },
  ): Promise<Response>;
}

test('the site sends every request to the library’s Worker, at /media/, as it came', async () => {
  const seen: Request[] = [];
  const LIBRARY = {
    fetch(request: Request) {
      seen.push(request);
      return Promise.resolve(new Response('ok', { headers: { ETag: '"x"' } }));
    },
  };
  const answer = await (site as Site).fetch(
    new Request('https://slidr-media.pages.dev/fonts/heebo/a%20b.woff2?v=1', {
      method: 'HEAD',
      headers: { 'If-None-Match': '"x"' },
    }),
    { LIBRARY },
  );
  assert.equal(answer.headers.get('ETag'), '"x"');
  const [sent] = seen;
  assert.equal(new URL(sent!.url).pathname, '/media/fonts/heebo/a%20b.woff2');
  assert.equal(new URL(sent!.url).search, '?v=1');
  assert.equal(sent!.method, 'HEAD');
  assert.equal(sent!.headers.get('If-None-Match'), '"x"');
  const unbound = await (site as Site).fetch(
    new Request('https://slidr-media.pages.dev/manifest.json'),
    {},
  );
  assert.equal(unbound.status, 503);
});
