import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, afterEach, describe, mock, test } from 'node:test';
import {
  MANIFEST,
  encodeManifest,
  putFile,
  putManifest,
  sha256Hex,
  toBytes,
  type Manifest,
} from '../../core/media/live.ts';
import { encodeTags } from '../../core/media/merge.ts';
import {
  CATALOGS,
  FONTS,
  MemoryBucket,
  PICTURE,
  TEMPLATE,
  caller,
} from '../../core/uploads/testing.ts';
import { seed } from './install.ts';
import { FolderMedia } from './media.ts';

const folders: string[] = [];
after(() => Promise.all(folders.map((folder) => rm(folder, { recursive: true, force: true }))));
afterEach(() => mock.restoreAll());

async function newFolder() {
  const folder = await mkdtemp(join(tmpdir(), 'slidr-library-media-'));
  folders.push(folder);
  return folder;
}

const textOf = async (media: FolderMedia, key: string) => (await media.get(key))?.text();

/** Every file under a folder, by its path in it. */
async function filesIn(folder: string) {
  const found: string[] = [];
  for (const entry of await readdir(folder, { recursive: true, withFileTypes: true })) {
    if (entry.isFile()) {
      found.push(
        join(entry.parentPath, entry.name)
          .slice(folder.length + 1)
          .replaceAll('\\', '/'),
      );
    }
  }
  return found.sort();
}

const bytesOf = (value: unknown) =>
  value instanceof Uint8Array
    ? value
    : toBytes(typeof value === 'string' ? value : JSON.stringify(value));

/** The library in the folder: each file under its path, and the manifest of them. */
async function liveFolder(media: FolderMedia, files: Record<string, unknown>) {
  const manifest: Manifest = { version: 1, published: '2026-10-19T22:14:16.216Z', files: {} };
  for (const [path, value] of Object.entries(files)) {
    const bytes = bytesOf(value);
    const sha256 = await sha256Hex(bytes);
    await putFile(media, path, bytes, sha256);
    manifest.files[path] = { size: bytes.length, sha256 };
  }
  await putManifest(media, encodeManifest(manifest));
  return manifest;
}

describe('the library in a folder', () => {
  test('keeps each file under its path, served as the bucket serves it', async () => {
    const folder = await newFolder();
    const media = new FolderMedia(folder);
    assert.equal(await media.get('fonts/catalog.json'), null);
    const written = await media.put('fonts/catalog.json', '{"families":[]}');
    const object = await media.get('fonts/catalog.json');
    assert.ok(written && object);
    assert.equal(object.etag, written.etag);
    assert.equal(await object.text(), '{"families":[]}');
    assert.deepEqual(object.httpMetadata, {
      contentType: 'application/json',
      cacheControl: 'public, max-age=0, must-revalidate',
    });
    assert.equal(object.customMetadata?.sha256, await sha256Hex(toBytes('{"families":[]}')));
    assert.equal(await readFile(join(folder, 'fonts', 'catalog.json'), 'utf8'), '{"families":[]}');
  });

  test('writes over a version only while it is that version', async () => {
    const media = new FolderMedia(await newFolder());
    const first = await media.put(MANIFEST, '{"files":{}}');
    const stale = first!.etag;
    // Another moment, another size: another version.
    assert.ok(await media.put(MANIFEST, '{"files":{},"x":1}', { onlyIf: { etagMatches: stale } }));
    assert.equal(await media.put(MANIFEST, '{}', { onlyIf: { etagMatches: stale } }), null);
    assert.equal(await textOf(media, MANIFEST), '{"files":{},"x":1}');
  });

  test('lists the library in order, a page at a time, with its hashes', async () => {
    const folder = await newFolder();
    const media = new FolderMedia(folder);
    const files = { 'tags/b.json': 'b', 'icons/a.json': 'a', 'tags/a.json': 'aa' };
    const manifest = await liveFolder(media, files);
    const page = await media.list({ limit: 2, include: ['customMetadata', 'httpMetadata'] });
    assert.deepEqual(
      page.objects.map((one) => one.key),
      ['icons/a.json', 'manifest.json'],
    );
    assert.equal(page.truncated, true);
    assert.equal(page.objects[0]!.customMetadata?.sha256, manifest.files['icons/a.json']!.sha256);
    assert.equal(page.objects[1]!.httpMetadata?.cacheControl, 'no-cache');
    const tags = await media.list({ prefix: 'tags/' });
    assert.deepEqual(
      tags.objects.map((one) => one.key),
      ['tags/a.json', 'tags/b.json'],
    );
    await media.delete('tags/a.json');
    assert.equal(await media.get('tags/a.json'), null);
    // The folder holds the library and nothing else: nothing of how it was written is left.
    assert.deepEqual(await filesIn(folder), ['icons/a.json', 'manifest.json', 'tags/b.json']);
  });

  test('takes no path that is not one of the library, and follows no link out of it', async () => {
    const root = await newFolder();
    const folder = join(root, 'media');
    const elsewhere = join(root, 'elsewhere');
    await mkdir(folder);
    await mkdir(elsewhere);
    await writeFile(join(elsewhere, 'secret.json'), '{"secret":true}');
    const media = new FolderMedia(folder);
    for (const key of [
      '_history/x.json',
      '../elsewhere/secret.json',
      'a/../../x',
      '/etc/x',
      'a\\b',
    ]) {
      await assert.rejects(media.put(key, 'x'), /Not a path of the library|Outside/, key);
      assert.equal(await media.get(key), null, key);
    }
    // A folder of the library that is a link to another folder leads nowhere.
    await symlink(elsewhere, join(folder, 'linked'), 'junction');
    assert.equal(await media.get('linked/secret.json'), null);
    await assert.rejects(media.put('linked/new.json', '{}'), /Outside the library/);
    assert.deepEqual(await readdir(elsewhere), ['secret.json']);
  });
});

/** The files the library's checks read, as in the tests of a publication over a bucket. */
const LIBRARY: Record<string, unknown> = {
  'fonts/catalog.json': FONTS,
  'templates/harbour/template.json': TEMPLATE,
  'templates/pictures.json': { harbourPier: PICTURE },
  'tags/emoji.json': encodeTags({ version: 1, tags: { other: { he: ['אחר'], en: ['other'] } } }),
  ...CATALOGS,
};

describe('a library on a machine, in a folder', () => {
  test('publishes into the folder, and serves it at /media/', async () => {
    const folder = await newFolder();
    const media = new FolderMedia(folder);
    await liveFolder(media, LIBRARY);
    const owner = await caller({}, new MemoryBucket(), { MEDIA: media });
    const made = (await (
      await owner.send('/api/uploads', 'POST', {
        type: 'emoji',
        action: 'tag',
        id: 'emoji',
        languages: {
          he: { tags: { 'birthday-cake': ['עוגה', 'יום הולדת', 'מסיבה'] } },
          en: { tags: { 'birthday-cake': ['cake', 'birthday', 'party'] } },
        },
      })
    ).json()) as { id: string };
    const accepted = await owner.send(`/api/uploads/${made.id}/status`, 'POST', {
      status: 'accepted',
    });
    assert.equal(accepted.status, 200, await accepted.clone().text());
    const published = await owner.send('/api/publish', 'POST', {});
    assert.equal(published.status, 200, await published.clone().text());
    const tags = JSON.parse(await readFile(join(folder, 'tags', 'emoji.json'), 'utf8')) as {
      tags: Record<string, unknown>;
    };
    assert.ok(tags.tags['birthday-cake']);
    const manifest = JSON.parse(await readFile(join(folder, MANIFEST), 'utf8')) as Manifest;
    assert.equal(
      manifest.files['tags/emoji.json']!.sha256,
      await sha256Hex(await readFile(join(folder, 'tags', 'emoji.json'))),
    );
    // The folder holds the library only; the publication's records are beside the uploads.
    assert.deepEqual(await filesIn(folder), [...Object.keys(LIBRARY), MANIFEST].sort());
    const served = await owner.call('/media/tags/emoji.json');
    assert.equal(served.headers.get('ETag'), `"${manifest.files['tags/emoji.json']!.sha256}"`);
    assert.match(await served.text(), /birthday-cake/);
  });

  test('is seeded from a published library, file by file, and goes on where it stopped', async () => {
    const site = 'https://published.example/';
    const files: Record<string, Uint8Array> = {
      'fonts/catalog.json': toBytes('{"families":[]}'),
      'icons/lucide/a.json': toBytes('{"a":1}'),
      'images/designs/m-x.webp': new Uint8Array([82, 73, 70, 70, 1, 2, 3]),
    };
    const manifest: Manifest = { version: 1, published: '2026-10-24T21:54:56.088Z', files: {} };
    for (const [path, bytes] of Object.entries(files)) {
      manifest.files[path] = { size: bytes.length, sha256: await sha256Hex(bytes) };
    }
    let failOnce = true;
    mock.method(globalThis, 'fetch', (input: string | URL | Request) => {
      const path = decodeURI(
        String(input instanceof Request ? input.url : input).slice(site.length),
      );
      if (path === MANIFEST) return Promise.resolve(Response.json(manifest));
      if (path === 'icons/lucide/a.json' && failOnce) {
        failOnce = false;
        return Promise.resolve(new Response('', { status: 503 }));
      }
      const bytes = files[path];
      return Promise.resolve(
        bytes ? new Response(bytes as Uint8Array<ArrayBuffer>) : new Response('', { status: 404 }),
      );
    });
    const folder = await newFolder();
    const steps: number[] = [];
    const done = await seed({ media: new FolderMedia(folder), auth: {} }, site, (step) =>
      steps.push(step.present),
    );
    assert.equal(done.done, true);
    assert.deepEqual(steps, [2, 3]);
    assert.deepEqual(await filesIn(folder), [...Object.keys(files), MANIFEST].sort());
    assert.deepEqual(
      JSON.parse(await readFile(join(folder, MANIFEST), 'utf8')),
      JSON.parse(encodeManifest(manifest)),
    );
    // Seeded, it is not seeded again.
    await assert.rejects(
      seed({ media: new FolderMedia(folder), auth: {} }, site),
      /has the library already/,
    );
  });
});
