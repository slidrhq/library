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
  MemoryBucket,
  caller,
  designLanguages,
  frenchSample,
  webp,
} from '../uploads/testing.ts';
import { MANIFEST, encodeManifest, sha256Hex, toBytes, toText, type Manifest } from './live.ts';
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
    // The Worker's own files, a path out of the library, and a file it does not have, are not found.
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
  /** An editor, with the library live in its bucket. */
  async function live() {
    const session = await caller();
    const media = new MemoryBucket();
    Object.assign(session.env, { MEDIA: media });
    const before = await liveLibrary(media, LIBRARY);
    const accept = async (body: unknown, files?: Record<string, Uint8Array<ArrayBuffer>>) => {
      const made = await read<{ id: string }>(
        files
          ? await session.upload(body, files)
          : await session.send('/api/uploads', 'POST', body),
      );
      assert.ok(made.id, JSON.stringify(made));
      const accepted = await session.send(`/api/uploads/${made.id}/status`, 'POST', {
        status: 'accepted',
      });
      assert.equal(accepted.status, 200, await accepted.clone().text());
      return made.id;
    };
    return { ...session, media, before, accept };
  }

  interface Published {
    published?: string;
    uploads: { id: string; paths: string[] }[];
    skipped: { id: string; message: string }[];
    added: string[];
    changed: string[];
  }

  test('writes the accepted tags into the part’s file, and marks the upload published', async () => {
    const { send, call, media, before, accept } = await live();
    const id = await accept({
      type: 'emoji',
      action: 'tag',
      id: 'emoji',
      languages: {
        he: { tags: { 'birthday-cake': balloon.he } },
        en: { tags: { 'birthday-cake': balloon.en } },
        fr: { tags: { 'birthday-cake': ['anniversaire', 'gâteau', 'fête'] } },
      },
    });
    const response = await send('/api/publish', 'POST', {});
    assert.equal(response.status, 200, await response.clone().text());
    const done = await read<Published>(response);
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
    // The manifest names the new bytes, and is newer; what it replaced is kept.
    const manifest = manifestOf(media);
    assert.equal(manifest.published, done.published);
    assert.equal(
      manifest.files['tags/emoji.json']!.sha256,
      await sha256Hex(media.objects.get('tags/emoji.json')!.data),
    );
    assert.deepEqual(
      JSON.parse(stored(media, `_history/${done.published}/manifest.json`)!),
      before,
    );
    assert.ok(stored(media, `_history/${done.published}/tags/emoji.json`)!.includes('"other"'));
    assert.equal(media.objects.has('_publishing.json'), false);
    const upload = await read<{ status: string; history: { status: string }[] }>(
      await call(`/api/uploads/${id}`),
    );
    assert.equal(upload.status, 'published');
    assert.deepEqual(
      upload.history.map((one) => one.status),
      ['pending', 'accepted', 'published'],
    );
    // The library serves it, and nothing waits any more.
    assert.ok((await (await call('/media/tags/emoji.json')).text()).includes('birthday-cake'));
    const status = await read<{ accepted: number; published: string }>(await call('/api/library'));
    assert.deepEqual([status.accepted, status.published], [0, done.published]);
    const nothing = await read<Published>(await send('/api/publish', 'POST', {}));
    assert.deepEqual([nothing.uploads, nothing.published], [[], undefined]);
  });

  test('puts a new design into the studio’s catalog, with its picture, and a sample into its template', async () => {
    const { send, call, media, accept } = await live();
    const design = await accept(
      {
        type: 'designs',
        action: 'add',
        id: 'm-harbour-launch',
        group: 'events',
        subject: [1500, 540],
        languages: designLanguages(ALL_LANGUAGES),
      },
      { picture: webp(1008, 1496) },
    );
    const sample = await accept({
      type: 'templates',
      action: 'translate',
      id: 'harbour',
      languages: { fr: { sample: frenchSample() } },
    });
    const done = await read<Published>(
      await send('/api/publish', 'POST', { uploads: [design, sample] }),
    );
    assert.deepEqual(done.skipped, []);
    assert.deepEqual(done.added, [
      'elements/designs/managed.json',
      'images/designs/m-harbour-launch.webp',
    ]);
    assert.deepEqual(done.changed, ['templates/catalog.json']);
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
      type: 'designs',
      action: 'add',
      id: 'm-harbour-launch',
      group: 'events',
      subject: [1, 1],
      languages: designLanguages(),
    });
    assert.equal(again.status, 422);
  });

  test('leaves accepted what no longer holds, or cannot be written, saying why', async () => {
    const { send, call, media, accept } = await live();
    const id = await accept({
      type: 'emoji',
      action: 'tag',
      id: 'emoji',
      languages: {
        he: { tags: { 'birthday-cake': balloon.he } },
        en: { tags: { 'birthday-cake': balloon.en } },
      },
    });
    // The item is gone from the library since the upload was accepted.
    const catalog = 'elements/catalogs/emoji-catalog.json';
    const empty = toBytes('[]');
    await media.put(catalog, empty, { customMetadata: { sha256: await sha256Hex(empty) } });
    forgetLibrary();
    const done = await read<Published>(await send('/api/publish', 'POST', {}));
    assert.deepEqual(done.uploads, []);
    assert.equal(done.skipped[0]!.id, id);
    assert.match(done.skipped[0]!.message, /no longer holds/);
    assert.equal(
      (await read<{ status: string }>(await call(`/api/uploads/${id}`))).status,
      'accepted',
    );
    // An upload that is not accepted is not published.
    const pending = await read<{ id: string }>(
      await send('/api/uploads', 'POST', {
        type: 'graphics',
        action: 'tag',
        id: 'graphics',
        languages: {
          he: { tags: { 'fluent-emoji:balloon': balloon.he } },
          en: { tags: { 'fluent-emoji:balloon': balloon.en } },
        },
      }),
    );
    const named = await read<Published>(
      await send('/api/publish', 'POST', { uploads: [pending.id] }),
    );
    assert.match(named.skipped[0]!.message, /pending/);
    assert.equal((await send('/api/publish', 'POST', { uploads: ['nothing'] })).status, 400);
  });

  test('is one at a time, and an upload is no longer marked published by hand', async () => {
    const { send, media, accept } = await live();
    const id = await accept({
      type: 'emoji',
      action: 'tag',
      id: 'emoji',
      languages: {
        he: { tags: { 'birthday-cake': balloon.he } },
        en: { tags: { 'birthday-cake': balloon.en } },
      },
    });
    const marked = await send(`/api/uploads/${id}/status`, 'POST', { status: 'published' });
    assert.equal(marked.status, 409);
    assert.equal((await read<{ error: string }>(marked)).error, 'publish-instead');
    await media.put(
      '_publishing.json',
      JSON.stringify({ by: 'someone', at: new Date().toISOString() }),
    );
    const busy = await send('/api/publish', 'POST', {});
    assert.equal(busy.status, 409);
    assert.equal((await read<{ error: string }>(busy)).error, 'publishing');
    // A publication left behind long ago does not hold the library.
    await media.put(
      '_publishing.json',
      JSON.stringify({ by: 'someone', at: '2026-01-01T00:00:00.000Z' }),
    );
    assert.equal((await read<Published>(await send('/api/publish', 'POST', {}))).uploads.length, 1);
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
    const { call, send, media, before } = await author();
    const icons = toBytes('{"cake":["birthday","party"]}');
    const font = new Uint8Array([4, 5, 6, 7]);
    const [iconsSha, fontSha] = [await sha256Hex(icons), await sha256Hex(font)];
    assert.equal((await put(call, icons, iconsSha)).status, 200);
    const staged = await read<{ already: boolean }>(await put(call, font, fontSha));
    assert.equal(staged.already, false);
    assert.equal((await read<{ already: boolean }>(await put(call, font, fontSha))).already, true);
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
    // What it replaced is kept; the staged files are gone.
    assert.deepEqual(
      JSON.parse(stored(media, `_history/${done.published}/manifest.json`)!),
      before,
    );
    assert.equal(
      stored(media, `_history/${done.published}/icons/lucide/tags.json`),
      '{"cake":["birthday"]}',
    );
    assert.equal(
      [...media.objects.keys()].some((key) => key.startsWith('_staged/')),
      false,
    );
  });

  test('changes nothing where the library changed a file since the copy was pulled', async () => {
    const { call, send, media, before } = await author();
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
    assert.equal(media.objects.has('_publishing.json'), false);
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
