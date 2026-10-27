/**
 * The image, as a machine runs it (docs/PLAN.md P11): built beforehand, and run here with the
 * hardening of the install script's compose.yaml, over folders of this machine. It needs Docker
 * on Linux, and sudo, to give the folders to the container's user: GitHub's Ubuntu runners
 * (.github/workflows/image.yml).
 *
 *   SLIDR_IMAGE=slidr-library:test node --import ./server/node.mjs --test docker/test/image.test.ts
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { after, before, describe, test } from 'node:test';
import { forgetMediaManifest, mediaManifest, mediaUrl } from '@slidr/media-library';
import type { Context } from '../../server/core/context.ts';
import { MANIFEST, encodeManifest, type Manifest } from '../../server/core/media/live.ts';
import { serveMedia } from '../../server/core/media/serve.ts';
import {
  ALL_LANGUAGES,
  CATALOGS,
  FONTS,
  PICTURE,
  TEMPLATE,
  designLanguages,
  webp,
} from '../../server/core/uploads/testing.ts';
import { FolderMedia } from '../../server/host/node/media.ts';

const IMAGE = process.env.SLIDR_IMAGE ?? 'slidr-library:test';
const run = promisify(execFile);
const docker = async (...args: string[]) => (await run('docker', args)).stdout.trim();
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

/** Free ports of this machine, for the containers. */
const PORT = 17543;
const TLS_PORT = 17544;
const NAME = 'slidr-library-test';
const TLS_NAME = 'slidr-library-test-tls';
const PROXY_PORT = 17545;
const PROXY_NAME = 'slidr-library-test-proxy';
const OWNER = 'owner@example.org';

let root: string;
let media: string;

/** The folders a container is given, under `at`, its own user's. */
async function folders(at: string) {
  const made = { data: join(at, 'data'), media: join(at, 'media'), keys: join(at, 'keys') };
  for (const folder of Object.values(made)) await mkdir(folder, { recursive: true });
  return made;
}

const mounts = (made: { data: string; media: string; keys: string }) => [
  ...['-v', `${made.data}:/library/data`],
  ...['-v', `${made.media}:/library/media`],
  ...['-v', `${made.keys}:/library/keys`],
];

/** Installs a library into folders, as the install script does, in a container of its own. */
async function init(made: { data: string; media: string; keys: string }, url: string) {
  await run('sudo', ['chown', '-R', '10001:10001', made.data, made.keys, made.media]);
  await docker('run', '--rm', ...mounts(made), IMAGE, 'init', '--owner', OWNER, '--url', url);
}

/** Runs the library, hardened as compose.yaml runs it, and waits until it is healthy. */
async function start(name: string, port: number, url: string, more: string[]) {
  await docker(
    'run',
    '-d',
    '--name',
    name,
    '--read-only',
    '--tmpfs',
    '/tmp',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges:true',
    '--restart',
    'unless-stopped',
    '--health-interval',
    '2s',
    '-p',
    `127.0.0.1:${port}:8080`,
    '-e',
    `LIBRARY_URL=${url}`,
    ...more,
    IMAGE,
  );
  await healthy(name);
}

async function healthy(name: string) {
  for (let tries = 0; tries < 90; tries += 1) {
    const status = await docker('inspect', '-f', '{{.State.Health.Status}}', name).catch(() => '');
    if (status === 'healthy') return;
    await new Promise((done) => setTimeout(done, 1000));
  }
  throw new Error(`${name} is not healthy:\n${await docker('logs', name).catch(() => '')}`);
}

interface Answer {
  status: number;
  headers: IncomingHttpHeaders;
  body: Buffer;
}

/** A request as it is written, its path not made over by a URL parser. */
function raw(
  path: string,
  method = 'GET',
  headers: Record<string, string> = {},
  port = PORT,
): Promise<Answer> {
  return new Promise((done, fail) => {
    const sent = httpRequest({ host: '127.0.0.1', port, path, method, headers }, (answer) => {
      const chunks: Buffer[] = [];
      answer.on('data', (chunk: Buffer) => chunks.push(chunk));
      answer.on('end', () =>
        done({ status: answer.statusCode!, headers: answer.headers, body: Buffer.concat(chunks) }),
      );
    });
    sent.on('error', fail);
    sent.end();
  });
}

/** The library of the test, with a file of each type, and what is no file of the library. */
const LIBRARY: Record<string, unknown> = {
  'fonts/catalog.json': FONTS,
  'templates/harbour/template.json': TEMPLATE,
  'templates/pictures.json': { harbourPier: PICTURE },
  ...CATALOGS,
  'templates/reference-decks/harbour.html':
    '<!doctype html><title>Harbour</title><script>document.title = "ran"</script>\n',
  'fonts/sample/sample.woff2': new Uint8Array([119, 79, 70, 50, 0, 1, 2, 3]),
  'icons/sample/star.svg': '<svg xmlns="http://www.w3.org/2000/svg"/>\n',
  'notes/read me.md': '# A note\n',
  'images/designs/m-sample.webp': webp(4, 4),
};
const bytesOf = (value: unknown) =>
  value instanceof Uint8Array
    ? value
    : new TextEncoder().encode(typeof value === 'string' ? value : JSON.stringify(value));

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'slidr-image-'));
  const made = await folders(join(root, 'plain'));
  media = made.media;
  const manifest: Manifest = { version: 1, published: '2026-10-25T21:54:56.088Z', files: {} };
  for (const [path, value] of Object.entries(LIBRARY)) {
    const bytes = bytesOf(value);
    await mkdir(dirname(join(media, path)), { recursive: true });
    await writeFile(join(media, path), bytes);
    manifest.files[path] = { size: bytes.length, sha256: sha256(bytes) };
  }
  // A link named by the manifest, which leads out of the folder.
  await symlink('/etc/hostname', join(media, 'linked.json'));
  manifest.files['linked.json'] = { size: 1, sha256: '0' };
  // What no path of the library is: hidden, the store's own, or a folder.
  await writeFile(join(media, '.slidr-library-probe.json'), '{}');
  await mkdir(join(media, 'a', '.git'), { recursive: true });
  await writeFile(join(media, 'a', '.git', 'config'), '[core]\n');
  await mkdir(join(media, '_staged'));
  await writeFile(join(media, '_staged', 'x.json'), '{}');
  await writeFile(join(media, MANIFEST), encodeManifest(manifest));
  await init(made, `http://127.0.0.1:${PORT}`);
  await start(NAME, PORT, `http://127.0.0.1:${PORT}`, mounts(made));
});

after(async () => {
  await docker('rm', '-f', NAME, TLS_NAME, PROXY_NAME).catch(() => undefined);
  await run('sudo', ['rm', '-rf', root]).catch(() => undefined);
});

/** The headers of an answer of /media/ that the two servers give alike. */
const SAME = [
  'content-type',
  'cache-control',
  'access-control-allow-origin',
  'access-control-allow-methods',
  'access-control-allow-headers',
  'access-control-expose-headers',
  'x-content-type-options',
  'x-slidr-library',
];

describe('the media at /media/, by Nginx', () => {
  const ctx = (): Context => ({ media: new FolderMedia(media), auth: {} });
  const encoded = (path: string) => path.split('/').map(encodeURIComponent).join('/');

  test('is answered as the library’s own server answers it, file by file', async () => {
    const paths = [
      ...Object.keys(LIBRARY).map(encoded),
      MANIFEST,
      'linked.json',
      'missing.json',
      '.slidr-library-probe.json',
      'a/.git/config',
      '_staged/x.json',
      'fonts',
      'fonts/',
      'a%5Cb.json',
      'a%3Ab.json',
      'a//b.json',
      '',
    ];
    for (const path of paths) {
      const nginx = await raw(`/media/${path}`);
      const node = await serveMedia(new Request(`http://127.0.0.1/media/${path}`), ctx());
      assert.equal(nginx.status, node.status, path);
      for (const name of SAME) {
        assert.equal(nginx.headers[name], node.headers.get(name) ?? undefined, `${path}: ${name}`);
      }
      assert.equal(nginx.headers['content-security-policy'], 'sandbox', path);
      if (node.status === 200) {
        assert.deepEqual(nginx.body, Buffer.from(await node.arrayBuffer()), path);
      }
    }
  });

  test('takes GET, HEAD and OPTIONS, and a reader that has a file is told so', async () => {
    const options = await raw('/media/fonts/catalog.json', 'OPTIONS');
    assert.equal(options.status, 204);
    assert.equal(options.headers['access-control-allow-origin'], '*');
    const post = await raw('/media/fonts/catalog.json', 'POST');
    assert.equal(post.status, 405);
    assert.equal(post.headers.allow, 'GET, HEAD, OPTIONS');
    const head = await raw('/media/manifest.json', 'HEAD');
    assert.deepEqual([head.status, head.body.length], [200, 0]);
    const first = await raw('/media/fonts/catalog.json');
    const etag = String(first.headers.etag);
    assert.ok(etag);
    const again = await raw('/media/fonts/catalog.json', 'GET', { 'If-None-Match': etag });
    assert.equal(again.status, 304);
  });

  test('leads nowhere out of the folder', async () => {
    for (const path of [
      '/media/%2e%2e/%2e%2e/etc/passwd',
      '/media/..%2f..%2fetc%2fpasswd',
      '/media/linked.json',
      '/media/%2e%2e/library/keys/master.key',
    ]) {
      const answer = await raw(path);
      assert.doesNotMatch(answer.body.toString('utf8'), /root:|^[A-Za-z0-9_-]{43}\s*$/, path);
    }
  });
});

describe('the page, by Nginx', () => {
  test('names its /media/, and its built files are kept a year', async () => {
    const page = (await raw('/')).body.toString('utf8');
    assert.match(page, /globalThis.__slidrMediaPath = "\/media\/"/);
    const asset = /src="(\/assets\/[^"]+\.js)"/.exec(page)?.[1];
    assert.ok(asset, page);
    const script = await raw(asset);
    assert.equal(script.status, 200);
    assert.equal(script.headers['cache-control'], 'public, max-age=31536000, immutable');
  });
});

describe('a local library, from end to end', () => {
  const origin = `http://127.0.0.1:${PORT}`;

  test('takes an upload by a token, and approval writes it into the folder', async () => {
    const login = await docker('exec', NAME, 'slidr-library', 'login');
    const link = /(http\S+auth\/local\?code=\S+)/.exec(login)?.[1];
    assert.ok(link, login);
    const signedIn = await fetch(link, { redirect: 'manual' });
    const cookie = signedIn.headers
      .getSetCookie()
      .find((one) => one.startsWith('library-session='))
      ?.split(';')[0];
    assert.ok(cookie, 'signed in');
    const session = { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json' };
    const made = await fetch(`${origin}/api/me/tokens`, {
      method: 'POST',
      headers: session,
      body: JSON.stringify({ name: 'The image’s test', scope: 'upload' }),
    });
    assert.equal(made.status, 201, await made.clone().text());
    const { token } = (await made.json()) as { token: string };

    const design = {
      type: 'designs',
      action: 'add',
      id: 'm-harbour-launch',
      group: 'events',
      subject: [1500, 540],
      languages: designLanguages(ALL_LANGUAGES),
    };
    const picture = webp(1008, 1496);
    const form = new FormData();
    form.set('upload', JSON.stringify(design));
    form.set('picture', new Blob([picture]), 'picture');
    const uploaded = await fetch(`${origin}/api/uploads`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: form,
    });
    assert.ok([200, 201].includes(uploaded.status), await uploaded.clone().text());
    const { id } = (await uploaded.json()) as { id: string };

    const approved = await fetch(`${origin}/api/uploads/${id}/status`, {
      method: 'POST',
      headers: session,
      body: JSON.stringify({ status: 'accepted' }),
    });
    assert.equal(approved.status, 200, await approved.clone().text());
    assert.equal(((await approved.json()) as { status: string }).status, 'published');

    // In the folder of this machine, and served from it.
    const written = await readFile(join(media, 'images', 'designs', 'm-harbour-launch.webp'));
    assert.deepEqual(new Uint8Array(written), picture);
    assert.ok(await readFile(join(media, 'elements', 'designs', 'managed.json')));
    const served = await raw('/media/images/designs/m-harbour-launch.webp');
    assert.deepEqual([served.status, served.headers['content-type']], [200, 'image/webp']);

    // Every file, as the app reads it, against its manifest.
    Object.assign(globalThis, { __SLIDR_MEDIA_PATH__: '/media/', location: { origin } });
    forgetMediaManifest();
    const manifest = await mediaManifest();
    assert.ok(manifest.files['images/designs/m-harbour-launch.webp']);
    for (const [path, entry] of Object.entries(manifest.files)) {
      if (path === 'linked.json') continue;
      const bytes = new Uint8Array(await (await fetch(mediaUrl(path))).arrayBuffer());
      assert.deepEqual([bytes.length, sha256(bytes)], [entry.size, entry.sha256], path);
    }
    forgetMediaManifest();
  });
});

describe('the container', () => {
  test('runs as its own user, on a root it cannot write', async () => {
    assert.equal(await docker('exec', NAME, 'id', '-u'), '10001');
    await assert.rejects(docker('exec', NAME, 'sh', '-c', 'touch /etc/written'));
  });

  test('keeps no code of the owner’s link in its log', async () => {
    const { stdout, stderr } = await run('docker', ['logs', NAME]);
    assert.match(stdout + stderr, /\/auth\/local/);
    assert.doesNotMatch(stdout + stderr, /code=/);
  });

  test('ends when its server ends, and Docker starts it again', async () => {
    await docker('exec', NAME, 'sh', '-c', 'kill "$(cat /tmp/slidr-node.pid)"');
    for (let tries = 0; tries < 60; tries += 1) {
      if (Number(await docker('inspect', '-f', '{{.RestartCount}}', NAME)) > 0) break;
      await new Promise((done) => setTimeout(done, 500));
    }
    assert.ok(Number(await docker('inspect', '-f', '{{.RestartCount}}', NAME)) > 0);
    await healthy(NAME);
  });

  test('stops within ten seconds', async () => {
    const started = Date.now();
    await docker('stop', '-t', '10', NAME);
    assert.ok(Date.now() - started < 10_000, `${Date.now() - started} ms`);
    await docker('start', NAME);
    await healthy(NAME);
  });
});

describe('a local library behind the organization’s proxy', () => {
  test('answers the proxy alone, and the container itself', async () => {
    const made = await folders(join(root, 'proxied'));
    const url = 'https://library.test';
    await init(made, url);
    // The proxy is another machine's: this one, reaching the port straight, is not it.
    await start(PROXY_NAME, PROXY_PORT, url, [
      ...mounts(made),
      ...['-e', 'LIBRARY_TRUSTED_PROXY=192.0.2.1'],
    ]);
    for (const path of ['/api/me', '/media/manifest.json', '/']) {
      const answer = await raw(path, 'GET', { 'X-Forwarded-Host': 'library.test' }, PROXY_PORT);
      assert.equal(answer.status, 403, path);
    }
  });
});

describe('a local library over HTTPS, by Nginx', () => {
  test('is reached by its name, and its session is the host’s alone', async () => {
    const made = await folders(join(root, 'tls'));
    const tls = join(root, 'tls', 'tls');
    await mkdir(tls);
    await run('openssl', [
      ...['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes'],
      ...['-days', '2', '-subj', '/CN=library.test', '-addext', 'subjectAltName=DNS:library.test'],
      ...['-keyout', join(tls, 'key.pem'), '-out', join(tls, 'cert.pem')],
    ]);
    const url = `https://library.test:${TLS_PORT}`;
    await init(made, url);
    await run('sudo', ['chown', '-R', '10001:10001', tls]);
    await start(TLS_NAME, TLS_PORT, url, [...mounts(made), '-v', `${tls}:/library/tls:ro`]);
    const ca = await run('sudo', ['cat', join(tls, 'cert.pem')]).then((done) => done.stdout);
    const secure = (path: string) =>
      new Promise<Answer>((done, fail) => {
        const sent = httpsRequest(
          {
            host: '127.0.0.1',
            port: TLS_PORT,
            path,
            servername: 'library.test',
            headers: { Host: `library.test:${TLS_PORT}` },
            ca,
          },
          (answer) => {
            const chunks: Buffer[] = [];
            answer.on('data', (chunk: Buffer) => chunks.push(chunk));
            answer.on('end', () =>
              done({
                status: answer.statusCode!,
                headers: answer.headers,
                body: Buffer.concat(chunks),
              }),
            );
          },
        );
        sent.on('error', fail);
        sent.end();
      });
    assert.equal((await secure('/api/me')).status, 200);
    const login = await docker('exec', TLS_NAME, 'slidr-library', 'login');
    const link = new URL(/(http\S+auth\/local\?code=\S+)/.exec(login)![1]!);
    assert.equal(link.origin, url);
    const signedIn = await secure(link.pathname + link.search);
    const cookies = [signedIn.headers['set-cookie'] ?? []].flat();
    assert.ok(
      cookies.some((one) => one.startsWith('__Host-library-session=') && /Secure/.test(one)),
      cookies.join('\n'),
    );
  });
});
