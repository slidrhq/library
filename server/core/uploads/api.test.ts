import assert from 'node:assert/strict';
import { afterEach, describe, mock, test } from 'node:test';
import type { ContentLanguage } from '@slidr/model';
import worker from '../../host/cloudflare/index.ts';
import { forgetLibrary } from './library.ts';
import {
  ALL_LANGUAGES,
  PICTURE,
  EDITOR,
  KEY,
  SITE,
  caller,
  designLanguages,
  designSlide,
  frenchSample,
  CATALOGS,
  publishLibrary,
  webp,
} from './testing.ts';

afterEach(() => mock.restoreAll());

interface Problem {
  error: string;
  message: string;
  issues?: { path: string; message: string; language?: string }[];
}

interface Answer {
  id: string;
  status: string;
  target: string;
  languages: Record<string, unknown>;
  missing: string[];
  files: Record<string, { sha256: string; width: number; height: number; url: string }>;
  history: { status: string; note?: string; by: { id: string } }[];
  note?: string;
}

const read = async <T>(response: Response) => (await response.json()) as T;

const newDesign = (
  languages: Record<string, unknown> = designLanguages(),
  extra: Record<string, unknown> = {},
) => ({
  type: 'designs',
  action: 'add',
  id: 'm-harbour-launch',
  group: 'events',
  subject: [1500, 540],
  languages,
  ...extra,
});

/** The issues of an answer of 422, by their paths. */
async function issuesOf(response: Response) {
  assert.equal(response.status, 422);
  const { error, issues = [] } = await read<Problem>(response);
  assert.equal(error, 'invalid');
  return issues;
}

describe('what the library takes', () => {
  test('names every part and every language, and why a part takes no uploads', async () => {
    const { call } = await caller();
    const response = await call('/api/content');
    assert.equal(response.status, 200);
    const content = await read<{
      languages: { code: string; base: boolean; dir: string }[];
      types: {
        type: string;
        uploads: boolean;
        closed?: string;
        paths: string[];
        actions: Record<string, unknown>;
      }[];
    }>(response);
    assert.deepEqual(
      content.languages.map((one) => one.code),
      [...ALL_LANGUAGES],
    );
    assert.deepEqual(
      content.languages.filter((one) => one.base).map((one) => one.code),
      ['he', 'en'],
    );
    assert.equal(content.languages.find((one) => one.code === 'ar')?.dir, 'rtl');
    const byType = Object.fromEntries(content.types.map((one) => [one.type, one]));
    assert.deepEqual(Object.keys(byType), [
      'designs',
      'templates',
      'cards',
      'frames',
      'shapes',
      'graphics',
      'emoji',
      'icons',
      'fonts',
    ]);
    assert.deepEqual(Object.keys(byType.designs!.actions), ['add', 'translate', 'tag']);
    assert.deepEqual(Object.keys(byType.templates!.actions), ['translate']);
    assert.equal(byType.fonts!.uploads, false);
    assert.match(byType.fonts!.closed!, /gen-builtin-fonts/);
    // A part the app searches takes the tags of its items, though it takes no new ones.
    for (const type of ['cards', 'frames', 'shapes', 'graphics', 'emoji', 'icons']) {
      assert.deepEqual(Object.keys(byType[type]!.actions), ['tag'], type);
      assert.equal(byType[type]!.uploads, true, type);
    }
    // An art set is a part of what is drawn from it, and of nothing else.
    const art = content.types.flatMap((one) =>
      one.paths.filter((path) => path.startsWith('elements/art/')).map((path) => [path, one.type]),
    );
    assert.equal(new Set(art.map(([path]) => path)).size, art.length);
    assert.ok(byType.graphics!.paths.includes('elements/art/fluent-color.notice.json'));
    assert.ok(byType.emoji!.paths.includes('elements/art/twemoji.json'));
  });

  test('describes itself as OpenAPI, with the model’s schema of a slide', async () => {
    const { call } = await caller();
    const api = await read<{
      openapi: string;
      paths: Record<string, unknown>;
      components: { schemas: { UploadRequest: { oneOf: { title: string }[] } } };
    }>(await call('/api/openapi.json'));
    assert.equal(api.openapi, '3.1.0');
    assert.ok(api.paths['/api/uploads/{id}/languages/{lang}']);
    assert.deepEqual(
      api.components.schemas.UploadRequest.oneOf.map((one) => one.title),
      [
        'designs: add',
        'designs: translate',
        'designs: tag',
        'templates: translate',
        'cards: tag',
        'frames: tag',
        'shapes: tag',
        'graphics: tag',
        'emoji: tag',
        'icons: tag',
      ],
    );
    const slide = await read<{ properties: Record<string, unknown> }>(
      await call('/api/schemas/slide.json'),
    );
    assert.ok(slide.properties.elements);
    assert.equal((await call('/api/schemas/sample.json')).status, 200);
    assert.equal((await call('/api/schemas/deck.json')).status, 404);
  });
});

describe('a new design', () => {
  test('is kept, with its picture, to wait in the languages it lacks', async () => {
    publishLibrary();
    const { bucket, call, upload } = await caller();
    const response = await upload(newDesign(), { picture: webp(1008, 1496) });
    assert.equal(response.status, 201);
    const made = await read<Answer>(response);
    assert.equal(response.headers.get('Location'), `/api/uploads/${made.id}`);
    assert.equal(made.status, 'pending');
    assert.equal(made.target, 'm-harbour-launch');
    assert.deepEqual(Object.keys(made.languages), ['he', 'en']);
    assert.deepEqual(made.missing, ALL_LANGUAGES.slice(2));
    // Where the library will keep it is the library's own business (D7).
    assert.equal('path' in made.files.picture!, false);
    assert.deepEqual([made.files.picture!.width, made.files.picture!.height], [1008, 1496]);
    assert.equal(made.history[0]!.by.id, EDITOR);
    assert.ok(bucket.objects.has(`uploads/${made.id}.json`));

    const picture = await call(made.files.picture!.url);
    assert.equal(picture.headers.get('Content-Type'), 'image/webp');
    assert.deepEqual(new Uint8Array(await picture.arrayBuffer()), webp(1008, 1496));
    assert.equal((await read<Answer>(await call(`/api/uploads/${made.id}`))).id, made.id);
  });

  test('is refused under an id the library has', async () => {
    publishLibrary(['images/designs/m-harbour-launch.webp']);
    const { upload } = await caller();
    const issues = await issuesOf(await upload(newDesign(), { picture: webp(800, 800) }));
    assert.deepEqual(
      issues.map((one) => one.path),
      ['id'],
    );
    assert.match(issues[0]!.message, /has a design m-harbour-launch already/);
  });

  test('says each thing wrong with it, at its place', async () => {
    publishLibrary();
    const { upload } = await caller();
    const { he, en } = designLanguages();
    const languages = {
      he,
      fr: { name: 'Soirée', slide: designSlide('fr') },
      xx: { slide: designSlide('en') },
    };
    const issues = await issuesOf(
      await upload(newDesign(languages, { subject: [3000, 0], colour: 'red' }), {
        picture: new Uint8Array(40),
      }),
    );
    assert.deepEqual(issues.map((one) => one.path).sort(), [
      'colour',
      'files.picture',
      'languages.en',
      'languages.xx',
    ]);
    // What holds of its form is checked first, then its content.
    const content = await issuesOf(
      await upload(
        newDesign(
          { he, en, fr: { name: 'Soirée', slide: designSlide('fr') } },
          { subject: [3000, 0] },
        ),
        {
          picture: webp(800, 800),
        },
      ),
    );
    assert.deepEqual(content.map((one) => one.path).sort(), ['languages.fr.name', 'subject']);
    assert.equal(content.find((one) => one.path === 'languages.fr.name')!.language, 'fr');
  });

  test('sets each language in a font that has its letters', async () => {
    publishLibrary();
    const { upload } = await caller();
    const languages = designLanguages();
    languages.he = { ...languages.he, slide: designSlide('he', 'Playfair Display') };
    const issues = await issuesOf(await upload(newDesign(languages), { picture: webp(800, 800) }));
    // One issue for the font, however many texts it sets.
    assert.equal(issues.length, 1);
    assert.equal(issues[0]!.language, 'he');
    assert.match(
      issues[0]!.message,
      /^3 texts, as "ערב השקה בנמל" in e_\w+, are set in Playfair Display, which has no he letters: set them in Frank Ruhl Libre, its counterpart\.$/,
    );

    // Latin letters in a Hebrew family are its own; a family the library does not have is not.
    languages.he = { ...languages.he, slide: designSlide('he') };
    languages.en = { ...languages.en, slide: designSlide('en', 'Heebo') };
    assert.equal((await upload(newDesign(languages), { picture: webp(800, 800) })).status, 201);
    languages.en = { ...languages.en, slide: designSlide('en', 'Comic Sans MS') };
    const unknown = await issuesOf(
      await upload(newDesign(languages, { id: 'm-other' }), { picture: webp(800, 800) }),
    );
    assert.match(unknown[0]!.message, /a font the library does not have/);
  });

  test('shows its own picture, and words written for it', async () => {
    publishLibrary();
    const { upload } = await caller();
    const languages = designLanguages();
    const slide = designSlide('en', undefined, ['Lorem ipsum dolor', 'Sit amet at the pier', 'Go']);
    const image = slide.elements[0]!;
    if (image.type === 'image') image.assetId = 'photo-17';
    languages.en = { ...languages.en, slide };
    const messages = (
      await issuesOf(await upload(newDesign(languages), { picture: webp(800, 800) }))
    )
      .map((one) => one.message)
      .join('\n');
    assert.match(messages, /shows photo-17: a design shows its own picture/);
    assert.match(messages, /No image of the slide shows __subject__/);
    assert.match(messages, /"Lorem ipsum" stands for text never written/);
  });

  test('brings its picture, as WebP', async () => {
    publishLibrary();
    const { upload } = await caller();
    const without = await issuesOf(await upload(newDesign()));
    assert.deepEqual(
      without.map((one) => one.path),
      ['files.picture'],
    );
    const png = new Uint8Array(40);
    png.set([0x89, 0x50, 0x4e, 0x47]);
    const wrong = await issuesOf(await upload(newDesign(), { picture: png, poster: webp(10, 10) }));
    assert.deepEqual(wrong.map((one) => one.path).sort(), ['files.picture', 'files.poster']);
  });

  test('is one upload of its id at a time', async () => {
    publishLibrary();
    const { upload } = await caller();
    assert.equal((await upload(newDesign(), { picture: webp(800, 800) })).status, 201);
    const issues = await issuesOf(await upload(newDesign(), { picture: webp(800, 800) }));
    assert.match(issues[0]!.message, /adds m-harbour-launch too/);
  });

  test('comes with the words its search finds it by, in Hebrew and English', async () => {
    publishLibrary();
    const { upload } = await caller();
    const { he, en } = designLanguages();
    const untagged = await issuesOf(
      await upload(newDesign({ he: { ...he, tags: undefined }, en }), { picture: webp(800, 800) }),
    );
    assert.deepEqual(
      untagged.map((one) => [one.path, one.language]),
      [['languages.he.tags', 'he']],
    );
    assert.match(untagged[0]!.message, /3 to 20 words/);

    const wrong = await issuesOf(
      await upload(
        newDesign({
          he: { ...he, tags: ['יוֹם הולדת', 'party', 'מסיבה', 'מסיבה', 'אייקון'] },
          en: { ...en, tags: ['Birthday', 'kids  party', 'מסיבה', 'cake'] },
        }),
        { picture: webp(800, 800) },
      ),
    );
    assert.deepEqual(
      wrong.map((one) => [one.path, one.message]),
      [
        ['languages.he.tags.0', '"יוֹם הולדת" is written without niqqud.'],
        ['languages.he.tags.1', '"party" is not written in Hebrew letters.'],
        ['languages.he.tags.3', '"מסיבה" is there twice.'],
        ['languages.he.tags.4', '"אייקון" says how it is drawn, not what it is or is for.'],
        ['languages.en.tags.0', '"Birthday" is written in lower case.'],
        ['languages.en.tags.1', '"kids  party" is written "kids party", with single spaces.'],
        ['languages.en.tags.2', '"מסיבה" is not written in English letters.'],
      ],
    );

    // Tags are in the languages the search reads, and in no other.
    const french = await issuesOf(
      await upload(
        newDesign({ he, en, fr: { slide: designSlide('fr'), tags: ['fête', 'soirée', 'port'] } }),
        { picture: webp(800, 800) },
      ),
    );
    assert.equal(french[0]!.path, 'languages.fr.tags');
    assert.match(french[0]!.message, /tagged in Hebrew and English only/);
  });
});

/** An upload of the tags of a part's items, in Hebrew and English. */
const tagsOf = (
  type: string,
  he: Record<string, unknown>,
  en: Record<string, unknown>,
  id = type,
) => ({ type, action: 'tag', id, languages: { he: { tags: he }, en: { tags: en } } });

describe('the tags of published items', () => {
  const balloon = { he: ['בלון', 'יום הולדת', 'מסיבה'], en: ['balloon', 'birthday', 'party'] };

  test('accept translated tags and validate their language and item keys', async () => {
    publishLibrary([], CATALOGS);
    const { send } = await caller();
    const base = tagsOf('emoji', { 'birthday-cake': balloon.he }, { 'birthday-cake': balloon.en });
    const made = await read<Answer>(
      await send('/api/uploads', 'POST', {
        ...base,
        languages: {
          ...base.languages,
          de: { tags: { 'birthday-cake': ['Geburtstag', 'Kuchen', 'Feier'] } },
          hi: { tags: { 'birthday-cake': ['जन्मदिन', 'केक', 'पार्टी'] } },
          ja: { tags: { 'birthday-cake': ['誕生日', 'ケーキ', 'パーティー'] } },
        },
      }),
    );
    assert.deepEqual(made.languages.de, {
      tags: { 'birthday-cake': ['Geburtstag', 'Kuchen', 'Feier'] },
    });
    const wrong = await issuesOf(
      await send(`/api/uploads/${made.id}/languages/ja`, 'PUT', {
        tags: { 'birthday-cake': ['birthday', 'cake', 'party'] },
      }),
    );
    assert.equal(wrong.length, 3);
    assert.match(wrong[0]!.message, /Japanese letters/);
    const missing = await issuesOf(
      await send(`/api/uploads/${made.id}/languages/fr`, 'PUT', {
        tags: { other: ['anniversaire', 'gâteau', 'fête'] },
      }),
    );
    assert.ok(missing.length > 0);
  });

  test('are kept, by the keys of the items, to be merged into the part’s tags', async () => {
    publishLibrary([], CATALOGS);
    const { send } = await caller();
    const response = await send(
      '/api/uploads',
      'POST',
      tagsOf(
        'graphics',
        { 'fluent-emoji:balloon': balloon.he, 'streamline-emojis:balloon': balloon.he },
        { 'fluent-emoji:balloon': balloon.en, 'streamline-emojis:balloon': balloon.en },
      ),
    );
    assert.equal(response.status, 201);
    const made = await read<Answer>(response);
    assert.equal(made.target, 'graphics');
    assert.deepEqual(made.missing, []);
    assert.deepEqual(Object.keys(made.languages), ['he', 'en']);
  });

  test('are for items the library has, each tagged in both languages', async () => {
    publishLibrary([], CATALOGS);
    const { send } = await caller();
    const issues = await issuesOf(
      await send(
        '/api/uploads',
        'POST',
        tagsOf(
          'graphics',
          { 'fluent-emoji:balloon': balloon.he, 'fluent-emoji:unicorn': balloon.he },
          { 'fluent-emoji:balloon': balloon.en, 'fluent-emoji:wrapped-gift': balloon.en },
        ),
      ),
    );
    assert.deepEqual(
      issues.map((one) => [one.path, one.message]),
      [
        [
          'languages.he.tags.fluent-emoji:unicorn',
          'The library has no graphic fluent-emoji:unicorn.',
        ],
        [
          'languages.en.tags.fluent-emoji:wrapped-gift',
          'fluent-emoji:wrapped-gift has no tags in Hebrew: an item is tagged in both.',
        ],
      ],
    );
  });

  test('know the keys of every part the app searches', async () => {
    publishLibrary(['images/designs/birthday.webp', 'images/designs/birthday-bg.webp'], CATALOGS);
    const { send } = await caller();
    const keys: Record<string, string[]> = {
      emoji: ['birthday-cake'],
      icons: ['lucide:cake', 'tabler:balloon'],
      // A preset of the renderer, though the catalog does not list it, a line, and the card.
      shapes: ['shape:rect', 'shape:heart', 'line:arrow', 'card'],
      designs: ['birthday'],
    };
    const of = (list: string[], tags: string[]) =>
      Object.fromEntries(list.map((key) => [key, tags]));
    // A design's backdrop is no design.
    const backdrop = await issuesOf(
      await send(
        '/api/uploads',
        'POST',
        tagsOf('designs', of(['birthday-bg'], balloon.he), of(['birthday-bg'], balloon.en)),
      ),
    );
    assert.match(backdrop[0]!.message, /has no design birthday-bg/);
    for (const [type, list] of Object.entries(keys)) {
      const answer = await send(
        '/api/uploads',
        'POST',
        tagsOf(type, of(list, balloon.he), of(list, balloon.en)),
      );
      assert.equal(answer.status, 201, type);
    }
  });

  test('of a part are one upload at a time, named by the part', async () => {
    publishLibrary([], CATALOGS);
    const { send } = await caller();
    const tags = tagsOf('emoji', { 'birthday-cake': balloon.he }, { 'birthday-cake': balloon.en });
    assert.equal((await send('/api/uploads', 'POST', tags)).status, 201);
    const again = await issuesOf(await send('/api/uploads', 'POST', tags));
    assert.match(again[0]!.message, /tags emoji too/);
    const named = await issuesOf(await send('/api/uploads', 'POST', { ...tags, id: 'cakes' }));
    assert.deepEqual(named[0], {
      path: 'id',
      message: 'An upload of the tags of emoji is named emoji.',
    });
  });

  test('are written again a language at a time, while they wait', async () => {
    publishLibrary([], CATALOGS);
    const { send } = await caller();
    const made = await read<Answer>(
      await send(
        '/api/uploads',
        'POST',
        tagsOf('emoji', { 'birthday-cake': balloon.he }, { 'birthday-cake': balloon.en }),
      ),
    );
    const cake = ['עוגת יום הולדת', 'עוגה', 'נרות'];
    const put = await send(`/api/uploads/${made.id}/languages/he`, 'PUT', {
      tags: { 'birthday-cake': cake },
    });
    assert.equal(put.status, 200);
    assert.deepEqual((await read<Answer>(put)).languages.he, { tags: { 'birthday-cake': cake } });
    // Hebrew alone may not tag what English does not.
    const issues = await issuesOf(
      await send(`/api/uploads/${made.id}/languages/he`, 'PUT', {
        tags: { 'birthday-cake': cake, 'red-heart': cake },
      }),
    );
    assert.deepEqual(
      issues.map((one) => one.path),
      ['languages.he.tags.red-heart'],
    );
  });

  test('are all a part takes, when it takes no new items', async () => {
    publishLibrary([], CATALOGS);
    const { send } = await caller();
    const issues = await issuesOf(
      await send('/api/uploads', 'POST', {
        type: 'graphics',
        action: 'add',
        id: 'x',
        languages: {},
      }),
    );
    assert.equal(issues[0]!.path, 'action');
    assert.match(issues[0]!.message, /does one of: tag\. .*generate-graphics-catalog/);
  });
});

describe('a part the library takes no uploads of', () => {
  test('is refused, saying why', async () => {
    const { send } = await caller();
    const response = await send('/api/uploads', 'POST', {
      type: 'fonts',
      action: 'add',
      id: 'Harbour Sans',
      languages: {},
    });
    assert.equal(response.status, 422);
    const problem = await read<Problem>(response);
    assert.equal(problem.error, 'not-uploadable');
    assert.match(problem.message, /gen-builtin-fonts\.mjs/);
    const unknown = await issuesOf(await send('/api/uploads', 'POST', { type: 'videos' }));
    assert.match(unknown[0]!.message, /designs, templates, cards/);
    const action = await issuesOf(
      await send('/api/uploads', 'POST', { type: 'templates', action: 'add' }),
    );
    assert.deepEqual(action[0], {
      path: 'action',
      message: 'An upload of templates does one of: translate.',
    });
  });
});

describe('the languages of an upload', () => {
  /** A new design that waits, in Hebrew and English. */
  async function waiting() {
    publishLibrary();
    const api = await caller();
    const made = await read<Answer>(await api.upload(newDesign(), { picture: webp(800, 800) }));
    return { ...api, made, at: `/api/uploads/${made.id}` };
  }

  test('are written one at a time, in the order of the app’s', async () => {
    const { send, at } = await waiting();
    const response = await send(`${at}/languages/fr`, 'PUT', { slide: designSlide('fr') });
    assert.equal(response.status, 200);
    await send(`${at}/languages/ar`, 'PUT', { slide: designSlide('ar') });
    const changed = await read<Answer>(
      await send(`${at}/languages/ja`, 'PUT', { slide: designSlide('ja') }),
    );
    assert.deepEqual(Object.keys(changed.languages), ['he', 'en', 'ar', 'fr', 'ja']);
    assert.ok(!changed.missing.includes('fr'));
  });

  test('are checked as they are written, and the upload stays as it was', async () => {
    const { send, call, at } = await waiting();
    const issues = await issuesOf(
      await send(`${at}/languages/ja`, 'PUT', { slide: designSlide('ja', 'Inter') }),
    );
    assert.ok(issues.every((one) => one.language === 'ja'));
    const kept = await read<Answer>(await call(at));
    assert.deepEqual(Object.keys(kept.languages), ['he', 'en']);
    assert.equal((await send(`${at}/languages/xx`, 'PUT', {})).status, 404);
  });

  test('are taken away, but for Hebrew and English', async () => {
    const { send, call, at } = await waiting();
    await send(`${at}/languages/fr`, 'PUT', { slide: designSlide('fr') });
    const response = await call(`${at}/languages/fr`, { method: 'DELETE' });
    assert.deepEqual(Object.keys((await read<Answer>(response)).languages), ['he', 'en']);
    const he = await call(`${at}/languages/he`, { method: 'DELETE' });
    assert.equal(he.status, 409);
    assert.equal((await read<Problem>(he)).error, 'required');
  });

  test('are all there before a design is accepted', async () => {
    const { send, at } = await waiting();
    const early = await send(`${at}/status`, 'POST', { status: 'accepted' });
    assert.equal(early.status, 409);
    assert.equal((await read<Problem>(early)).error, 'incomplete');
    for (const lang of ALL_LANGUAGES.slice(2)) {
      const written = await send(`${at}/languages/${lang}`, 'PUT', { slide: designSlide(lang) });
      assert.equal(written.status, 200, lang);
    }
    const accepted = await read<Answer>(await send(`${at}/status`, 'POST', { status: 'accepted' }));
    assert.equal(accepted.status, 'accepted');
    assert.deepEqual(accepted.missing, []);
    assert.deepEqual(
      accepted.history.map((one) => one.status),
      ['pending', 'accepted'],
    );
    // Accepted, it is no longer changed.
    const late = await send(`${at}/languages/fr`, 'PUT', { slide: designSlide('fr') });
    assert.equal((await read<Problem>(late)).error, 'not-pending');
  });
});

describe('a translation', () => {
  test('writes a published design in another language', async () => {
    publishLibrary(['images/designs/m-techmeetup.webp', 'images/designs/techmeetup.webp']);
    const { send } = await caller();
    const translation = (id: string, languages: Partial<Record<ContentLanguage, unknown>>) => ({
      type: 'designs',
      action: 'translate',
      id,
      languages,
    });
    const response = await send(
      '/api/uploads',
      'POST',
      translation('m-techmeetup', { fr: { slide: designSlide('fr') } }),
    );
    assert.equal(response.status, 201);
    assert.deepEqual((await read<Answer>(response)).missing, []);

    const he = await issuesOf(
      await send(
        '/api/uploads',
        'POST',
        translation('m-techmeetup', { he: { slide: designSlide('he') } }),
      ),
    );
    assert.match(he[0]!.message, /not written in he here/);
    const none = await issuesOf(
      await send(
        '/api/uploads',
        'POST',
        translation('m-nothing', { fr: { slide: designSlide('fr') } }),
      ),
    );
    assert.match(none[0]!.message, /no design m-nothing/);
    const authored = await issuesOf(
      await send(
        '/api/uploads',
        'POST',
        translation('techmeetup', { fr: { slide: designSlide('fr') } }),
      ),
    );
    assert.match(authored[0]!.message, /translated with its scripts/);
  });

  test('writes a template’s sample in another language, seated on its layouts', async () => {
    publishLibrary();
    const { send } = await caller();
    const translation = (sample: unknown, lang = 'fr', id = 'harbour') => ({
      type: 'templates',
      action: 'translate',
      id,
      languages: { [lang]: { sample } },
    });
    const response = await send('/api/uploads', 'POST', translation(frenchSample()));
    assert.equal(response.status, 201);
    assert.equal((await read<Answer>(response)).target, 'harbour');

    const [opening, quay] = frenchSample();
    const issues = await issuesOf(
      await send(
        '/api/uploads',
        'POST',
        translation([{ ...opening, layout: 'l_harbour_chart' }, quay]),
      ),
    );
    assert.deepEqual(issues[0]!.path, 'languages.fr.sample.0.layout');
    const picture = await issuesOf(
      await send(
        '/api/uploads',
        'POST',
        translation([
          opening,
          { ...quay!, content: { ...quay!.content, image: { assetId: 'b'.repeat(64) } } },
        ]),
      ),
    );
    assert.match(picture[0]!.message, /No picture of the templates has the id b{64}/);
    const unseated = await issuesOf(
      await send(
        '/api/uploads',
        'POST',
        translation([{ ...opening!, content: { ...opening!.content, quote: { paragraphs: [] } } }]),
      ),
    );
    assert.match(unseated[0]!.message, /cannot show it: l_harbour_hero has no place for quote/);
    const he = await issuesOf(
      await send('/api/uploads', 'POST', translation(frenchSample(), 'he')),
    );
    assert.match(he[0]!.message, /templates are not written in he here/);
    const none = await issuesOf(
      await send('/api/uploads', 'POST', translation(frenchSample(), 'fr', 'nowhere')),
    );
    assert.match(none[0]!.message, /no template nowhere/);
    assert.equal(PICTURE.name, 'harbour-pier.webp');
  });
});

describe('the status of an upload', () => {
  test('goes from waiting to rejected, with a note, and is then withdrawn', async () => {
    publishLibrary();
    const { bucket, call, send, upload } = await caller();
    const made = await read<Answer>(await upload(newDesign(), { picture: webp(800, 800) }));
    const at = `/api/uploads/${made.id}`;
    const published = await send(`${at}/status`, 'POST', { status: 'published' });
    assert.equal(published.status, 409);
    const rejected = await read<Answer>(
      await send(`${at}/status`, 'POST', { status: 'rejected', note: 'The picture is cropped.' }),
    );
    assert.equal(rejected.status, 'rejected');
    assert.equal(rejected.note, 'The picture is cropped.');
    assert.equal(rejected.history.at(-1)!.note, 'The picture is cropped.');
    assert.equal((await call(at, { method: 'DELETE' })).status, 204);
    assert.equal((await call(at)).status, 404);
    // Nothing of the upload is kept; the library's people are.
    const left = [...bucket.objects.keys()].filter((key) => /^(uploads|files)\//.test(key));
    assert.deepEqual(left, []);
  });

  test('is published only once accepted, and an accepted upload stays', async () => {
    publishLibrary(['images/designs/m-techmeetup.webp']);
    const { call, send } = await caller();
    const made = await read<Answer>(
      await send('/api/uploads', 'POST', {
        type: 'designs',
        action: 'translate',
        id: 'm-techmeetup',
        languages: { fr: { slide: designSlide('fr') } },
      }),
    );
    const at = `/api/uploads/${made.id}`;
    assert.equal(
      (await read<Answer>(await send(`${at}/status`, 'POST', { status: 'accepted' }))).status,
      'accepted',
    );
    assert.equal((await call(at, { method: 'DELETE' })).status, 409);
    const done = await read<Answer>(await send(`${at}/status`, 'POST', { status: 'published' }));
    assert.equal(done.status, 'published');
    const again = await send(`${at}/status`, 'POST', { status: 'pending' });
    assert.equal((await read<Problem>(again)).error, 'not-allowed');
    const bad = await issuesOf(await send(`${at}/status`, 'POST', { status: 'done' }));
    assert.equal(bad[0]!.path, 'status');
    // Marked published by mistake, it goes back to wait for a publication, and says so.
    const back = await read<Answer>(
      await send(`${at}/status`, 'POST', { status: 'accepted', note: 'not in the library yet' }),
    );
    assert.equal(back.status, 'accepted');
    assert.deepEqual(
      back.history.map((one) => one.status),
      ['pending', 'accepted', 'published', 'accepted'],
    );
    assert.equal(back.history.at(-1)!.note, 'not in the library yet');
  });
});

describe('the list of uploads', () => {
  test('is newest first, by type, status and language, a page at a time', async () => {
    publishLibrary(['images/designs/m-techmeetup.webp']);
    const { call, send, upload } = await caller();
    let tick = Date.parse('2026-10-20T08:00:00Z');
    mock.method(Date, 'now', () => (tick += 1000));
    const design = await read<Answer>(await upload(newDesign(), { picture: webp(800, 800) }));
    const translations: Answer[] = [];
    for (const lang of ['fr', 'de', 'ja'] as const) {
      const response = await send('/api/uploads', 'POST', {
        type: 'designs',
        action: 'translate',
        id: 'm-techmeetup',
        languages: { [lang]: { slide: designSlide(lang) } },
      });
      translations.push(await read<Answer>(response));
    }
    const list = async (query: string) =>
      read<{ uploads: { id: string }[]; next?: string }>(await call(`/api/uploads${query}`));

    const all = await list('');
    assert.deepEqual(
      all.uploads.map((one) => one.id),
      [...translations.map((one) => one.id).reverse(), design.id],
    );
    assert.deepEqual(
      (await list('?action=add')).uploads.map((one) => one.id),
      [design.id],
    );
    assert.deepEqual(
      (await list('?language=de')).uploads.map((one) => one.id),
      [translations[1]!.id],
    );
    assert.deepEqual(
      (await list('?language=he&status=pending')).uploads.map((one) => one.id),
      [design.id],
    );
    assert.deepEqual((await list('?status=accepted')).uploads, []);

    const first = await list('?limit=2');
    assert.equal(first.uploads.length, 2);
    const second = await list(`?limit=2&after=${first.next}`);
    assert.deepEqual(
      [...first.uploads, ...second.uploads].map((one) => one.id),
      all.uploads.map((one) => one.id),
    );
    assert.equal(second.next, undefined);
    assert.equal((await call('/api/uploads?status=lost')).status, 400);
  });
});

describe('who may upload', () => {
  const refused = async (response: Response, status: number, error: string) => {
    assert.equal(response.status, status);
    assert.equal((await read<Problem>(response)).error, error);
  };

  test('no one signed in reads what the API takes, and nothing of the uploads', async () => {
    publishLibrary();
    const { call, upload } = await caller({ nobody: true });
    for (const open of ['/api/content', '/api/openapi.json', '/api/schemas/slide.json']) {
      assert.equal((await call(open)).status, 200, open);
    }
    await refused(await call('/api/uploads'), 401, 'signed-out');
    // A write from the page without a session, and one from anywhere else (a script without a key).
    const form = new FormData();
    form.set('upload', JSON.stringify(newDesign()));
    const fromPage = await call('/api/uploads', {
      method: 'POST',
      headers: { Origin: SITE },
      body: form,
    });
    await refused(fromPage, 401, 'signed-out');
    await refused(await upload(newDesign(), { picture: webp(800, 800) }), 403, 'another-site');
  });

  test('anyone signed in uploads, and sees and changes only their own', async () => {
    publishLibrary(['images/designs/m-techmeetup.webp']);
    const owner = await caller();
    const someone = await caller({ email: 'someone@example.com' }, owner.bucket);
    const french = {
      type: 'designs',
      action: 'translate',
      id: 'm-techmeetup',
      languages: { fr: { slide: designSlide('fr') } },
    };
    const theirs = await read<Answer>(await someone.send('/api/uploads', 'POST', french));
    assert.equal(theirs.history[0]!.by.id, 'someone@example.com');
    const mine = await read<Answer>(await owner.upload(newDesign(), { picture: webp(800, 800) }));
    const listed = async (who: typeof owner) =>
      (await read<{ uploads: { id: string }[] }>(await who.call('/api/uploads'))).uploads.map(
        (one) => one.id,
      );
    assert.deepEqual(await listed(someone), [theirs.id]);
    assert.deepEqual((await listed(owner)).sort(), [theirs.id, mine.id].sort());
    // Another's upload is not there, as far as an uploader can tell.
    const at = `/api/uploads/${mine.id}`;
    await refused(await someone.call(at), 404, 'not-found');
    await refused(await someone.call(`${at}/files/picture`), 404, 'not-found');
    await refused(await someone.call(at, { method: 'DELETE' }), 404, 'not-found');
    // Reviewing is the members'.
    const accept = await someone.send(`/api/uploads/${theirs.id}/status`, 'POST', {
      status: 'accepted',
    });
    await refused(accept, 403, 'not-a-reviewer');
    assert.equal(
      (await someone.call(`/api/uploads/${theirs.id}`, { method: 'DELETE' })).status,
      204,
    );
  });

  test('an editor changes the uploads from the library’s own page only', async () => {
    publishLibrary();
    const { call, upload } = await caller();
    const made = await read<Answer>(await upload(newDesign(), { picture: webp(800, 800) }));
    await refused(
      await call(`/api/uploads/${made.id}`, {
        method: 'DELETE',
        headers: { Origin: 'https://elsewhere.example' },
      }),
      403,
      'another-site',
    );
    assert.equal((await call(`/api/uploads/${made.id}`)).status, 200);
  });

  test('a program uploads by its key, and is recorded by its name', async () => {
    publishLibrary();
    const studio = await caller({ key: KEY });
    const response = await studio.upload(newDesign(), { picture: webp(800, 800) });
    assert.equal(response.status, 201);
    const made = await read<Answer>(response);
    assert.equal(made.history[0]!.by.id, 'key:studio');
    // A program uploads and publishes; a person reviews, on the library's page.
    const accept = await studio.send(`/api/uploads/${made.id}/status`, 'POST', {
      status: 'rejected',
    });
    await refused(accept, 403, 'token-scope');
    const wrong = await caller({ key: 'not-the-key-of-anything-at-all-0000' });
    await refused(await wrong.call('/api/uploads'), 401, 'bad-key');
    const none = await caller({ key: KEY });
    const keyless = await worker.fetch(
      new Request(`${SITE}/api/uploads`, { headers: { Authorization: 'Basic abc' } }),
      none.env,
    );
    await refused(keyless, 401, 'bad-key');
  });
});

describe('the server', () => {
  test('keeps no uploads without its bucket', async () => {
    const { env } = await caller({ key: KEY });
    const request = new Request(`${SITE}/api/uploads`, {
      headers: { Authorization: `Bearer ${KEY}` },
    });
    const response = await worker.fetch(request, { ...env, UPLOADS: undefined });
    assert.equal(response.status, 503);
    assert.equal((await read<Problem>(response)).error, 'not-set-up');
  });

  test('checks nothing when the library cannot be read', async () => {
    forgetLibrary();
    mock.method(globalThis, 'fetch', () => Promise.resolve(new Response('', { status: 500 })));
    const { upload } = await caller();
    const response = await upload(newDesign(), { picture: webp(800, 800) });
    assert.equal(response.status, 503);
    assert.equal((await read<Problem>(response)).error, 'library-unreachable');
  });

  test('answers its paths, over HTTPS, and leaves the rest to the page', async () => {
    const { call, env } = await caller();
    assert.equal(await (await call('/designs')).text(), 'the page');
    assert.equal((await call('/api/nothing')).status, 404);
    assert.equal((await call('/api/uploads/u-nothing')).status, 404);
    const wrong = await call('/api/content', { method: 'DELETE' });
    assert.equal(wrong.status, 405);
    assert.equal(wrong.headers.get('Allow'), 'GET');
    const plain = await worker.fetch(new Request('http://library.example/api/content'), env);
    assert.equal(plain.status, 308);
    assert.equal(plain.headers.get('Location'), 'https://library.example/api/content');
    const here = await worker.fetch(new Request('http://127.0.0.1:5176/api/content'), env);
    assert.equal(here.status, 200);
  });
});
