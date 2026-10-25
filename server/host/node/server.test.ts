import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { contextOf, install, openLibrary } from './install.ts';
import { memoryKeys } from './master.ts';
import { serve, type Serving } from './server.ts';

const folders: string[] = [];
let serving: Serving;
let base: string;

async function newFolder() {
  const folder = await mkdtemp(join(tmpdir(), 'slidr-library-server-'));
  folders.push(folder);
  return folder;
}

/** A request as it comes, with the headers given, `Host` among them. */
function raw(
  path: string,
  headers: Record<string, string> = {},
  method = 'GET',
): Promise<{
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}> {
  const url = new URL(base);
  return new Promise((done, fail) => {
    const sent = httpRequest(
      { host: url.hostname, port: url.port, path, method, headers },
      (response) => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk: string) => (body += chunk));
        response.on('end', () =>
          done({ status: response.statusCode ?? 0, headers: response.headers, body }),
        );
      },
    );
    sent.on('error', fail);
    sent.end();
  });
}

before(async () => {
  const client = await newFolder();
  await writeFile(join(client, 'index.html'), '<!doctype html><title>Slidr Library</title>');
  await mkdir(join(client, 'assets'));
  await writeFile(join(client, 'assets', 'app-0a1b.js'), 'console.log(1);');
  const data = await newFolder();
  const keys = memoryKeys();
  await install({ data, owner: 'owner@example.org', master: 'keychain', keys });
  const library = await openLibrary(data, keys);
  serving = await serve({ context: await contextOf(library), client, port: 0 });
  base = serving.url;
});

after(async () => {
  await serving?.close();
  await Promise.all(folders.map((folder) => rm(folder, { recursive: true, force: true })));
});

describe('the library on a machine', () => {
  test('listens on this machine only', () => {
    assert.match(base, /^http:\/\/127\.0\.0\.1:\d+\/$/);
  });

  test('serves the built page, and its own pages from it', async () => {
    const home = await fetch(base);
    assert.equal(home.status, 200);
    assert.equal(home.headers.get('Content-Type'), 'text/html; charset=utf-8');
    assert.equal(home.headers.get('Cache-Control'), 'no-cache');
    assert.match(await home.text(), /Slidr Library/);
    const designs = await fetch(new URL('designs/m-harbour-launch', base));
    assert.equal(designs.status, 200);
    assert.match(await designs.text(), /Slidr Library/);
    const script = await fetch(new URL('assets/app-0a1b.js', base));
    assert.equal(script.headers.get('Content-Type'), 'text/javascript; charset=utf-8');
    assert.equal(script.headers.get('Cache-Control'), 'public, max-age=31536000, immutable');
    assert.equal((await fetch(new URL('assets/gone.js', base))).status, 404);
    assert.equal((await fetch(base, { method: 'POST' })).status, 405);
  });

  test('serves nothing from outside the page', async () => {
    for (const path of ['/..%2Fhost.json', '/%2e%2e/%2e%2e/host.json', '/..%5Chost.json']) {
      const answer = await raw(path);
      assert.equal(answer.status, 404, path);
      assert.doesNotMatch(answer.body, /master/, path);
    }
  });

  test('answers the API with the library’s server', async () => {
    const me = await fetch(new URL('api/me', base));
    assert.equal(me.headers.get('Content-Type'), 'application/json; charset=utf-8');
    assert.deepEqual(await me.json(), { signIn: false, user: null });
    assert.equal((await fetch(new URL('api/content', base))).status, 200);
    assert.equal((await fetch(new URL('api/nothing', base))).status, 404);
    const media = await fetch(new URL('media/manifest.json', base));
    assert.equal(media.status, 503);
    assert.equal(media.headers.get('Access-Control-Allow-Origin'), '*');
  });

  test('takes what is sent, and checks where it comes from', async () => {
    const origin = base.replace(/\/$/, '');
    const out = await fetch(new URL('auth/logout', base), {
      method: 'POST',
      headers: { Origin: origin },
    });
    assert.equal(out.status, 200);
    assert.match(out.headers.get('Set-Cookie') ?? '', /library-session=; .*Max-Age=0/);
    const away = await fetch(new URL('auth/logout', base), {
      method: 'POST',
      headers: { Origin: 'https://evil.example' },
    });
    assert.equal(away.status, 403);
    const sent = await fetch(new URL('api/uploads', base), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: origin },
      body: JSON.stringify({ type: 'designs' }),
    });
    assert.equal(sent.status, 401);
  });

  test('answers only a request that names it as this machine', async () => {
    const port = new URL(base).port;
    assert.equal((await raw('/api/me', { Host: `localhost:${port}` })).status, 200);
    const rebound = await raw('/api/me', { Host: `evil.example:${port}` });
    assert.equal(rebound.status, 421);
    assert.equal((await raw('/', { Host: 'evil.example' })).status, 421);
  });
});
