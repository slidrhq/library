import assert from 'node:assert/strict';
import { afterEach, describe, mock, test } from 'node:test';
import { forgetLibrary } from '../uploads/library.ts';
import {
  ALL_LANGUAGES,
  CATALOGS,
  FONTS,
  MEDIA,
  PICTURE,
  TEMPLATE,
  EDITOR,
  MemoryBucket,
  caller,
  designLanguages,
  failing,
  frenchSample,
  webp,
} from '../uploads/testing.ts';
import worker, { contextOf } from '../../host/cloudflare/index.ts';
import { createUpload, newUploadId, readUpload, type Upload } from '../uploads/store.ts';
import { purgerFor } from './cache.ts';
import {
  LOCK,
  MANIFEST,
  encodeManifest,
  sha256Hex,
  toBytes,
  toText,
  type Manifest,
} from './live.ts';
import { clear, sweep } from './sweep.ts';
import {
  emptyCatalog,
  encodeTags,
  mergeDesign,
  mergeTags,
  mergeTranslation,
  spliceSample,
  type DesignRecord,
} from './merge.ts';

afterEach(() => {
  mock.restoreAll();
  forgetLibrary();
});

const read = async <T>(response: Response) => (await response.json()) as T;

/** A file of the library, as bytes. */
const bytesOf = (value: unknown) =>
  value instanceof Uint8Array
    ? value
    : toBytes(typeof value === 'string' ? value : JSON.stringify(value));

/** The library in its bucket: each file under its path with its hash, and the manifest of them. */
async function liveLibrary(
  bucket: MemoryBucket,
  files: Record<string, unknown>,
  published = '2026-10-19T22:14:16.216Z',
) {
  const manifest: Manifest = { version: 1, published, files: {} };
  for (const [path, value] of Object.entries(files)) {
    const bytes = bytesOf(value);
    const sha256 = await sha256Hex(bytes);
    await bucket.put(path, bytes, { customMetadata: { sha256 } });
    manifest.files[path] = { size: bytes.length, sha256 };
  }
  const text = encodeManifest(manifest);
  await bucket.put(MANIFEST, text, { customMetadata: { sha256: await sha256Hex(toBytes(text)) } });
  return manifest;
}

const stored = (bucket: MemoryBucket, path: string) => {
  const held = bucket.objects.get(path);
  return held ? toText(held.data) : undefined;
};

const manifestOf = (bucket: MemoryBucket) => JSON.parse(stored(bucket, MANIFEST)!) as Manifest;

/** Every object of a bucket, by its key, with its bytes: to compare what it holds before and after. */
const snapshot = (bucket: MemoryBucket) =>
  Object.fromEntries([...bucket.objects].map(([key, held]) => [key, held.data.join(',')]));

/** The bucket holds the library and nothing else: it is public. */
const onlyTheLibrary = (bucket: MemoryBucket) =>
  assert.deepEqual(
    [...bucket.objects.keys()].filter((key) => key !== MANIFEST && !manifestOf(bucket).files[key]),
    [],
  );

const ZONE = { MEDIA_ZONE_ID: 'zone-1', MEDIA_PURGE_TOKEN: 'purge-token' };
const PURGE = 'https://api.cloudflare.com/client/v4/zones/zone-1/purge_cache';

/** Cloudflare's purge, answering each call as `answer` says; and the calls it had. */
function cloudflare(answer: (call: number) => Response = () => Response.json({ success: true })) {
  const calls: { url: string; token: string | null; body: Record<string, string[]> }[] = [];
  mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    calls.push({
      url: request.url,
      token: request.headers.get('Authorization'),
      body: (await request.json()) as Record<string, string[]>,
    });
    return answer(calls.length);
  });
  return calls;
}

const HE_SAMPLE = [{ layout: 'l_harbour_hero', name: 'פתיחה', content: {} }];
const EN_SAMPLE = [{ layout: 'l_harbour_hero', name: 'Opening', content: {} }];

/** The files of the library the uploads below are checked against. */
const LIBRARY: Record<string, unknown> = {
  'fonts/catalog.json': FONTS,
  'templates/harbour/template.json': TEMPLATE,
  'templates/pictures.json': { harbourPier: PICTURE },
  'templates/catalog.json': {
    templates: [{ theme: { id: 'harbour' } }],
    samples: { harbour: { he: HE_SAMPLE, en: EN_SAMPLE } },
  },
  'tags/emoji.json': encodeTags({ version: 1, tags: { other: { he: ['אחר'], en: ['other'] } } }),
  ...CATALOGS,
};

const balloon = { he: ['בלון', 'יום הולדת', 'מסיבה'], en: ['balloon', 'birthday', 'party'] };

describe('what a publication writes', () => {
  test('tags: an item named takes the tags given, in every language, and the others keep theirs', () => {
    const merged = mergeTags(
      {
        version: 1,
        tags: { cake: { he: ['עוגה'], en: ['cake'] }, balloon: { he: ['בלון'], en: ['balloon'] } },
      },
      {
        fr: { tags: { balloon: ['ballon', 'fête'], gift: ['cadeau'] } },
        en: { tags: { balloon: ['balloon', 'party'], gift: ['gift'] } },
        he: { tags: { balloon: ['בלון', 'מסיבה'], gift: ['מתנה'] } },
      },
    );
    assert.deepEqual(merged.tags.cake, { he: ['עוגה'], en: ['cake'] });
    assert.deepEqual(Object.keys(merged.tags.balloon!), ['he', 'en', 'fr']);
    assert.deepEqual(merged.tags.gift, { he: ['מתנה'], en: ['gift'], fr: ['cadeau'] });
    assert.deepEqual(Object.keys(merged.tags), ['cake', 'balloon', 'gift']);
    assert.deepEqual(mergeTags(undefined, { he: { tags: { x: ['א'] } } }).tags, {
      x: { he: ['א'] },
    });
    const text = encodeTags(merged);
    assert.ok(
      text.startsWith(
        '{\n  "version": 1,\n  "tags": {\n    "cake": {"he":["עוגה"],"en":["cake"]},\n',
      ),
    );
    assert.deepEqual(JSON.parse(text), merged);
  });

  test('designs: one group each, a group keeps its first names, an empty group goes', () => {
    const design = (
      id: string,
      group: string,
      extra: Partial<DesignRecord> = {},
    ): DesignRecord => ({
      id,
      name: { he: id, en: id },
      group,
      slides: { he: {}, en: {} },
      subject: [1, 2],
      size: [3, 4],
      ...extra,
    });
    const catalog = emptyCatalog();
    mergeDesign(
      catalog,
      design('m-a', 'invites', { groupName: { he: 'הזמנות', en: 'Invitations' } }),
    );
    mergeDesign(catalog, design('m-b', 'invites', { groupName: { he: 'אחר', en: 'Other' } }));
    mergeDesign(catalog, design('m-c', 'sales', { tags: { he: ['מבצע'], en: ['sale'] } }));
    assert.deepEqual(catalog.groupIds, { invites: ['m-a', 'm-b'], sales: ['m-c'] });
    assert.deepEqual(catalog.groupNames.invites, { he: 'הזמנות', en: 'Invitations' });
    assert.deepEqual(catalog.groupNames.sales, { he: 'sales', en: 'sales' });
    assert.deepEqual(catalog.tags, { 'm-c': { he: ['מבצע'], en: ['sale'] } });
    mergeDesign(catalog, design('m-c', 'invites'));
    assert.deepEqual(catalog.groups, ['invites']);
    assert.deepEqual(catalog.groupIds, { invites: ['m-a', 'm-b', 'm-c'] });
    assert.equal(catalog.groupNames.sales, undefined);
    assert.deepEqual(catalog.tags, {});
    // A catalog published before there were tags takes them.
    const old: Record<string, unknown> = { ...emptyCatalog() };
    delete old.tags;
    assert.ok('tags' in mergeDesign(old as never, design('m-d', 'x')));
    assert.deepEqual(
      mergeTranslation(catalog, 'm-a', {
        ja: { slide: { id: 'ja' } },
        ar: { slide: { id: 'ar' } },
      }),
      ['ar', 'ja'],
    );
    assert.deepEqual(Object.keys(catalog.slides['m-a']!), ['he', 'en', 'ar', 'ja']);
    assert.throws(
      () => mergeTranslation(catalog, 'm-none', { ja: { slide: {} } }),
      /no design m-none/,
    );
  });

  test('samples: written into the catalog of templates, and nothing else of it changes', () => {
    const catalog = {
      templates: [{ theme: { id: 'harbour', name: 'נמל "Harbour"' } }],
      pictures: { a: 1 },
      samples: { harbour: { en: [2], he: [1] }, other: { he: [9] } },
    };
    const text = JSON.stringify(catalog);
    const out = toText(spliceSample(toBytes(text), 'harbour', 'fr', [{ x: 'é' }]));
    const back = JSON.parse(out) as {
      samples: { harbour: Record<string, unknown>; other?: unknown };
    };
    assert.deepEqual(Object.keys(back.samples.harbour), ['he', 'en', 'fr']);
    assert.deepEqual(back.samples.harbour.fr, [{ x: 'é' }]);
    assert.deepEqual(back.samples.other, { he: [9] });
    // Everything before the template's samples, and after them, is as it was.
    const at = text.indexOf('"harbour":{"en"');
    assert.equal(out.slice(0, at), text.slice(0, at));
    assert.ok(out.endsWith(',"other":{"he":[9]}}}'));
    // Again in a language it has: in its place.
    const again = JSON.parse(
      toText(spliceSample(toBytes(out), 'harbour', 'fr', [3])),
    ) as typeof back;
    assert.deepEqual(again.samples.harbour.fr, [3]);
    // A template without samples, and a catalog without any, take them.
    const none = JSON.parse(
      toText(spliceSample(toBytes('{"templates":[]}'), 'harbour', 'de', [1])),
    ) as typeof back;
    assert.deepEqual(none.samples, { harbour: { de: [1] } });
    const fresh = JSON.parse(
      toText(spliceSample(toBytes('{"samples":{}}'), 'harbour', 'de', [1])),
    ) as typeof back;
    assert.deepEqual(fresh.samples, { harbour: { de: [1] } });
    assert.throws(() => spliceSample(toBytes('{"samples":'), 'harbour', 'de', [1]));
  });
});

describe('the library in its bucket', () => {
  test('is served at /media/, as the site served it', async () => {
    const { env, call } = await caller({ nobody: true });
    const media = new MemoryBucket();
    Object.assign(env, { MEDIA: media });
    await liveLibrary(media, {
      'tags/emoji.json': '{"version":1,"tags":{}}\n',
      'images/a b.webp': webp(2, 2),
    });
    const manifest = await call('/media/manifest.json');
    assert.equal(manifest.status, 200);
    assert.equal(manifest.headers.get('Cache-Control'), 'no-cache');
    assert.equal(manifest.headers.get('Access-Control-Allow-Origin'), '*');
    assert.equal(manifest.headers.get('X-Slidr-Library'), 'live');
    assert.equal((await read<Manifest>(manifest)).files['tags/emoji.json']!.size, 24);
    const file = await call('/media/tags/emoji.json');
    assert.equal(file.headers.get('Content-Type'), 'application/json');
    const etag = file.headers.get('ETag')!;
    assert.equal(etag, `"${await sha256Hex(toBytes('{"version":1,"tags":{}}\n'))}"`);
    assert.equal(await file.text(), '{"version":1,"tags":{}}\n');
    const again = await call('/media/tags/emoji.json', { headers: { 'If-None-Match': etag } });
    assert.equal(again.status, 304);
    assert.equal((await call('/media/images/a%20b.webp')).status, 200);
    assert.equal(
      (await call('/media/images/a%20b.webp', { method: 'HEAD' })).headers.get('Content-Length'),
      '30',
    );
    // A path of the Worker's records before, a path out of the library, and a file it does not
    // have, are not found.
    await media.put('_history/x/manifest.json', '{}');
    assert.equal((await call('/media/_history/x/manifest.json')).status, 404);
    assert.equal((await call('/media/tags%2F..%2Fmanifest.json')).status, 404);
    assert.equal((await call('/media/tags/none.json')).status, 404);
    assert.equal((await call('/media/manifest.json', { method: 'POST' })).status, 405);
    // No bucket: the server says so.
    Object.assign(env, { MEDIA: undefined });
    assert.equal((await call('/media/manifest.json')).status, 503);
  });

  test('is brought in from the site once, a batch at a time, and checked file by file', async () => {
    const { env, send, call } = await caller();
    const media = new MemoryBucket();
    Object.assign(env, { MEDIA: media });
    const files: Record<string, Uint8Array> = {
      'a.json': toBytes('{"a":1}'),
      'b/c.json': toBytes('{"c":2}'),
      'd.webp': webp(4, 4),
    };
    const manifest: Manifest = { version: 1, published: '2026-10-19T22:14:16.216Z', files: {} };
    for (const [path, bytes] of Object.entries(files)) {
      manifest.files[path] = { size: bytes.length, sha256: await sha256Hex(bytes) };
    }
    // A file brought in before without the caching it is served with is brought in again.
    await media.put('a.json', files['a.json']!, {
      customMetadata: { sha256: manifest.files['a.json']!.sha256 },
    });
    let damaged = true;
    mock.method(globalThis, 'fetch', (input: string | URL | Request) => {
      const url = String(input instanceof Request ? input.url : input);
      const path = decodeURI(url.slice(MEDIA.length));
      if (path === MANIFEST) return Promise.resolve(Response.json(manifest));
      if (path === 'd.webp' && damaged) return Promise.resolve(new Response(new Uint8Array(30)));
      const bytes = files[path];
      return Promise.resolve(
        bytes ? new Response(bytes as Uint8Array<ArrayBuffer>) : new Response('', { status: 404 }),
      );
    });
    const first = await read<{
      copied: number;
      remaining: number;
      done: boolean;
      failed: { path: string }[];
    }>(await send('/api/library/import', 'POST', { limit: 2 }));
    assert.deepEqual([first.copied, first.remaining, first.done], [2, 1, false]);
    assert.equal(media.objects.has(MANIFEST), false);
    // A file whose bytes are not the manifest's is not taken.
    const second = await read<typeof first>(await send('/api/library/import', 'POST', {}));
    assert.deepEqual([second.copied, second.remaining, second.done], [0, 1, false]);
    assert.equal(second.failed[0]!.path, 'd.webp');
    damaged = false;
    const third = await read<typeof first>(await send('/api/library/import', 'POST', {}));
    assert.deepEqual([third.copied, third.remaining, third.done], [1, 0, true]);
    assert.deepEqual(manifestOf(media), manifest);
    assert.equal(media.objects.get('b/c.json')!.meta!.sha256, manifest.files['b/c.json']!.sha256);
    // Each file is written with what the bucket answers it with: media.slidr.studio is the bucket.
    assert.deepEqual(media.objects.get('a.json')!.http, {
      contentType: 'application/json',
      cacheControl: 'public, max-age=0, must-revalidate',
    });
    assert.equal(media.objects.get('d.webp')!.http.contentType, 'image/webp');
    assert.equal(media.objects.get(MANIFEST)!.http.cacheControl, 'no-cache');
    // From then on the library is the bucket's: it is not brought in again, and says so.
    const again = await send('/api/library/import', 'POST', {});
    assert.equal(again.status, 409);
    const status = await read<{ live: boolean; files: number; published: string }>(
      await call('/api/library'),
    );
    assert.deepEqual([status.live, status.files, status.published], [true, 3, manifest.published]);
  });

  test('is brought in only by whoever may publish', async () => {
    const { env, send } = await caller({ nobody: true });
    Object.assign(env, { MEDIA: new MemoryBucket() });
    assert.ok([401, 403].includes((await send('/api/library/import', 'POST', {})).status));
  });
});

describe('a publication', () => {
  /** An editor, with the library live in its bucket, which goes away when `control.fails` says. */
  async function live() {
    const session = await caller();
    const media = new MemoryBucket();
    const { store, control } = failing(media);
    Object.assign(session.env, { MEDIA: store });
    const before = await liveLibrary(media, LIBRARY);
    /** Uploads it, and approves it: what the approval answered. */
    const approve = async (body: unknown, files?: Record<string, Uint8Array<ArrayBuffer>>) => {
      const made = await read<{ id: string }>(
        files
          ? await session.upload(body, files)
          : await session.send('/api/uploads', 'POST', body),
      );
      assert.ok(made.id, JSON.stringify(made));
      const answer = await session.send(`/api/uploads/${made.id}/status`, 'POST', {
        status: 'accepted',
      });
      assert.equal(answer.status, 200, await answer.clone().text());
      return read<Approved>(answer);
    };
    /** Approved while another publication holds the library: it waits, accepted. */
    const waiting = async (body: unknown, files?: Record<string, Uint8Array<ArrayBuffer>>) => {
      await session.bucket.put(
        LOCK,
        JSON.stringify({ by: 'someone', at: new Date().toISOString() }),
      );
      const approved = await approve(body, files);
      assert.equal(approved.status, 'accepted');
      await session.bucket.put(LOCK, JSON.stringify({ free: true }));
      return approved.id;
    };
    return { ...session, media, control, before, approve, waiting };
  }

  interface Published {
    published?: string;
    uploads: { id: string; paths: string[] }[];
    skipped: { id: string; reason: string; message: string }[];
    added: string[];
    changed: string[];
    cache?: { emptied: string; files?: number; host?: string; message?: string };
  }

  interface Approved {
    id: string;
    status: string;
    note?: string;
    history: { status: string; by: { id: string }; note?: string }[];
    publication?: { message: string; attempts: number; next?: string };
    publishing?: { publication?: Published; failed?: { code: string; message: string } };
  }

  const cake = {
    type: 'emoji',
    action: 'tag',
    id: 'emoji',
    languages: {
      he: { tags: { 'birthday-cake': balloon.he } },
      en: { tags: { 'birthday-cake': balloon.en } },
    },
  };

  const balloons = {
    type: 'graphics',
    action: 'tag',
    id: 'graphics',
    languages: {
      he: { tags: { 'fluent-emoji:balloon': balloon.he } },
      en: { tags: { 'fluent-emoji:balloon': balloon.en } },
    },
  };

  const design = {
    type: 'designs',
    action: 'add',
    id: 'm-harbour-launch',
    group: 'events',
    subject: [1500, 540],
    languages: designLanguages(ALL_LANGUAGES),
  };

  test('writes an approved upload at once, and the upload is published', async () => {
    const { send, call, bucket, media, before, approve } = await live();
    const approved = await approve({
      ...cake,
      languages: {
        ...cake.languages,
        fr: { tags: { 'birthday-cake': ['anniversaire', 'gâteau', 'fête'] } },
      },
    });
    const { id } = approved;
    assert.equal(approved.status, 'published');
    assert.equal(approved.publication, undefined);
    const done = approved.publishing!.publication!;
    assert.deepEqual(
      done.uploads.map((one) => [one.id, one.paths]),
      [[id, ['tags/emoji.json']]],
    );
    assert.deepEqual([done.added, done.changed], [[], ['tags/emoji.json']]);
    const tags = JSON.parse(stored(media, 'tags/emoji.json')!) as { tags: Record<string, unknown> };
    assert.deepEqual(tags.tags, {
      other: { he: ['אחר'], en: ['other'] },
      'birthday-cake': { he: balloon.he, en: balloon.en, fr: ['anniversaire', 'gâteau', 'fête'] },
    });
    // The manifest names the new bytes, and is newer; what it replaced is kept, beside the uploads.
    const manifest = manifestOf(media);
    assert.equal(manifest.published, done.published);
    assert.equal(
      manifest.files['tags/emoji.json']!.sha256,
      await sha256Hex(media.objects.get('tags/emoji.json')!.data),
    );
    assert.deepEqual(media.objects.get('tags/emoji.json')!.http, {
      contentType: 'application/json',
      cacheControl: 'public, max-age=0, must-revalidate',
    });
    assert.equal(media.objects.get(MANIFEST)!.http.cacheControl, 'no-cache');
    assert.deepEqual(
      JSON.parse(stored(bucket, `media/history/${done.published}/manifest.json`)!),
      before,
    );
    assert.ok(
      stored(bucket, `media/history/${done.published}/tags/emoji.json`)!.includes('"other"'),
    );
    // The lease is let go, and stays, free.
    assert.deepEqual(JSON.parse(stored(bucket, LOCK)!), { free: true });
    onlyTheLibrary(media);
    // A Worker not set up to empty the cache says so.
    assert.equal(done.cache?.emptied, 'none');
    assert.match(done.cache.message!, /MEDIA_ZONE_ID/);
    assert.deepEqual(
      approved.history.map((one) => one.status),
      ['pending', 'accepted', 'published'],
    );
    // What it did is kept, for the reviewers.
    const kept = await read<{ publications: (Published & { kind: string; by: { id: string } })[] }>(
      await call('/api/publications'),
    );
    assert.deepEqual(
      kept.publications.map((one) => [one.published, one.kind, one.by.id, one.uploads[0]!.id]),
      [[done.published, 'uploads', EDITOR, id]],
    );
    const one = await call(`/api/publications/${done.published}`);
    assert.equal(one.status, 200);
    assert.deepEqual((await read<Published>(one)).changed, ['tags/emoji.json']);
    assert.equal((await call('/api/publications/2020-01-01T00:00:00.000Z')).status, 404);
    // The library serves it, and nothing waits any more.
    assert.ok((await (await call('/media/tags/emoji.json')).text()).includes('birthday-cake'));
    const status = await read<{ accepted: number; published: string }>(await call('/api/library'));
    assert.deepEqual([status.accepted, status.published], [0, done.published]);
    const nothing = await read<Published>(await send('/api/publish', 'POST', {}));
    assert.deepEqual([nothing.uploads, nothing.published], [[], undefined]);
  });

  test('puts a new design into the studio’s catalog, with its picture, and a sample into its template', async () => {
    const { send, call, media, approve } = await live();
    const added = await approve(design, { picture: webp(1008, 1496) });
    assert.deepEqual(added.publishing?.publication?.added, [
      'elements/designs/managed.json',
      'images/designs/m-harbour-launch.webp',
    ]);
    const sample = await approve({
      type: 'templates',
      action: 'translate',
      id: 'harbour',
      languages: { fr: { sample: frenchSample() } },
    });
    assert.deepEqual(sample.publishing?.publication?.changed, ['templates/catalog.json']);
    const managed = JSON.parse(stored(media, 'elements/designs/managed.json')!) as ReturnType<
      typeof emptyCatalog
    >;
    assert.deepEqual(managed.groups, ['events']);
    assert.deepEqual(managed.groupNames.events, { he: 'אירועים', en: 'Events' });
    assert.deepEqual(managed.names['m-harbour-launch'], { he: 'ערב השקה', en: 'Launch night' });
    assert.deepEqual(managed.sizes['m-harbour-launch'], [1008, 1496]);
    assert.deepEqual(managed.subjects['m-harbour-launch'], [1500, 540]);
    assert.deepEqual(Object.keys(managed.slides['m-harbour-launch']!), [...ALL_LANGUAGES]);
    assert.equal(managed.tags['m-harbour-launch']!.en![0], 'launch night');
    assert.deepEqual(
      media.objects.get('images/designs/m-harbour-launch.webp')!.data,
      webp(1008, 1496),
    );
    const catalog = JSON.parse(stored(media, 'templates/catalog.json')!) as {
      samples: { harbour: Record<string, unknown> };
    };
    assert.deepEqual(Object.keys(catalog.samples.harbour), ['he', 'en', 'fr']);
    assert.deepEqual(catalog.samples.harbour.he, HE_SAMPLE);
    // Published, the design is the library's: a translation of it is checked against it.
    const picture = await call('/media/images/designs/m-harbour-launch.webp');
    assert.equal(picture.headers.get('Content-Type'), 'image/webp');
    const again = await send('/api/uploads', 'POST', {
      ...design,
      subject: [1, 1],
      languages: designLanguages(),
    });
    assert.equal(again.status, 422);
  });

  test('sends back to pending what no longer holds, saying why, and writes the rest', async () => {
    const { send, call, media, waiting } = await live();
    const gone = await waiting(cake);
    const kept = await waiting(balloons);
    // The item is gone from the library since the upload was approved.
    const catalog = 'elements/catalogs/emoji-catalog.json';
    const empty = toBytes('[]');
    await media.put(catalog, empty, { customMetadata: { sha256: await sha256Hex(empty) } });
    forgetLibrary();
    const done = await read<Published>(await send('/api/publish', 'POST', {}));
    assert.deepEqual(
      done.uploads.map((one) => one.id),
      [kept],
    );
    assert.deepEqual(
      done.skipped.map((one) => [one.id, one.reason]),
      [[gone, 'invalid']],
    );
    const back = await read<Approved>(await call(`/api/uploads/${gone}`));
    assert.equal(back.status, 'pending');
    assert.match(back.note!, /no longer holds/);
    assert.deepEqual(
      back.history.map((one) => [one.status, one.by.id]),
      [
        ['pending', EDITOR],
        ['accepted', EDITOR],
        ['pending', EDITOR],
      ],
    );
    // An upload that is not accepted is not published.
    const named = await read<Published>(await send('/api/publish', 'POST', { uploads: [gone] }));
    assert.deepEqual(
      named.skipped.map((one) => one.reason),
      ['status'],
    );
    assert.equal((await send('/api/publish', 'POST', { uploads: ['nothing'] })).status, 400);
  });

  test('is one at a time: approved while another publishes, an upload waits, and says why', async () => {
    const { send, bucket, approve } = await live();
    await bucket.put(LOCK, JSON.stringify({ by: 'someone', at: new Date().toISOString() }));
    const held = await approve(cake);
    assert.equal(held.status, 'accepted');
    assert.equal(held.publishing?.failed?.code, 'publishing');
    assert.match(held.publication!.message, /someone/);
    // Waiting on another publication is no failed try: it is tried at the next round.
    assert.equal(held.publication!.attempts, 0);
    const marked = await send(`/api/uploads/${held.id}/status`, 'POST', { status: 'published' });
    assert.equal(marked.status, 409);
    assert.equal((await read<{ error: string }>(marked)).error, 'publish-instead');
    const busy = await send('/api/publish', 'POST', {});
    assert.equal(busy.status, 409);
    assert.equal((await read<{ error: string }>(busy)).error, 'publishing');
    // A publication left behind long ago does not hold the library.
    await bucket.put(LOCK, JSON.stringify({ by: 'someone', at: '2026-01-01T00:00:00.000Z' }));
    assert.equal((await read<Published>(await send('/api/publish', 'POST', {}))).uploads.length, 1);
  });

  test('two approved at the same moment are never written together', async () => {
    const { media, approve, env } = await live();
    const both = await Promise.all([approve(cake), approve(balloons)]);
    // One publication ran; the other upload waits for the next round, which writes it.
    await sweep(await contextOf(env));
    const manifest = manifestOf(media);
    for (const path of ['tags/emoji.json', 'tags/graphics.json']) {
      assert.equal(
        manifest.files[path]?.sha256,
        await sha256Hex(media.objects.get(path)!.data),
        path,
      );
    }
    assert.ok(stored(media, 'tags/emoji.json')!.includes('birthday-cake'));
    assert.ok(stored(media, 'tags/graphics.json')!.includes('fluent-emoji:balloon'));
    assert.ok(both.some((one) => one.status === 'published'));
  });

  test('puts the media back as it was when it fails part-way, at whichever write', async () => {
    mock.method(console, 'error', () => {});
    // How many writes a publication of a design and a tag makes into the media.
    const whole = await live();
    await whole.waiting(cake);
    await whole.waiting(design, { picture: webp(1008, 1496) });
    whole.control.writes = 0;
    await whole.send('/api/publish', 'POST', {});
    const writes = whole.control.writes;
    assert.equal(writes, 4);
    for (let at = 1; at <= writes; at += 1) {
      const { send, call, bucket, media, control, waiting } = await live();
      const first = await waiting(cake);
      await waiting(design, { picture: webp(1008, 1496) });
      const before = snapshot(media);
      control.writes = 0;
      control.fails = (write) => write === at;
      const failed = await send('/api/publish', 'POST', {});
      assert.equal(failed.status, 502, `at write ${at}`);
      assert.deepEqual(snapshot(media), before, `at write ${at}`);
      // The history of a publication that did not happen is not kept.
      assert.deepEqual(
        [...bucket.objects.keys()].filter((key) => key.startsWith('media/history/')),
        [],
      );
      assert.deepEqual(JSON.parse(stored(bucket, LOCK)!), { free: true });
      const waits = await read<Approved>(await call(`/api/uploads/${first}`));
      assert.equal(waits.status, 'accepted');
      assert.equal(waits.publication?.attempts, 1);
      // Why, without the store's own words, which may name the server's folders.
      assert.equal(waits.publication.message, 'The media could not be written.');
    }
  });

  test('empties the cache of the files it wrote, and of the manifest', async () => {
    const { env, approve } = await live();
    Object.assign(env, ZONE);
    const calls = cloudflare();
    const approved = await approve(cake);
    const done = approved.publishing!.publication!;
    assert.deepEqual(done.cache, { emptied: 'files', files: 2 });
    assert.deepEqual(calls, [
      {
        url: PURGE,
        token: 'Bearer purge-token',
        body: { files: [`${MEDIA}tags/emoji.json`, `${MEDIA}manifest.json`] },
      },
    ]);
    assert.deepEqual(
      done.uploads.map((one) => one.id),
      [approved.id],
    );
  });

  test('is published all the same when Cloudflare refuses to empty the cache, and says so', async () => {
    const { env, approve } = await live();
    Object.assign(env, ZONE);
    const calls = cloudflare(() =>
      Response.json(
        { success: false, errors: [{ code: 10000, message: 'Authentication error' }] },
        { status: 403 },
      ),
    );
    mock.method(console, 'error', () => {});
    const approved = await approve(cake);
    const done = approved.publishing!.publication!;
    assert.equal(done.cache?.emptied, 'none');
    assert.match(done.cache.message!, /Authentication error/);
    // A token Cloudflare refuses is not tried again.
    assert.equal(calls.length, 1);
    assert.equal(approved.status, 'published');
  });

  test('waits for the library to be brought in, and is only by whoever may publish', async () => {
    const { env, send } = await caller();
    Object.assign(env, { MEDIA: new MemoryBucket() });
    const early = await send('/api/publish', 'POST', {});
    assert.equal(early.status, 409);
    assert.equal((await read<{ error: string }>(early)).error, 'not-live');
    const nobody = await caller({ nobody: true });
    Object.assign(nobody.env, { MEDIA: new MemoryBucket() });
    assert.ok([401, 403].includes((await nobody.send('/api/publish', 'POST', {})).status));
  });

  test('the sweep tries what waits again after 1, 5 and 30 minutes, then it waits for Try again', async () => {
    mock.method(console, 'error', () => {});
    const { send, call, env, control, waiting } = await live();
    const id = await waiting(cake);
    const ctx = await contextOf(env);
    control.fails = () => true;
    const waits = async () => (await read<Approved>(await call(`/api/uploads/${id}`))).publication;
    const minute = 60_000;
    let at = Date.now();
    const tries: (number | undefined)[] = [];
    for (const wait of [1, 5, 30]) {
      const swept = await sweep(ctx, at);
      assert.equal(swept.outcome?.failed?.code, 'not-written');
      const waiting = await waits();
      tries.push(waiting?.attempts);
      assert.equal(Date.parse(waiting!.next!) - at, wait * minute);
      // Not due before then.
      assert.equal((await sweep(ctx, at + wait * minute - 1000)).outcome, undefined);
      at += wait * minute;
    }
    await sweep(ctx, at);
    const last = await waits();
    assert.deepEqual([...tries, last?.attempts, last?.next], [1, 2, 3, 4, undefined]);
    assert.equal((await sweep(ctx, at + 24 * 60 * minute)).outcome, undefined);
    // Try again, by hand, once the store is back.
    control.fails = () => false;
    const again = await read<Published>(await send('/api/publish', 'POST', { uploads: [id] }));
    assert.deepEqual(
      again.uploads.map((one) => one.id),
      [id],
    );
    const published = await read<Approved>(await call(`/api/uploads/${id}`));
    assert.deepEqual([published.status, published.publication], ['published', undefined]);
    assert.equal(published.history.at(-1)!.by.id, EDITOR);
  });

  test('the sweep runs on Cloudflare once a minute, as the library', async () => {
    const { call, env, waiting } = await live();
    const id = await waiting(cake);
    await worker.scheduled({}, env);
    const published = await read<Approved>(await call(`/api/uploads/${id}`));
    assert.equal(published.status, 'published');
    assert.equal(published.history.at(-1)!.by.id, 'library');
  });
});

describe('clearing', () => {
  test('takes away rejected uploads after 30 days, and keeps the last 100 publications', async () => {
    const bucket = new MemoryBucket();
    /** An upload rejected `days` ago. */
    const rejectedAt = async (days: number) => {
      const at = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
      const id = newUploadId();
      const upload = {
        id,
        type: 'emoji',
        action: 'tag',
        target: 'emoji',
        languages: {},
        files: {},
        status: 'rejected',
        created: at,
        updated: at,
        by: { id: EDITOR },
        history: [],
      } as unknown as Upload;
      await createUpload(bucket, upload, new Map());
      return id;
    };
    const old = await rejectedAt(31);
    const recent = await rejectedAt(29);
    for (let second = 0; second < 102; second += 1) {
      const moment = new Date(Date.UTC(2026, 9, 1, 0, 0, second)).toISOString();
      await bucket.put(`media/publications/${moment}.json`, '{}');
      await bucket.put(`media/history/${moment}/manifest.json`, '{}');
    }
    const cleared = await clear(bucket);
    assert.deepEqual(cleared, { rejected: 1, publications: 2 });
    assert.equal(await readUpload(bucket, old), undefined);
    assert.ok(await readUpload(bucket, recent));
    const moments = [...bucket.objects.keys()].filter((key) =>
      key.startsWith('media/publications/'),
    );
    assert.equal(moments.length, 100);
    assert.equal(moments.sort()[0], 'media/publications/2026-10-01T00:00:02.000Z.json');
    assert.equal(bucket.objects.has('media/history/2026-10-01T00:00:01.000Z/manifest.json'), false);
    // Once a day.
    assert.equal(await clear(bucket), undefined);
  });
});

describe('an author’s publication of files', () => {
  const put = (
    send: (path: string, init?: RequestInit) => Promise<Response>,
    bytes: Uint8Array,
    sha: string,
  ) =>
    send(`/api/library/staged/${sha}`, { method: 'PUT', body: bytes as Uint8Array<ArrayBuffer> });

  async function author() {
    const session = await caller();
    const media = new MemoryBucket();
    Object.assign(session.env, { MEDIA: media });
    const before = await liveLibrary(media, {
      'icons/lucide/tags.json': '{"cake":["birthday"]}',
      'tags/emoji.json': '{"version":1,"tags":{}}\n',
      'fonts/old.woff2': new Uint8Array([1, 2, 3]),
    });
    return { ...session, media, before };
  }

  test('writes the files the author changed, takes away those removed, and keeps the rest', async () => {
    const { env, call, send, bucket, media, before } = await author();
    Object.assign(env, ZONE);
    const icons = toBytes('{"cake":["birthday","party"]}');
    const font = new Uint8Array([4, 5, 6, 7]);
    const [iconsSha, fontSha] = [await sha256Hex(icons), await sha256Hex(font)];
    assert.equal((await put(call, icons, iconsSha)).status, 200);
    const staged = await read<{ already: boolean }>(await put(call, font, fontSha));
    assert.equal(staged.already, false);
    assert.equal((await read<{ already: boolean }>(await put(call, font, fontSha))).already, true);
    // Staged beside the uploads, not in the library's bucket, which is public.
    assert.ok(bucket.objects.has(`media/staged/${fontSha}`));
    onlyTheLibrary(media);
    const calls = cloudflare();
    const response = await send('/api/library/files', 'POST', {
      files: {
        'icons/lucide/tags.json': {
          from: before.files['icons/lucide/tags.json']!.sha256,
          to: { size: icons.length, sha256: iconsSha },
        },
        'fonts/new.woff2': { from: null, to: { size: font.length, sha256: fontSha } },
        'fonts/old.woff2': { from: before.files['fonts/old.woff2']!.sha256, to: null },
        'tags/emoji.json': {
          from: before.files['tags/emoji.json']!.sha256,
          to: before.files['tags/emoji.json'],
        },
      },
    });
    assert.equal(response.status, 200, await response.clone().text());
    const done = await read<{
      published: string;
      added: string[];
      changed: string[];
      removed: string[];
      same: string[];
    }>(response);
    assert.deepEqual(
      [done.added, done.changed, done.removed, done.same],
      [['fonts/new.woff2'], ['icons/lucide/tags.json'], ['fonts/old.woff2'], ['tags/emoji.json']],
    );
    const manifest = manifestOf(media);
    assert.equal(manifest.published, done.published);
    assert.deepEqual(Object.keys(manifest.files).sort(), [
      'fonts/new.woff2',
      'icons/lucide/tags.json',
      'tags/emoji.json',
    ]);
    assert.equal(
      await (await call('/media/icons/lucide/tags.json')).text(),
      '{"cake":["birthday","party"]}',
    );
    assert.equal((await call('/media/fonts/old.woff2')).status, 404);
    assert.equal((await call('/media/fonts/new.woff2')).headers.get('Content-Type'), 'font/woff2');
    assert.equal(
      media.objects.get('fonts/new.woff2')!.http.cacheControl,
      'public, max-age=0, must-revalidate',
    );
    // What it replaced is kept beside the uploads; the staged files are gone.
    assert.deepEqual(
      JSON.parse(stored(bucket, `media/history/${done.published}/manifest.json`)!),
      before,
    );
    assert.equal(
      stored(bucket, `media/history/${done.published}/icons/lucide/tags.json`),
      '{"cake":["birthday"]}',
    );
    assert.equal(
      [...bucket.objects.keys()].some((key) => key.startsWith('media/staged/')),
      false,
    );
    onlyTheLibrary(media);
    // The cache is emptied of every file written or taken away, and of the manifest.
    assert.deepEqual(
      calls.map((one) => one.body),
      [
        {
          files: [
            `${MEDIA}fonts/new.woff2`,
            `${MEDIA}icons/lucide/tags.json`,
            `${MEDIA}fonts/old.woff2`,
            `${MEDIA}manifest.json`,
          ],
        },
      ],
    );
  });

  test('changes nothing where the library changed a file since the copy was pulled', async () => {
    const { call, send, bucket, media, before } = await author();
    // A publication of uploads wrote the tags after the author pulled.
    const published = toBytes('{"version":1,"tags":{"cake":{"he":["עוגה"],"en":["cake"]}}}\n');
    const live = manifestOf(media);
    live.files['tags/emoji.json'] = { size: published.length, sha256: await sha256Hex(published) };
    await media.put('tags/emoji.json', published, {
      customMetadata: { sha256: live.files['tags/emoji.json'].sha256 },
    });
    await media.put(MANIFEST, encodeManifest(live));
    const stale = toBytes('{"version":1,"tags":{}}\n\n');
    const staleSha = await sha256Hex(stale);
    await put(call, stale, staleSha);
    const icons = toBytes('{}');
    await put(call, icons, await sha256Hex(icons));
    const response = await send('/api/library/files', 'POST', {
      files: {
        'tags/emoji.json': {
          from: before.files['tags/emoji.json']!.sha256,
          to: { size: stale.length, sha256: staleSha },
        },
        'icons/lucide/tags.json': {
          from: before.files['icons/lucide/tags.json']!.sha256,
          to: { size: 2, sha256: await sha256Hex(icons) },
        },
      },
    });
    assert.equal(response.status, 409);
    const problem = await read<{ error: string; issues: { path: string }[] }>(response);
    assert.equal(problem.error, 'conflict');
    assert.deepEqual(
      problem.issues.map((one) => one.path),
      ['tags/emoji.json'],
    );
    // All or none: the icons are not written either.
    assert.deepEqual(manifestOf(media), live);
    assert.equal(stored(media, 'icons/lucide/tags.json'), '{"cake":["birthday"]}');
    assert.deepEqual(JSON.parse(stored(bucket, LOCK)!), { free: true });
  });

  test('takes only files sent first, under their own hash, by whoever may publish', async () => {
    const { call, send, before } = await author();
    const bytes = toBytes('{"x":1}');
    const sha = await sha256Hex(bytes);
    const missing = await send('/api/library/files', 'POST', {
      files: {
        'icons/lucide/tags.json': {
          from: before.files['icons/lucide/tags.json']!.sha256,
          to: { size: bytes.length, sha256: sha },
        },
      },
    });
    assert.equal(missing.status, 422);
    assert.equal((await read<{ error: string }>(missing)).error, 'not-staged');
    assert.equal((await put(call, toBytes('{"y":2}'), sha)).status, 400);
    assert.equal(
      (await call(`/api/library/staged/${'0'.repeat(63)}`, { method: 'PUT', body: 'x' })).status,
      404,
    );
    const wrong = await send('/api/library/files', 'POST', {
      files: { '_history/x': { from: null, to: null }, 'manifest.json': { from: null, to: null } },
    });
    assert.equal(wrong.status, 400);
    const nobody = await caller({ nobody: true });
    Object.assign(nobody.env, { MEDIA: new MemoryBucket() });
    assert.ok(
      [401, 403].includes(
        (
          await nobody.call(`/api/library/staged/${sha}`, {
            method: 'PUT',
            body: bytes,
          })
        ).status,
      ),
    );
  });
});

describe('the cache before the library', () => {
  const paths = (count: number) => Array.from({ length: count }, (_, at) => `icons/${at}.svg`);

  test('is emptied a hundred addresses a call, and of a whole host when they are many', async () => {
    const calls = cloudflare();
    const purge = purgerFor({ ...ZONE, MEDIA_LIBRARY_URL: 'https://media.example' });
    assert.deepEqual(await purge(paths(150)), { emptied: 'files', files: 151 });
    assert.deepEqual(
      calls.map((one) => one.body.files!.length),
      [100, 51],
    );
    assert.equal(calls[1]!.body.files!.at(-1), 'https://media.example/manifest.json');
    calls.length = 0;
    assert.deepEqual(await purge(paths(400)), { emptied: 'host', host: 'media.example' });
    assert.deepEqual(
      calls.map((one) => one.body),
      [{ hosts: ['media.example'] }],
    );
  });

  test('is tried again when a call fails, and says why when it never went through', async () => {
    mock.method(console, 'error', () => {});
    const once = cloudflare((call) =>
      call === 1 ? new Response('', { status: 500 }) : Response.json({ success: true }),
    );
    const purge = purgerFor(ZONE);
    assert.deepEqual(await purge(['tags/emoji.json']), { emptied: 'files', files: 2 });
    assert.equal(once.length, 2);
    mock.restoreAll();
    mock.method(console, 'error', () => {});
    const never = cloudflare(() => new Response('', { status: 503 }));
    const failed = await purge(['tags/emoji.json']);
    assert.equal(failed.emptied, 'none');
    assert.match((failed as { message: string }).message, /503/);
    assert.equal(never.length, 3);
    // The published library, unless the Worker names another.
    assert.equal(once[0]!.body.files![0], 'https://media.slidr.studio/tags/emoji.json');
  });
});
