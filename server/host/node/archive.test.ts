import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import { issueLocalLink } from '../../core/auth.ts';
import {
  LOCK,
  MANIFEST,
  encodeManifest,
  sha256Hex,
  toBytes,
  type Manifest,
} from '../../core/media/live.ts';
import { tarOf } from '../../core/media/tar.ts';
import { contextOf, importFile, install, openLibrary, LibraryError } from './install.ts';
import { memoryKeys } from './master.ts';
import { serve } from './server.ts';

const folders: string[] = [];
after(() => Promise.all(folders.map((folder) => rm(folder, { recursive: true, force: true }))));

async function newFolder() {
  const folder = await mkdtemp(join(tmpdir(), 'slidr-library-archive-'));
  folders.push(folder);
  return folder;
}

/** An archive of `files` with the manifest that names them first, as the page's export writes it. */
async function archiveOf(files: Record<string, string>) {
  const manifest: Manifest = { version: 1, published: '2026-10-26T06:22:35.306Z', files: {} };
  const list: [string, Uint8Array][] = [];
  for (const [path, text] of Object.entries(files)) {
    const bytes = toBytes(text);
    manifest.files[path] = { size: bytes.length, sha256: await sha256Hex(bytes) };
    list.push([path, bytes]);
  }
  const tar = tarOf([[MANIFEST, toBytes(encodeManifest(manifest))], ...list]);
  return new Uint8Array(
    await new Response(
      new Blob([tar as Uint8Array<ArrayBuffer>])
        .stream()
        .pipeThrough(new CompressionStream('gzip')),
    ).arrayBuffer(),
  );
}

/** A local library with an empty media folder. */
async function machine() {
  const root = await newFolder();
  const keys = memoryKeys();
  const media = join(root, 'media');
  await install({
    data: join(root, 'data'),
    owner: 'owner@example.org',
    master: { file: join(root, 'master.key') },
    keys,
    media,
  });
  const library = await openLibrary(join(root, 'data'), keys);
  return { root, media, library, context: contextOf(library) };
}

describe('an archive brought into a library on a machine', () => {
  test('fills its empty media folder from a file, as on a machine without a network', async () => {
    const { root, media, context } = await machine();
    const file = join(root, 'slidr-media.tgz');
    await writeFile(
      file,
      await archiveOf({ 'fonts/catalog.json': '{"families":[]}', 'tags/emoji.json': '{}' }),
    );
    const done = await importFile(context, file);
    assert.deepEqual(done.added, ['fonts/catalog.json', 'tags/emoji.json']);
    assert.equal(await readFile(join(media, 'fonts', 'catalog.json'), 'utf8'), '{"families":[]}');
    const manifest = JSON.parse(await readFile(join(media, MANIFEST), 'utf8')) as Manifest;
    assert.equal(manifest.published, done.published);
    // A newer archive of one of its parts changes that part alone.
    await writeFile(file, await archiveOf({ 'tags/emoji.json': '{"version":1}' }));
    const again = await importFile(context, file);
    assert.deepEqual([again.added, again.changed], [[], ['tags/emoji.json']]);
    assert.equal(await readFile(join(media, 'fonts', 'catalog.json'), 'utf8'), '{"families":[]}');
    await assert.rejects(importFile(context, join(root, 'none.tgz')), LibraryError);
  });

  test('is refused where the disk of the media has no room for it', async () => {
    const { root, context } = await machine();
    const file = join(root, 'slidr-media.tgz');
    await writeFile(file, await archiveOf({ 'tags/emoji.json': 'x'.repeat(4096) }));
    const full = {
      ...context,
      mediaFolder: { path: '/library/media', room: () => Promise.resolve({ size: 1e9, free: 10 }) },
    };
    await assert.rejects(importFile(full, file), /disk has 0\.0 MiB free/);
  });

  test('is answered over HTTP when refused, however much of it is still being sent', async () => {
    const { root, context } = await machine();
    const client = join(root, 'client');
    await mkdir(client);
    await writeFile(join(client, 'index.html'), '<!doctype html><title>L</title>');
    const own = await serve({ context, client, port: 0, mediaPath: '/media/' });
    try {
      const code = await issueLocalLink(context, 'owner@example.org');
      const signedIn = await fetch(new URL(`auth/local?code=${code}`, own.url), {
        redirect: 'manual',
      });
      const cookie = signedIn.headers.getSetCookie()[0]!.split(';')[0]!;
      /** Sends `body` as the page sends an archive, in pieces; answers the status and the error. */
      const send = (body: Uint8Array) =>
        new Promise<{ status: number; error?: string }>((done, fail) => {
          const url = new URL('api/library/archive', own.url);
          const sent = httpRequest(
            {
              host: url.hostname,
              port: url.port,
              path: url.pathname,
              method: 'POST',
              headers: {
                Cookie: cookie,
                Origin: url.origin,
                'Content-Type': 'application/gzip',
                'Content-Length': String(body.length),
              },
            },
            (response) => {
              let text = '';
              response.setEncoding('utf8');
              response.on('data', (chunk: string) => (text += chunk));
              response.on('end', () =>
                done({
                  status: response.statusCode ?? 0,
                  error: (JSON.parse(text) as { error?: string }).error,
                }),
              );
            },
          );
          sent.on('error', fail);
          for (let at = 0; at < body.length; at += 64 * 1024) {
            sent.write(body.subarray(at, at + 64 * 1024));
          }
          sent.end();
        });
      // Not an archive, and 8 MB of it: refused at its first block, answered once it is read.
      assert.deepEqual(await send(new Uint8Array(8 * 1024 * 1024).fill(65)), {
        status: 422,
        error: 'not-an-archive',
      });
      // While another publication holds the library, it waits, and says so.
      await context.state!.put(
        LOCK,
        JSON.stringify({ by: 'someone', at: new Date().toISOString() }),
      );
      assert.deepEqual(await send(await archiveOf({ 'tags/emoji.json': '{}' })), {
        status: 409,
        error: 'publishing',
      });
      await context.state!.put(LOCK, JSON.stringify({ free: true }));
      const done = await send(await archiveOf({ 'tags/emoji.json': '{}' }));
      assert.equal(done.status, 200);
      assert.equal(await (await fetch(new URL('media/tags/emoji.json', own.url))).text(), '{}');
    } finally {
      await own.close();
    }
  });
});
