import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, afterEach, describe, mock, test } from 'node:test';
import type { Bucket } from '../../core/bucket.ts';
import {
  MemoryBucket,
  caller,
  designLanguages,
  publishLibrary,
  webp,
} from '../../core/uploads/testing.ts';
import { FolderBucket, partName } from './state.ts';

const folders: string[] = [];

after(() => Promise.all(folders.map((folder) => rm(folder, { recursive: true, force: true }))));
afterEach(() => mock.restoreAll());

async function newFolder() {
  const folder = await mkdtemp(join(tmpdir(), 'slidr-library-state-'));
  folders.push(folder);
  return folder;
}

const STORES: [string, () => Promise<Bucket>][] = [
  ['in memory', () => Promise.resolve(new MemoryBucket())],
  ['in a folder', async () => new FolderBucket(await newFolder())],
];

const textOf = async (bucket: Bucket, key: string) => (await bucket.get(key))?.text();

const keysOf = async (bucket: Bucket, options: Parameters<Bucket['list']>[0] = {}) =>
  (await bucket.list(options)).objects.map((one) => one.key);

for (const [where, make] of STORES) {
  describe(`a store ${where}`, () => {
    test('keeps an object, its type and its metadata', async () => {
      const bucket = await make();
      assert.equal(await bucket.get('uploads/none.json'), null);
      const bytes = new Uint8Array([0, 1, 2, 250]);
      const put = await bucket.put('files/u-1/picture', bytes, {
        httpMetadata: { contentType: 'image/webp' },
        customMetadata: { sha256: 'abc' },
      });
      const object = await bucket.get('files/u-1/picture');
      assert.ok(put && object);
      assert.equal(object.etag, put.etag);
      assert.equal(object.size, 4);
      assert.equal(object.httpMetadata?.contentType, 'image/webp');
      assert.deepEqual(object.customMetadata, { sha256: 'abc' });
      assert.deepEqual(new Uint8Array(await object.arrayBuffer()), bytes);
      await bucket.put('uploads/u-1.json', '{"id":"u-1"}');
      assert.equal(await textOf(bucket, 'uploads/u-1.json'), '{"id":"u-1"}');
      const streamed = await new Response((await bucket.get('uploads/u-1.json'))!.body).text();
      assert.equal(streamed, '{"id":"u-1"}');
    });

    test('writes over a version only while it is that version', async () => {
      const bucket = await make();
      const first = await bucket.put('uploads/u-1.json', 'one');
      assert.ok(first);
      const second = await bucket.put('uploads/u-1.json', 'two', {
        onlyIf: { etagMatches: first.etag },
      });
      assert.ok(second);
      assert.notEqual(second.etag, first.etag);
      const stale = await bucket.put('uploads/u-1.json', 'three', {
        onlyIf: { etagMatches: first.etag },
      });
      assert.equal(stale, null);
      assert.equal(await textOf(bucket, 'uploads/u-1.json'), 'two');
      const none = await bucket.put('uploads/u-2.json', 'new', {
        onlyIf: { etagMatches: first.etag },
      });
      assert.equal(none, null);
      assert.equal(await bucket.get('uploads/u-2.json'), null);
    });

    test('lists its keys in order, a page at a time, by prefix', async () => {
      const bucket = await make();
      for (const key of ['uploads/b.json', 'files/b/x', 'uploads/a.json', 'uploads/c.json']) {
        await bucket.put(key, key, { customMetadata: { key } });
      }
      assert.deepEqual(await keysOf(bucket), [
        'files/b/x',
        'uploads/a.json',
        'uploads/b.json',
        'uploads/c.json',
      ]);
      const page = await bucket.list({ prefix: 'uploads/', limit: 2, include: ['customMetadata'] });
      assert.deepEqual(
        page.objects.map((one) => [one.key, one.customMetadata?.key]),
        [
          ['uploads/a.json', 'uploads/a.json'],
          ['uploads/b.json', 'uploads/b.json'],
        ],
      );
      assert.equal(page.truncated, true);
      const rest = await bucket.list({ prefix: 'uploads/', startAfter: 'uploads/b.json' });
      assert.deepEqual(
        rest.objects.map((one) => one.key),
        ['uploads/c.json'],
      );
      assert.equal(rest.truncated, false);
      assert.deepEqual(await keysOf(bucket, { prefix: 'uploads/b' }), ['uploads/b.json']);
      assert.deepEqual(await keysOf(bucket, { prefix: 'tokens/' }), []);
    });

    test('takes keys a file system would refuse, or take for one another', async () => {
      const bucket = await make();
      const keys = [
        'media/history/2026-10-25T10:00:00.000Z/fonts/A*b.json',
        'people/Someone@Example.com.json',
        'people/someone@example.com.json',
        'x/con.json',
        'x/ends with a dot.',
        'x/מסמך.json',
      ];
      for (const key of keys) await bucket.put(key, key);
      for (const key of keys) assert.equal(await textOf(bucket, key), key);
      assert.deepEqual(await keysOf(bucket), [...keys].sort());
    });

    test('forgets what it deletes', async () => {
      const bucket = await make();
      for (const key of ['a/1', 'a/2', 'a/3']) await bucket.put(key, key);
      await bucket.delete('a/1');
      await bucket.delete(['a/2', 'a/none']);
      assert.equal(await bucket.get('a/1'), null);
      assert.deepEqual(await keysOf(bucket), ['a/3']);
    });
  });
}

describe('a store in a folder', () => {
  test('names each part of a key as every file system takes it', () => {
    assert.equal(partName('u-0a9.json'), 'u-0a9.json');
    assert.equal(partName('2026-10-25T10:00:00.000Z'), '2026-10-25%5410%3A00%3A00.000%5A');
    assert.equal(partName('A*b'), '%41%2Ab');
    assert.equal(partName('con.json'), '%63on.json');
    assert.equal(partName('nul'), '%6Eul');
    assert.equal(partName('end.'), 'end%2E');
    assert.equal(decodeURIComponent(partName('People/a b')), 'People/a b');
  });

  test('lets one of two writes over the same version win', async () => {
    const bucket = new FolderBucket(await newFolder());
    const first = await bucket.put('uploads/u-1.json', 'one');
    const [a, b] = await Promise.all([
      bucket.put('uploads/u-1.json', 'a', { onlyIf: { etagMatches: first!.etag } }),
      bucket.put('uploads/u-1.json', 'b', { onlyIf: { etagMatches: first!.etag } }),
    ]);
    assert.equal([a, b].filter(Boolean).length, 1);
    assert.equal(await textOf(bucket, 'uploads/u-1.json'), a ? 'a' : 'b');
  });

  test('knows bytes written without their metadata by their own hash', async () => {
    const folder = await newFolder();
    const bucket = new FolderBucket(folder);
    const put = await bucket.put('a/1', 'one');
    await rm(join(folder, 'meta'), { recursive: true });
    assert.equal((await bucket.get('a/1'))?.etag, put!.etag);
  });

  test('keeps the uploads as the server writes them', async () => {
    publishLibrary();
    const folder = await newFolder();
    const { call, send, upload } = await caller({}, new FolderBucket(folder));
    const design = {
      type: 'designs',
      action: 'add',
      id: 'm-harbour-launch',
      group: 'events',
      subject: [1500, 540],
      languages: designLanguages(),
    };
    const made = (await (await upload(design, { picture: webp(1008, 1496) })).json()) as {
      id: string;
      files: { picture: { url: string } };
    };
    const at = `/api/uploads/${made.id}`;
    const picture = await call(made.files.picture.url);
    assert.deepEqual(new Uint8Array(await picture.arrayBuffer()), webp(1008, 1496));
    const listed = (await (await call('/api/uploads')).json()) as { uploads: { id: string }[] };
    assert.deepEqual(
      listed.uploads.map((one) => one.id),
      [made.id],
    );
    const rejected = await send(`${at}/status`, 'POST', { status: 'rejected', note: 'Cropped.' });
    assert.equal(((await rejected.json()) as { status: string }).status, 'rejected');
    assert.equal((await call(at, { method: 'DELETE' })).status, 204);
    assert.equal((await call(at)).status, 404);
    // Nothing of the upload is kept; the library's people are.
    for (const part of ['uploads', 'files']) {
      const left = await readdir(join(folder, 'objects', part), {
        recursive: true,
        withFileTypes: true,
      }).catch(() => []);
      assert.deepEqual(
        left.filter((entry) => entry.isFile()),
        [],
        part,
      );
    }
  });
});
