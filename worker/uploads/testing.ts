/**
 * What the tests of the uploads stand on: a bucket in memory, a published library of a few
 * files, and the content of uploads, drawn with the model's own factories.
 */
import { mock } from 'node:test';
import {
  CONTENT_LANGUAGES,
  LANGUAGE_SCRIPT,
  createBaseTheme,
  createElement,
  createSlide,
  languageDir,
  richText,
  type ContentLanguage,
  type Slide,
} from '@slidr/model';
import type { Template } from '@slidr/templates';
import worker from '../index.ts';
import { forgetLibrary } from './library.ts';
import type { Bucket, BucketObject } from './store.ts';

export const SITE = 'https://library.example';
export const MEDIA = 'https://media.example/';

/** A bucket of R2, in memory, as far as the Worker uses one. */
export class MemoryBucket implements Bucket {
  readonly objects = new Map<
    string,
    { data: Uint8Array; etag: string; contentType?: string; meta?: Record<string, string> }
  >();
  private written = 0;

  get(key: string): Promise<BucketObject | null> {
    const held = this.objects.get(key);
    if (!held) return Promise.resolve(null);
    const { data, etag, contentType } = held;
    return Promise.resolve({
      etag,
      size: data.length,
      body: new Blob([data as Uint8Array<ArrayBuffer>]).stream(),
      httpMetadata: { contentType },
      text: () => Promise.resolve(new TextDecoder().decode(data)),
    });
  }

  put(
    key: string,
    value: string | ArrayBuffer | Uint8Array,
    options: Parameters<Bucket['put']>[2] = {},
  ): Promise<{ etag: string } | null> {
    const held = this.objects.get(key);
    const wanted = options.onlyIf?.etagMatches;
    if (wanted !== undefined && held?.etag !== wanted) return Promise.resolve(null);
    const data =
      typeof value === 'string'
        ? new TextEncoder().encode(value)
        : value instanceof Uint8Array
          ? value
          : new Uint8Array(value);
    const etag = `e${(this.written += 1)}`;
    this.objects.set(key, {
      data,
      etag,
      contentType: options.httpMetadata?.contentType,
      meta: options.customMetadata,
    });
    return Promise.resolve({ etag });
  }

  delete(keys: string | string[]): Promise<void> {
    for (const key of Array.isArray(keys) ? keys : [keys]) this.objects.delete(key);
    return Promise.resolve();
  }

  list(options: Parameters<Bucket['list']>[0] = {}) {
    const limit = options.limit ?? 1000;
    const keys = [...this.objects.keys()]
      .filter((key) => key.startsWith(options.prefix ?? ''))
      .filter((key) => !options.startAfter || key > options.startAfter)
      .sort();
    const page = keys.slice(0, limit);
    return Promise.resolve({
      objects: page.map((key) => ({ key, customMetadata: this.objects.get(key)!.meta })),
      truncated: keys.length > limit,
    });
  }
}

/** A WebP picture's first bytes, as far as its size is read from them (an extended one). */
export function webp(width: number, height: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(30);
  const view = new DataView(bytes.buffer);
  bytes.set(new TextEncoder().encode('RIFF'), 0);
  view.setUint32(4, 22, true);
  bytes.set(new TextEncoder().encode('WEBPVP8X'), 8);
  view.setUint32(16, 10, true);
  const u24 = (at: number, value: number) => {
    view.setUint16(at, value & 0xffff, true);
    view.setUint8(at + 2, value >> 16);
  };
  u24(24, width - 1);
  u24(27, height - 1);
  return bytes;
}

/** The family of the fonts below that each script's text is set in. */
const FAMILY_OF: Record<string, string> = {
  he: 'Heebo',
  latin: 'Inter',
  cyrillic: 'Inter',
  vietnamese: 'Inter',
  arabic: 'Amiri',
  devanagari: 'Noto Sans Devanagari',
  japanese: 'Noto Sans JP',
  korean: 'Noto Sans KR',
  chinese: 'Noto Sans SC',
};

const OWN = ['he', 'arabic', 'devanagari', 'japanese', 'korean', 'chinese'];
const counterparts = (has: readonly string[]) =>
  Object.fromEntries(
    Object.entries(FAMILY_OF).filter(([script]) => !has.includes(script)),
  ) as Record<string, string>;

const family = (name: string, scripts: string[], made: string[]) => ({
  family: name,
  scripts,
  for: made,
  counterparts: counterparts(scripts),
});

/** `fonts/catalog.json`: a family for each script, and a Latin serif with counterparts. */
export const FONTS = {
  families: [
    family('Heebo', ['he', 'latin'], ['he']),
    family('Inter', ['latin', 'cyrillic', 'vietnamese'], ['latin']),
    {
      ...family('Playfair Display', ['latin', 'cyrillic', 'vietnamese'], ['latin']),
      counterparts: {
        ...counterparts(['latin', 'cyrillic', 'vietnamese']),
        he: 'Frank Ruhl Libre',
      },
    },
    family('Frank Ruhl Libre', ['he', 'latin'], ['he']),
    ...OWN.filter((script) => script !== 'he').map((script) =>
      family(FAMILY_OF[script]!, [script, 'latin'], [script]),
    ),
  ],
  faces: [] as { family: string; style: string; weight: string }[],
};
FONTS.faces = FONTS.families.map(({ family: name }) => ({
  family: name,
  style: 'normal',
  weight: '400',
}));

/** The words of a design: its title, its line under the title, and its call. */
const WORDS: Partial<Record<ContentLanguage, [string, string, string]>> = {
  he: ['ערב השקה בנמל', 'הדלתות נפתחות בשבע, ברציף ארבע', 'שריינו מקום'],
  en: ['Launch night at the harbour', 'Doors open at seven on pier four', 'Save a seat'],
  fr: ['Soirée de lancement au port', 'Ouverture des portes à 19 h, quai 4', 'Réservez'],
  ar: ['ليلة الإطلاق في الميناء', 'تفتح الأبواب في السابعة على الرصيف الرابع', 'احجز مقعدك'],
  ja: ['港でのローンチナイト', '午後7時、第4埠頭で開場します', '席を予約'],
};

export const fontOf = (lang: ContentLanguage) => FAMILY_OF[LANGUAGE_SCRIPT[lang]]!;

/** A design's slide in a language, its picture named `__subject__`, every text in `font`. */
export function designSlide(
  lang: ContentLanguage,
  font = fontOf(lang),
  words = WORDS[lang],
): Slide {
  const [title, line, call] = words ?? WORDS.en!;
  const dir = languageDir(lang);
  const text = (content: string, y: number) =>
    createElement.text({
      frame: { x: 120, y, w: 900, h: 140 },
      content: richText(content, { dir, marks: { font } }),
    });
  return createSlide({
    elements: [
      createElement.image({ frame: { x: 1100, y: 0, w: 820, h: 1080 }, assetId: '__subject__' }),
      text(title, 200),
      text(line, 400),
      text(call, 640),
    ],
  });
}

/** A design's content in a language: its slide, and in Hebrew and English its names. */
export interface DesignLanguage {
  slide: Slide;
  name?: string;
  groupName?: string;
}

/** The content of a new design in each language: names in Hebrew and English. */
export function designLanguages(
  languages: readonly ContentLanguage[] = ['he', 'en'],
): Record<string, DesignLanguage> {
  return Object.fromEntries(
    languages.map((lang) => [
      lang,
      lang === 'he'
        ? { name: 'ערב השקה', groupName: 'אירועים', slide: designSlide(lang) }
        : lang === 'en'
          ? { name: 'Launch night', groupName: 'Events', slide: designSlide(lang) }
          : { slide: designSlide(lang) },
    ]),
  );
}

export const ALL_LANGUAGES = CONTENT_LANGUAGES;

/** A built-in template of two layouts. */
export const TEMPLATE: Template = {
  theme: { ...createBaseTheme(), id: 'harbour', name: 'Harbour' },
  dir: 'rtl',
  layouts: [
    {
      id: 'l_harbour_hero',
      name: 'Opening',
      archetype: 'hero',
      placeholders: [
        {
          id: 'p_title',
          role: 'title',
          frame: { x: 120, y: 360, w: 1680, h: 200 },
          styleRef: 'title',
        },
        {
          id: 'p_subtitle',
          role: 'subtitle',
          frame: { x: 120, y: 600, w: 1680, h: 120 },
          styleRef: 'body',
        },
      ],
      decorations: [],
    },
    {
      id: 'l_harbour_picture',
      name: 'Text and picture',
      archetype: 'textImage',
      placeholders: [
        {
          id: 'p_title',
          role: 'title',
          frame: { x: 120, y: 120, w: 800, h: 160 },
          styleRef: 'title',
        },
        { id: 'p_body', role: 'body', frame: { x: 120, y: 320, w: 800, h: 600 }, styleRef: 'body' },
        { id: 'p_image', role: 'image', frame: { x: 1000, y: 0, w: 920, h: 1080 } },
      ],
      decorations: [],
    },
  ],
};

/** The picture of the template's sample, as `templates/pictures.json` records it. */
export const PICTURE = {
  id: 'a'.repeat(64),
  file: `${'a'.repeat(64)}.webp`,
  mime: 'image/webp',
  kind: 'image',
  bytes: 30,
  width: 1200,
  height: 1400,
  origin: 'ai',
  name: 'harbour-pier.webp',
};

/** A sample of the template in French. */
export function frenchSample() {
  const text = (words: string) => richText(words);
  return [
    {
      layout: 'l_harbour_hero',
      name: 'Ouverture',
      content: { title: text('Le port, la nuit du lancement'), subtitle: text('Quai 4 · 19 h') },
    },
    {
      layout: 'l_harbour_picture',
      name: 'Le quai',
      content: {
        title: text('Un quai pour tous'),
        body: text('Trois scènes, deux cuisines de rue et une vue sur toute la baie.'),
        image: { assetId: PICTURE.id },
      },
    },
  ];
}

/**
 * Serves a published library of these files, and the paths named besides, from the site of
 * `MEDIA`, until the test ends.
 */
export function publishLibrary(also: readonly string[] = []) {
  forgetLibrary();
  const files: Record<string, unknown> = {
    'fonts/catalog.json': FONTS,
    'templates/harbour/template.json': TEMPLATE,
    'templates/pictures.json': { harbourPier: PICTURE },
  };
  const manifest = {
    version: 1,
    files: Object.fromEntries(
      [...Object.keys(files), ...also].map((path) => [path, { size: 1, sha256: '0' }]),
    ),
  };
  return mock.method(globalThis, 'fetch', (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    const path = url.startsWith(MEDIA) ? decodeURI(url.slice(MEDIA.length)) : undefined;
    const body = path === 'manifest.json' ? manifest : path ? files[path] : undefined;
    return Promise.resolve(
      body === undefined ? new Response('', { status: 404 }) : Response.json(body),
    );
  });
}

/** Calls the Worker, with a bucket of its own for each test (`env`). */
export function caller(bucket = new MemoryBucket()) {
  const env = {
    UPLOADS: bucket,
    MEDIA_LIBRARY_URL: MEDIA,
    ASSETS: { fetch: () => Promise.resolve(new Response('the page')) },
  };
  const call = (path: string, init: RequestInit = {}) =>
    worker.fetch(new Request(SITE + path, init), env);
  const send = (path: string, method: string, body: unknown) =>
    call(path, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  /** Uploads as a form: the upload as JSON, and its files. */
  const upload = (body: unknown, files: Record<string, Uint8Array<ArrayBuffer>> = {}) => {
    const form = new FormData();
    form.set('upload', JSON.stringify(body));
    for (const [name, bytes] of Object.entries(files)) form.set(name, new Blob([bytes]), name);
    return call('/api/uploads', { method: 'POST', body: form });
  };
  return { bucket, env, call, send, upload };
}
