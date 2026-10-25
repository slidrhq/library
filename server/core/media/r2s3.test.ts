import assert from 'node:assert/strict';
import { afterEach, describe, mock, test } from 'node:test';
import { forgetLibrary } from '../uploads/library.ts';
import {
  CATALOGS,
  FONTS,
  MemoryBucket,
  PICTURE,
  R2_ACCOUNT,
  R2_CREDENTIALS,
  TEMPLATE,
  caller,
  failing,
  s3StandIn,
} from '../uploads/testing.ts';
import { LOCK, MANIFEST, encodeManifest, sha256Hex, toBytes, toText } from './live.ts';
import { encodeTags } from './merge.ts';
import { R2S3Media } from './r2s3.ts';

afterEach(() => {
  mock.restoreAll();
  forgetLibrary();
});

const media = () => new R2S3Media({ accountId: R2_ACCOUNT, bucket: 'slidr-media' }, R2_CREDENTIALS);

describe('an R2 bucket reached from a machine', () => {
  test('is written and read through its S3 API, every request signed', async () => {
    const { objects } = s3StandIn();
    const bucket = media();
    assert.equal(await bucket.get(MANIFEST), null);
    const written = await bucket.put('tags/emoji.json', '{"tags":{}}', {
      httpMetadata: {
        contentType: 'application/json',
        cacheControl: 'public, max-age=0, must-revalidate',
      },
      customMetadata: { sha256: 'abc' },
    });
    assert.ok(written);
    const held = objects.get('tags/emoji.json')!;
    assert.equal(held.headers.get('x-amz-meta-sha256'), 'abc');
    assert.equal(held.headers.get('cache-control'), 'public, max-age=0, must-revalidate');
    const read = await bucket.get('tags/emoji.json');
    assert.equal(await read!.text(), '{"tags":{}}');
    assert.deepEqual(read!.customMetadata, { sha256: 'abc' });
    assert.equal(read!.etag, written.etag);
    await assert.rejects(bucket.put('../x.json', '{}'), /Not a path of the library/);
    await bucket.delete('tags/emoji.json');
    assert.equal(await bucket.get('tags/emoji.json'), null);
  });

  test('lists its files with their hashes, each read once for each version', async () => {
    const { requests } = s3StandIn();
    const bucket = media();
    for (const path of ['icons/a.json', 'tags/b.json', 'tags/a.json']) {
      await bucket.put(path, path, { customMetadata: { sha256: `hash of ${path}` } });
    }
    const fresh = media();
    requests.length = 0;
    const page = await fresh.list({ prefix: 'tags/', include: ['customMetadata'] });
    assert.deepEqual(
      page.objects.map((one) => [one.key, one.customMetadata?.sha256]),
      [
        ['tags/a.json', 'hash of tags/a.json'],
        ['tags/b.json', 'hash of tags/b.json'],
      ],
    );
    assert.equal(requests.filter((one) => one.method === 'HEAD').length, 2);
    requests.length = 0;
    await fresh.list({ prefix: 'tags/', include: ['customMetadata'] });
    assert.equal(requests.filter((one) => one.method === 'HEAD').length, 0);
  });

  for (const honours of [true, false]) {
    test(`writes over the manifest only while it is the one read (the bucket ${honours ? 'honours' : 'ignores'} If-Match)`, async () => {
      const stand = s3StandIn();
      if (!honours) stand.ignoreIfMatch();
      const bucket = media();
      const first = await bucket.put(MANIFEST, '{"files":{}}');
      assert.ok(
        await bucket.put(MANIFEST, '{"files":{},"a":1}', { onlyIf: { etagMatches: first!.etag } }),
      );
      assert.equal(
        await bucket.put(MANIFEST, '{}', { onlyIf: { etagMatches: first!.etag } }),
        null,
      );
      assert.equal(toText(stand.objects.get(MANIFEST)!.data), '{"files":{},"a":1}');
    });
  }

  test('takes approved uploads, and is put back as it was when a write fails', async () => {
    const stand = s3StandIn();
    const bucket = media();
    const files: Record<string, unknown> = {
      'fonts/catalog.json': FONTS,
      'templates/harbour/template.json': TEMPLATE,
      'templates/pictures.json': { harbourPier: PICTURE },
      'tags/emoji.json': encodeTags({
        version: 1,
        tags: { other: { he: ['אחר'], en: ['other'] } },
      }),
      ...CATALOGS,
    };
    const manifest = {
      version: 1 as const,
      published: '2026-10-19T22:14:16.216Z',
      files: {} as Record<string, { size: number; sha256: string }>,
    };
    for (const [path, value] of Object.entries(files)) {
      const bytes = toBytes(typeof value === 'string' ? value : JSON.stringify(value));
      const sha256 = await sha256Hex(bytes);
      await bucket.put(path, bytes, { customMetadata: { sha256 } });
      manifest.files[path] = { size: bytes.length, sha256 };
    }
    await bucket.put(MANIFEST, encodeManifest(manifest));
    const { store, control } = failing(bucket);
    const owner = await caller({}, new MemoryBucket(), { MEDIA: store });
    const cake = (key: string, en = ['cake', 'birthday', 'party']) => ({
      type: 'emoji',
      action: 'tag',
      id: 'emoji',
      languages: {
        he: { tags: { [key]: ['עוגה', 'יום הולדת', 'מסיבה'] } },
        en: { tags: { [key]: en } },
      },
    });
    const made = (await (
      await owner.send('/api/uploads', 'POST', cake('birthday-cake'))
    ).json()) as { id: string };
    const approved = (await (
      await owner.send(`/api/uploads/${made.id}/status`, 'POST', { status: 'accepted' })
    ).json()) as { status: string };
    assert.equal(approved.status, 'published');
    assert.ok(toText(stand.objects.get('tags/emoji.json')!.data).includes('birthday-cake'));
    // The next fails at its first write into the bucket, and leaves the bucket as it was.
    mock.method(console, 'error', () => {});
    const second = (await (
      await owner.send(
        '/api/uploads',
        'POST',
        cake('birthday-cake', ['gateau', 'candles', 'sweet']),
      )
    ).json()) as { id: string };
    await owner.bucket.put(LOCK, JSON.stringify({ by: 'someone', at: new Date().toISOString() }));
    await owner.send(`/api/uploads/${second.id}/status`, 'POST', { status: 'accepted' });
    await owner.bucket.put(LOCK, JSON.stringify({ free: true }));
    const before = new Map([...stand.objects].map(([key, held]) => [key, held.etag]));
    control.writes = 0;
    control.fails = (write) => write === 1;
    assert.equal((await owner.send('/api/publish', 'POST', {})).status, 502);
    assert.deepEqual(new Map([...stand.objects].map(([key, held]) => [key, held.etag])), before);
  });
});
