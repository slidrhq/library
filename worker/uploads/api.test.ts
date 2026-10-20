import assert from 'node:assert/strict';
import { afterEach, describe, mock, test } from 'node:test';
import type { ContentLanguage } from '@slidr/model';
import worker from '../index.ts';
import { forgetLibrary } from './library.ts';
import {
  ALL_LANGUAGES,
  PICTURE,
  SITE,
  caller,
  designLanguages,
  designSlide,
  frenchSample,
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
  files: Record<
    string,
    { path: string; sha256: string; width: number; height: number; url: string }
  >;
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
    const { call } = caller();
    const response = await call('/api/content');
    assert.equal(response.status, 200);
    const content = await read<{
      languages: { code: string; base: boolean; dir: string }[];
      types: {
        type: string;
        uploads: boolean;
        closed?: string;
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
      'art',
      'icons',
      'fonts',
    ]);
    assert.deepEqual(Object.keys(byType.designs!.actions), ['add', 'translate']);
    assert.deepEqual(Object.keys(byType.templates!.actions), ['translate']);
    assert.equal(byType.fonts!.uploads, false);
    assert.match(byType.fonts!.closed!, /gen-builtin-fonts/);
  });

  test('describes itself as OpenAPI, with the model’s schema of a slide', async () => {
    const { call } = caller();
    const api = await read<{
      openapi: string;
      paths: Record<string, unknown>;
      components: { schemas: { UploadRequest: { oneOf: { title: string }[] } } };
    }>(await call('/api/openapi.json'));
    assert.equal(api.openapi, '3.1.0');
    assert.ok(api.paths['/api/uploads/{id}/languages/{lang}']);
    assert.deepEqual(
      api.components.schemas.UploadRequest.oneOf.map((one) => one.title),
      ['designs: add', 'designs: translate', 'templates: translate'],
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
    const { bucket, call, upload } = caller();
    const response = await upload(newDesign(), { picture: webp(1008, 1496) });
    assert.equal(response.status, 201);
    const made = await read<Answer>(response);
    assert.equal(response.headers.get('Location'), `/api/uploads/${made.id}`);
    assert.equal(made.status, 'pending');
    assert.equal(made.target, 'm-harbour-launch');
    assert.deepEqual(Object.keys(made.languages), ['he', 'en']);
    assert.deepEqual(made.missing, ALL_LANGUAGES.slice(2));
    assert.equal(made.files.picture!.path, 'images/designs/m-harbour-launch.webp');
    assert.deepEqual([made.files.picture!.width, made.files.picture!.height], [1008, 1496]);
    assert.equal(made.history[0]!.by.id, 'anyone');
    assert.ok(bucket.objects.has(`uploads/${made.id}.json`));

    const picture = await call(made.files.picture!.url);
    assert.equal(picture.headers.get('Content-Type'), 'image/webp');
    assert.deepEqual(new Uint8Array(await picture.arrayBuffer()), webp(1008, 1496));
    assert.equal((await read<Answer>(await call(`/api/uploads/${made.id}`))).id, made.id);
  });

  test('is refused under an id the library has', async () => {
    publishLibrary(['images/designs/m-harbour-launch.webp']);
    const { upload } = caller();
    const issues = await issuesOf(await upload(newDesign(), { picture: webp(800, 800) }));
    assert.deepEqual(
      issues.map((one) => one.path),
      ['id'],
    );
    assert.match(issues[0]!.message, /has a design m-harbour-launch already/);
  });

  test('says each thing wrong with it, at its place', async () => {
    publishLibrary();
    const { upload } = caller();
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
    const { upload } = caller();
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
    const { upload } = caller();
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
    const { upload } = caller();
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
    const { upload } = caller();
    assert.equal((await upload(newDesign(), { picture: webp(800, 800) })).status, 201);
    const issues = await issuesOf(await upload(newDesign(), { picture: webp(800, 800) }));
    assert.match(issues[0]!.message, /adds m-harbour-launch too/);
  });
});

describe('a part the library takes no uploads of', () => {
  test('is refused, saying why', async () => {
    const { send } = caller();
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
    const api = caller();
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
    const { send } = caller();
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
    const { send } = caller();
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
    const { bucket, call, send, upload } = caller();
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
    assert.equal(bucket.objects.size, 0);
  });

  test('is published only once accepted, and an accepted upload stays', async () => {
    publishLibrary(['images/designs/m-techmeetup.webp']);
    const { call, send } = caller();
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
  });
});

describe('the list of uploads', () => {
  test('is newest first, by type, status and language, a page at a time', async () => {
    publishLibrary(['images/designs/m-techmeetup.webp']);
    const { call, send, upload } = caller();
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

describe('the server', () => {
  test('keeps no uploads without its bucket', async () => {
    const { env } = caller();
    const response = await worker.fetch(new Request(`${SITE}/api/uploads`), {
      ...env,
      UPLOADS: undefined,
    });
    assert.equal(response.status, 503);
    assert.equal((await read<Problem>(response)).error, 'not-set-up');
  });

  test('checks nothing when the library cannot be read', async () => {
    forgetLibrary();
    mock.method(globalThis, 'fetch', () => Promise.resolve(new Response('', { status: 500 })));
    const { upload } = caller();
    const response = await upload(newDesign(), { picture: webp(800, 800) });
    assert.equal(response.status, 503);
    assert.equal((await read<Problem>(response)).error, 'library-unreachable');
  });

  test('answers its paths, over HTTPS, and leaves the rest to the page', async () => {
    const { call, env } = caller();
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
