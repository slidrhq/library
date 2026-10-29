import assert from 'node:assert/strict';
import { afterEach, describe, mock, test } from 'node:test';
import { forgetLibrary } from '../uploads/library.ts';
import { MEDIA, MemoryBucket, caller, designSlide } from '../uploads/testing.ts';
import { REVS, THUMBS } from './designFiles.ts';
import {
  LOCK,
  MANIFEST,
  PUBLICATIONS,
  encodeManifest,
  sha256Hex,
  toBytes,
  toText,
  type Manifest,
} from './live.ts';
import { CATALOG, DesignCatalog, MANAGED, SIZES, putDesign } from './designCatalog.ts';
import { encodeTags, type DesignRecord } from './merge.ts';
import { joined } from './parts.ts';
import { TarError, readTar, tarHeader, tarOf, tarPadding, type TarEntry } from './tar.ts';

afterEach(() => {
  mock.restoreAll();
  forgetLibrary();
});

const read = async <T>(response: Response) => (await response.json()) as T;

const bytesOf = (value: unknown) =>
  value instanceof Uint8Array
    ? value
    : toBytes(typeof value === 'string' ? value : JSON.stringify(value));

const streamOf = (bytes: Uint8Array) => new Blob([bytes as Uint8Array<ArrayBuffer>]).stream();

const gzipped = async (bytes: Uint8Array) =>
  new Uint8Array(
    await new Response(streamOf(bytes).pipeThrough(new CompressionStream('gzip'))).arrayBuffer(),
  );

async function entriesOf(stream: ReadableStream<Uint8Array>) {
  const all: TarEntry[] = [];
  for await (const entry of readTar(stream)) all.push(entry);
  return all;
}

/** The library in its bucket: each file under its path with its hash, and the manifest of them. */
async function liveLibrary(bucket: MemoryBucket, files: Record<string, unknown>) {
  const manifest: Manifest = { version: 1, published: '2026-10-19T22:14:16.216Z', files: {} };
  for (const [path, value] of Object.entries(files)) {
    const bytes = bytesOf(value);
    const sha256 = await sha256Hex(bytes);
    await bucket.put(path, bytes, { customMetadata: { sha256 } });
    manifest.files[path] = { size: bytes.length, sha256 };
  }
  await bucket.put(MANIFEST, encodeManifest(manifest));
  return manifest;
}

const stored = (bucket: MemoryBucket, path: string) => {
  const held = bucket.objects.get(path);
  return held ? toText(held.data) : undefined;
};

const manifestOf = (bucket: MemoryBucket) => JSON.parse(stored(bucket, MANIFEST)!) as Manifest;

const snapshot = (bucket: MemoryBucket) =>
  Object.fromEntries([...bucket.objects].map(([key, held]) => [key, held.data.join(',')]));

/**
 * An archive of `files` with the manifest that names them first, as the page's export writes it;
 * `tamper` puts other bytes in it than the manifest names, `without` leaves files out of it.
 */
async function archiveOf(
  files: Record<string, unknown>,
  {
    tamper = {},
    without = [],
    more = [],
    published = '2026-10-26T06:22:35.306Z',
  }: {
    tamper?: Record<string, string>;
    without?: string[];
    more?: [string, Uint8Array][];
    published?: string;
  } = {},
) {
  const manifest: Manifest = { version: 1, published, files: {} };
  const list: [string, Uint8Array][] = [];
  for (const [path, value] of Object.entries(files)) {
    const bytes = bytesOf(value);
    manifest.files[path] = { size: bytes.length, sha256: await sha256Hex(bytes) };
    if (!without.includes(path)) list.push([path, tamper[path] ? toBytes(tamper[path]) : bytes]);
  }
  return tarOf([[MANIFEST, toBytes(encodeManifest(manifest))], ...list, ...more]);
}

/** A header as other tools write one: of GNU's own format, of `type`, its checksum made again. */
function gnuHeader(name: string, size: number, type: string) {
  const header = tarHeader(name, size, 0).slice(0, 512);
  header[156] = type.charCodeAt(0);
  header.set(toBytes('ustar  \0'), 257);
  header.fill(0, 345, 500);
  header.fill(0x20, 148, 156);
  const sum = header.reduce((total, byte) => total + byte, 0);
  header.set(toBytes(`${sum.toString(8).padStart(6, '0')}\0 `), 148);
  return header;
}

const join = (...parts: Uint8Array[]) => {
  const all = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    all.set(part, at);
    at += part.length;
  }
  return all;
};

describe('an archive', () => {
  const long = `images/designs/thumbs/320/pt-BR/${'a-rather-long-name-'.repeat(4)}.webp`;
  const longer = `fonts/${'x'.repeat(130)}.woff2`;
  const files: [string, Uint8Array][] = [
    ['manifest.json', toBytes('{"version":1}')],
    ['fonts/heebo/heebo-hebrew.woff2', new Uint8Array([0, 1, 2, 255])],
    [long, new Uint8Array(1000).fill(7)],
    [longer, new Uint8Array(512).fill(9)],
    ['templates/סדנה/template.json', toBytes('{}')],
    ['empty.json', new Uint8Array(0)],
  ];

  test('is read back as it was written, plain or gzipped, its long paths whole', async () => {
    const tar = tarOf(files, 1_761_459_755);
    assert.equal(tar.length % 512, 0);
    for (const stream of [streamOf(tar), streamOf(await gzipped(tar))]) {
      const entries = await entriesOf(stream);
      assert.deepEqual(
        entries.map(({ path, type, bytes }) => [path, type, [...bytes]]),
        files.map(([path, bytes]) => [path, 'file', [...bytes]]),
      );
    }
  });

  test('is read as other tools write it: folders, ./, and GNU’s long names', async () => {
    const name = `./icons/${'n'.repeat(120)}.json`;
    const body = toBytes('{"x":1}');
    const longName = toBytes(`${name}\0`);
    const tar = join(
      gnuHeader('./', 0, '5'),
      gnuHeader('././@LongLink', longName.length, 'L'),
      longName,
      tarPadding(longName.length),
      gnuHeader(name.slice(0, 100), body.length, '0'),
      body,
      tarPadding(body.length),
      gnuHeader('./link', 0, '2'),
      // GNU tar ends an archive with a whole record of empty blocks.
      new Uint8Array(512 * 20),
    );
    const entries = await entriesOf(streamOf(tar));
    assert.deepEqual(
      entries.map(({ path, type }) => [path, type]),
      [
        ['./', 'folder'],
        [name, 'file'],
        ['./link', 'other'],
      ],
    );
    assert.equal(toText(entries[1]!.bytes), '{"x":1}');
  });

  test('is refused when it is none, or ends before it should', async () => {
    await assert.rejects(
      entriesOf(streamOf(toBytes('not an archive at all'.repeat(40)))),
      TarError,
    );
    const tar = tarOf(files);
    await assert.rejects(entriesOf(streamOf(tar.subarray(0, 1200))), TarError);
    await assert.rejects(entriesOf(streamOf((await gzipped(tar)).subarray(0, 300))), TarError);
    // A file larger than a file of the library is refused before it is read.
    await assert.rejects(
      (async () => {
        for await (const _ of readTar(streamOf(tar), 999)) void _;
      })(),
      /at most 999/,
    );
  });
});

describe('an archive brought into the library', () => {
  const ZONE = { MEDIA_ZONE_ID: 'zone-1', MEDIA_PURGE_TOKEN: 'purge-token' };

  async function admin(files?: Record<string, unknown>) {
    const session = await caller();
    const media = new MemoryBucket();
    Object.assign(session.env, { MEDIA: media });
    const before = files ? await liveLibrary(media, files) : undefined;
    const bring = (body: Uint8Array, type = 'application/gzip') =>
      session.call('/api/library/archive', {
        method: 'POST',
        headers: { 'Content-Type': type },
        body: body as Uint8Array<ArrayBuffer>,
      });
    return { ...session, media, before, bring };
  }

  interface Imported {
    published?: string;
    from: string;
    files: number;
    added: string[];
    changed: string[];
    removed: string[];
    same: number;
    skipped: string[];
  }

  test('adds what the library lacks, writes over what differs, and keeps every other file', async () => {
    const { env, bring, bucket, media, before } = await admin({
      'tags/emoji.json': '{"version":1,"tags":{}}',
      'fonts/heebo/heebo.woff2': new Uint8Array([1, 2, 3]),
      'icons/lucide/tags.json': '{"cake":["birthday"]}',
    });
    Object.assign(env, ZONE);
    const purged: string[][] = [];
    mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
      purged.push(((await new Request(input, init).json()) as { files: string[] }).files);
      return Response.json({ success: true });
    });
    const archive = await archiveOf({
      'fonts/heebo/heebo.woff2': new Uint8Array([1, 2, 3]),
      'icons/lucide/tags.json': '{"cake":["birthday","party"]}',
      'fonts/rubik/rubik.woff2': new Uint8Array([4, 5]),
    });
    const response = await bring(await gzipped(archive));
    assert.equal(response.status, 200, await response.clone().text());
    const done = await read<Imported>(response);
    assert.deepEqual(
      [done.added, done.changed, done.removed, done.same, done.files, done.from],
      [
        ['fonts/rubik/rubik.woff2'],
        ['icons/lucide/tags.json'],
        [],
        1,
        3,
        '2026-10-26T06:22:35.306Z',
      ],
    );
    const manifest = manifestOf(media);
    assert.equal(manifest.published, done.published);
    assert.deepEqual(Object.keys(manifest.files).sort(), [
      'fonts/heebo/heebo.woff2',
      'fonts/rubik/rubik.woff2',
      'icons/lucide/tags.json',
      'tags/emoji.json',
    ]);
    assert.equal(stored(media, 'icons/lucide/tags.json'), '{"cake":["birthday","party"]}');
    assert.equal(stored(media, 'tags/emoji.json'), '{"version":1,"tags":{}}');
    assert.equal(
      media.objects.get('fonts/rubik/rubik.woff2')!.http.cacheControl,
      'public, max-age=0, must-revalidate',
    );
    // What it replaced is kept, it is a publication of its own, and the lease is free again.
    assert.deepEqual(
      JSON.parse(stored(bucket, `media/history/${done.published}/manifest.json`)!),
      before,
    );
    assert.equal(
      stored(bucket, `media/history/${done.published}/icons/lucide/tags.json`),
      '{"cake":["birthday"]}',
    );
    const record = JSON.parse(stored(bucket, `${PUBLICATIONS}/${done.published}.json`)!) as {
      kind: string;
      by: { id: string };
    };
    assert.equal(record.kind, 'archive');
    assert.deepEqual(JSON.parse(stored(bucket, LOCK)!), { free: true });
    assert.deepEqual(purged, [
      [
        `${MEDIA}fonts/rubik/rubik.woff2`,
        `${MEDIA}icons/lucide/tags.json`,
        `${MEDIA}manifest.json`,
      ],
    ]);
    // The same archive again changes nothing, and makes no publication.
    const again = await read<Imported>(await bring(archive, 'application/x-tar'));
    assert.deepEqual(
      [again.published, again.added, again.changed, again.same],
      [undefined, [], [], 3],
    );
  });

  test('fills an empty media: the library is there once it is in', async () => {
    const { bring, call, media } = await admin();
    const archive = await archiveOf({
      'fonts/catalog.json': { families: [] },
      'elements/cards/catalog.json': { sets: [] },
    });
    const done = await read<Imported>(await bring(archive));
    assert.deepEqual(done.added, ['elements/cards/catalog.json', 'fonts/catalog.json']);
    assert.deepEqual(Object.keys(manifestOf(media).files).sort(), done.added);
    const status = await read<{ live: boolean; files: number }>(await call('/api/library'));
    assert.deepEqual([status.live, status.files], [true, 2]);
    assert.equal(await (await call('/media/fonts/catalog.json')).text(), '{"families":[]}');
  });

  test('writes nothing of an archive that is damaged, incomplete, or not of the library', async () => {
    const files = {
      'icons/lucide/tags.json': '{"cake":["birthday"]}',
      'tags/emoji.json': '{"version":1,"tags":{}}',
    };
    const { bring, bucket, media } = await admin(files);
    const changed = { ...files, 'icons/lucide/tags.json': '{}', 'fonts/new.woff2': 'new' };
    const cases: [Uint8Array, number, string][] = [
      // A file is written before the one found damaged: it is put back.
      [await archiveOf(changed, { tamper: { 'tags/emoji.json': '{"broken":' } }), 422, 'damaged'],
      [await archiveOf(changed, { without: ['fonts/new.woff2'] }), 422, 'incomplete'],
      [tarOf([['fonts/new.woff2', toBytes('new')]]), 422, 'no-manifest'],
      [toBytes('PK\u0003\u0004 a zip, not a tar'.repeat(30)), 422, 'not-an-archive'],
      [
        await archiveOf(changed, { more: [['../../etc/passwd', toBytes('x')]] }),
        422,
        'not-a-library',
      ],
      [await archiveOf(changed, { more: [['_history/x', toBytes('x')]] }), 422, 'not-a-library'],
      [await archiveOf(changed, { more: [['fonts/new.woff2', toBytes('new')]] }), 422, 'twice'],
    ];
    const was = snapshot(media);
    for (const [archive, status, error] of cases) {
      const response = await bring(archive);
      assert.equal(response.status, status, error);
      assert.equal((await read<{ error: string }>(response)).error, error);
      assert.deepEqual(snapshot(media), was, error);
      assert.deepEqual(JSON.parse(stored(bucket, LOCK)!), { free: true });
    }
  });

  test('leaves out what a system leaves beside the files it archives', async () => {
    const { bring, media } = await admin({ 'tags/emoji.json': '{}' });
    const archive = await archiveOf(
      { 'fonts/heebo/heebo.woff2': 'woff2' },
      {
        more: [
          ['.DS_Store', toBytes('x')],
          ['fonts/heebo/._heebo.woff2', toBytes('x')],
        ],
      },
    );
    const done = await read<Imported>(await bring(archive));
    assert.deepEqual(done.skipped, ['.DS_Store', 'fonts/heebo/._heebo.woff2']);
    assert.deepEqual(Object.keys(manifestOf(media).files).sort(), [
      'fonts/heebo/heebo.woff2',
      'tags/emoji.json',
    ]);
  });

  test('is brought in by an admin alone', async () => {
    const archive = await archiveOf({ 'tags/emoji.json': '{}' });
    const reviewer = await caller({ email: 'other-editor@example.com' });
    Object.assign(reviewer.env, { MEDIA: new MemoryBucket() });
    const body = { method: 'POST', body: archive as Uint8Array<ArrayBuffer> };
    assert.equal((await reviewer.call('/api/library/archive', body)).status, 403);
    const nobody = await caller({ nobody: true });
    Object.assign(nobody.env, { MEDIA: new MemoryBucket() });
    assert.ok([401, 403].includes((await nobody.call('/api/library/archive', body)).status));
  });

  /** A catalog of designs, as publishing writes it. */
  const catalogOf = (...designs: DesignRecord[]) => {
    const catalog = DesignCatalog.of(undefined);
    for (const one of designs) putDesign(catalog, one);
    return joined(catalog.parts());
  };

  const designOf = (id: string, group: string, words = 'Lancement'): DesignRecord => ({
    id,
    name: { he: id, en: id },
    group,
    slides: {
      he: designSlide('he'),
      en: designSlide('en'),
      fr: designSlide('fr', undefined, [words, 'Une soirée au port', 'Venez nombreux ce soir']),
    },
    subject: [10, 10],
    size: [100, 100],
  });

  test('of designs in some languages, writes the library’s other languages again from its catalog', async () => {
    /** A library of the design, and what publishing writes of its catalog. */
    async function libraryOf(words: string) {
      const session = await admin({ [CATALOG]: catalogOf(designOf('m-harbour', 'events', words)) });
      const published = await session.send('/api/publish', 'POST', { uploads: [] });
      assert.equal(published.status, 200, await published.clone().text());
      return session;
    }
    const here = await libraryOf('Lancement');
    const there = await libraryOf('Inauguration');
    const fr = 'elements/designs/fr/index.json';
    assert.notEqual(stored(here.media, fr), stored(there.media, fr));
    // Exported with Hebrew and English alone.
    const parts = [
      CATALOG,
      REVS,
      'elements/designs/he/index.json',
      'elements/designs/en/index.json',
    ];
    const archive = await archiveOf(
      Object.fromEntries(parts.map((path) => [path, there.media.objects.get(path)!.data])),
    );
    const done = await read<Imported>(await here.bring(archive));
    assert.ok(done.changed.includes(fr), JSON.stringify(done));
    assert.equal(stored(here.media, fr), stored(there.media, fr));
    for (const path of [...parts, fr]) {
      assert.equal(
        manifestOf(here.media).files[path]?.sha256,
        manifestOf(there.media).files[path]?.sha256,
        path,
      );
    }
  });

  test('merges the catalogs: what only the library has stays beside what the archive brings', async () => {
    const tags = (items: Record<string, Record<string, string[]>>) =>
      encodeTags({ version: 1, tags: items });
    const { bring, media } = await admin({
      // The library published a design of its own, and drew the design both have in French.
      [CATALOG]: catalogOf(designOf('m-both', 'events', 'Ici'), designOf('m-mine', 'local')),
      [SIZES]: { 'm-both': [1, 1], 'm-mine': [2, 2] },
      'tags/designs.json': tags({
        'm-both': { he: ['כאן'], it: ['qui'] },
        'm-mine': { he: ['שלי'], en: ['mine'] },
      }),
      'tags/emoji.json': tags({ cake: { he: ['עוגה'], en: ['cake'] } }),
      [THUMBS]: { widths: [320], designs: { he: { 'm-mine': 'mine-word', 'm-both': 'old' } } },
      'templates/catalog.json': { templates: [], samples: { harbour: { he: [1], fr: [9] } } },
    });
    const archive = await archiveOf({
      [CATALOG]: catalogOf(designOf('m-theirs', 'events'), designOf('m-both', 'events', 'Là-bas')),
      [SIZES]: { 'm-both': [3, 3], 'm-theirs': [4, 4] },
      'tags/designs.json': tags({
        'm-both': { he: ['שם'], en: ['there'] },
        'm-theirs': { he: ['שלהם'], en: ['theirs'] },
      }),
      [THUMBS]: { widths: [320], designs: { he: { 'm-both': 'new' } } },
      'templates/catalog.json': { templates: [], samples: { harbour: { he: [2], en: [3] } } },
    });
    const done = await read<Imported>(await bring(archive));
    assert.ok(done.published, JSON.stringify(done));
    // The designs: the archive's, then the library's own in its group.
    const catalog = JSON.parse(stored(media, CATALOG)!) as {
      groups: string[];
      groupIds: Record<string, string[]>;
      slides: Record<string, Record<string, { elements: unknown[] }>>;
    };
    assert.deepEqual(catalog.groups, ['events', 'local']);
    assert.deepEqual(catalog.groupIds, { events: ['m-theirs', 'm-both'], local: ['m-mine'] });
    assert.ok(JSON.stringify(catalog.slides['m-both']!.fr).includes('Là-bas'));
    assert.ok(catalog.slides['m-mine']);
    assert.deepEqual(JSON.parse(stored(media, SIZES)!), {
      'm-both': [3, 3],
      'm-theirs': [4, 4],
      'm-mine': [2, 2],
    });
    // The tags, an item and a language at a time; a part the archive did not bring, as it was.
    assert.deepEqual(JSON.parse(stored(media, 'tags/designs.json')!), {
      version: 1,
      tags: {
        'm-both': { he: ['שם'], en: ['there'], it: ['qui'] },
        'm-theirs': { he: ['שלהם'], en: ['theirs'] },
        'm-mine': { he: ['שלי'], en: ['mine'] },
      },
    });
    assert.ok(stored(media, 'tags/emoji.json')!.includes('עוגה'));
    assert.deepEqual(JSON.parse(stored(media, THUMBS)!), {
      widths: [320],
      designs: { he: { 'm-both': 'new', 'm-mine': 'mine-word' } },
    });
    assert.deepEqual(
      (JSON.parse(stored(media, 'templates/catalog.json')!) as { samples: unknown }).samples,
      { harbour: { he: [2], en: [3], fr: [9] } },
    );
    // What is made of the catalog is of the one merged.
    const revs = JSON.parse(stored(media, REVS)!) as { catalogs: Record<string, string[]> };
    assert.deepEqual(revs.catalogs[CATALOG], ['m-theirs', 'm-both', 'm-mine']);
    // Brought in again, it changes nothing.
    const again = await read<Imported>(await bring(archive));
    assert.equal(again.published, undefined, JSON.stringify(again));
  });

  test('merges the frames a group and a frame at a time, as the page exports them by group', async () => {
    const FRAMES = 'elements/catalogs/frames-catalog.json';
    const frame = (id: string, more: Record<string, unknown> = {}) => ({ id, w: 1, h: 1, ...more });
    const { bring, media } = await admin({
      [FRAMES]: {
        featured: ['circle', 'heart-magnet'],
        stickers: { balloon: '<svg/>' },
        groups: [
          { id: 'basic', frames: [frame('circle', { en: 'Circle' }), frame('square')] },
          { id: 'magnets', frames: [frame('heart-magnet', { extras: [{ art: 'balloon' }] })] },
          { id: 'devices', frames: [frame('phone')] },
        ],
      },
    });
    // Exported with the basic frames and the devices alone, the circle drawn again.
    const archive = await archiveOf({
      [FRAMES]: {
        featured: ['circle'],
        stickers: {},
        groups: [
          { id: 'basic', frames: [frame('circle', { en: 'Round' }), frame('pill')] },
          { id: 'devices', frames: [frame('laptop')] },
        ],
      },
    });
    const done = await read<Imported>(await bring(archive));
    assert.ok(done.changed.includes(FRAMES), JSON.stringify(done));
    assert.deepEqual(JSON.parse(stored(media, FRAMES)!), {
      featured: ['circle', 'heart-magnet'],
      stickers: { balloon: '<svg/>' },
      groups: [
        {
          id: 'basic',
          frames: [frame('circle', { en: 'Round' }), frame('pill'), frame('square')],
        },
        { id: 'magnets', frames: [frame('heart-magnet', { extras: [{ art: 'balloon' }] })] },
        { id: 'devices', frames: [frame('laptop'), frame('phone')] },
      ],
    });
    // Brought in again, it changes nothing.
    const again = await read<Imported>(await bring(archive));
    assert.equal(again.published, undefined, JSON.stringify(again));
  });

  test('of a library of before, makes its two catalogs one, as the library’s own', async () => {
    const both = { he: designSlide('he'), en: designSlide('en') };
    const { bring, media } = await admin({
      [CATALOG]: catalogOf(designOf('m-mine', 'local')),
      [MANAGED]: {
        groups: ['local'],
        groupIds: { local: ['m-older'] },
        slides: { 'm-older': both },
        names: { 'm-older': { he: 'ישן', en: 'Older' } },
        sizes: { 'm-older': [5, 5] },
      },
    });
    const archive = await archiveOf({
      [CATALOG]: { groups: ['deck'], groupIds: { deck: ['cover'] }, slides: { cover: both } },
      [MANAGED]: {
        version: 1,
        groups: ['deck', 'tech'],
        groupNames: { tech: { he: 'טק', en: 'Tech' } },
        groupIds: { deck: ['m-deck'], tech: ['m-chip'] },
        slides: { 'm-deck': both, 'm-chip': both },
        names: { 'm-chip': { he: 'שבב', en: 'Chip' } },
        sizes: { 'm-chip': [6, 6] },
        tags: { 'm-chip': { he: ['שבב'], en: ['chip'] } },
      },
      'elements/designs/he/managed.json': { slides: {} },
    });
    const done = await read<Imported>(await bring(archive));
    assert.ok(done.published, JSON.stringify(done));
    assert.ok(done.removed.includes(MANAGED));
    assert.equal(stored(media, MANAGED), undefined);
    assert.equal(stored(media, 'elements/designs/he/managed.json'), undefined);
    const catalog = JSON.parse(stored(media, CATALOG)!) as {
      groups: string[];
      groupIds: Record<string, string[]>;
      names: Record<string, unknown>;
    };
    assert.deepEqual(catalog.groups, ['deck', 'tech', 'local']);
    assert.deepEqual(catalog.groupIds, {
      deck: ['cover', 'm-deck'],
      tech: ['m-chip'],
      local: ['m-mine', 'm-older'],
    });
    assert.deepEqual(catalog.names['m-chip'], { he: 'שבב', en: 'Chip' });
    assert.deepEqual(JSON.parse(stored(media, SIZES)!), { 'm-chip': [6, 6], 'm-older': [5, 5] });
    assert.deepEqual((JSON.parse(stored(media, 'tags/designs.json')!) as { tags: unknown }).tags, {
      'm-chip': { he: ['שבב'], en: ['chip'] },
    });
    assert.deepEqual(
      Object.keys(manifestOf(media).files).filter((path) => path.includes('managed')),
      [],
    );
  });
});
