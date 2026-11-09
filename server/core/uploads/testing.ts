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
import worker, { type Env } from '../../host/cloudflare/index.ts';
import { forgetLibrary } from './library.ts';
import type { Bucket, BucketObject, HttpMetadata } from '../bucket.ts';

export const SITE = 'https://library.example';
export const MEDIA = 'https://media.example/';

/** A bucket of R2, in memory, as far as the Worker uses one. */
export class MemoryBucket implements Bucket {
  readonly objects = new Map<
    string,
    { data: Uint8Array; etag: string; http: HttpMetadata; meta?: Record<string, string> }
  >();
  private written = 0;

  get(key: string): Promise<BucketObject | null> {
    const held = this.objects.get(key);
    if (!held) return Promise.resolve(null);
    const { data, etag, http, meta } = held;
    return Promise.resolve({
      etag,
      size: data.length,
      body: new Blob([data as Uint8Array<ArrayBuffer>]).stream(),
      httpMetadata: { ...http },
      customMetadata: meta,
      text: () => Promise.resolve(new TextDecoder().decode(data)),
      arrayBuffer: () => Promise.resolve(data.slice().buffer),
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
      http: { ...options.httpMetadata },
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
    const include = options.include ?? [];
    return Promise.resolve({
      objects: page.map((key) => {
        const { http, meta } = this.objects.get(key)!;
        return {
          key,
          ...(include.includes('httpMetadata') ? { httpMetadata: { ...http } } : {}),
          ...(include.includes('customMetadata') ? { customMetadata: meta } : {}),
        };
      }),
      truncated: keys.length > limit,
    });
  }
}

/**
 * A store that goes away when `fails` says so, for the write it counts (puts and deletes alike,
 * from 1), as a store lost part-way through a publication; reading always works.
 */
export function failing(bucket: Bucket, fails: (write: number) => boolean = () => false) {
  const control = { fails, writes: 0 };
  const write = <T>(work: () => Promise<T>) => {
    control.writes += 1;
    return control.fails(control.writes)
      ? Promise.reject(new Error('The store went away.'))
      : work();
  };
  const store: Bucket = {
    get: (key) => bucket.get(key),
    list: (options) => bucket.list(options),
    put: (key, value, options) => write(() => bucket.put(key, value, options)),
    delete: (keys) => write(() => bucket.delete(keys)),
  };
  return { store, control };
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

/** A design's content in a language: its slide, and in Hebrew and English its names and tags. */
export interface DesignLanguage {
  slide: Slide;
  name?: string;
  groupName?: string;
  tags?: string[];
}

/** The search tags of a design of a launch night, in Hebrew and in English. */
export const DESIGN_TAGS = {
  he: ['ערב השקה', 'השקה', 'אירוע', 'הזמנה', 'נמל'],
  en: ['launch night', 'launch', 'event', 'invitation', 'harbour'],
};

/** The content of a new design in each language: names and tags in Hebrew and English. */
export function designLanguages(
  languages: readonly ContentLanguage[] = ['he', 'en'],
): Record<string, DesignLanguage> {
  return Object.fromEntries(
    languages.map((lang) => [
      lang,
      lang === 'he'
        ? { name: 'ערב השקה', groupName: 'אירועים', tags: DESIGN_TAGS.he, slide: designSlide(lang) }
        : lang === 'en'
          ? {
              name: 'Launch night',
              groupName: 'Events',
              tags: DESIGN_TAGS.en,
              slide: designSlide(lang),
            }
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

/** The catalogs of the parts that are tagged, a few items each, by their paths in the library. */
export const CATALOGS: Record<string, unknown> = {
  'elements/catalogs/graphics-catalog.json': [
    { id: 'glossy', icons: ['fluent-emoji:balloon', 'fluent-emoji:wrapped-gift'] },
    { id: 'outlined', icons: ['streamline-emojis:balloon'] },
  ],
  'elements/catalogs/emoji-catalog.json': [
    { id: 'food', emoji: ['birthday-cake|🎂|birthday cake|cake|עוגת יום הולדת|עוגה'] },
  ],
  'elements/catalogs/shapes.json': { shapes: { rect: {} }, lines: { arrow: 'M4 12H20' } },
  'icons/lucide/tags.json': { cake: ['birthday'] },
  'icons/tabler/icons.json': { balloon: { tags: ['party'] } },
};

/* ---------------------------------------------------------------- backgrounds and animations */

export const BACKGROUNDS = 'elements/backgrounds/catalog.json';
export const ANIMATIONS = 'elements/animations/catalog.json';

/**
 * The catalogs of the backgrounds and of the animations, an item or two of each list as the app
 * drew them before they were the library's: a still background, a picture that moves, a line that
 * boxes run along, an animated shape, and one that points the way a line runs.
 */
export const MOTION: Record<string, unknown> = {
  [BACKGROUNDS]: {
    version: 1,
    backgrounds: [
      {
        id: 'dots',
        name: {
          he: 'רשת נקודות',
          en: 'Dot grid',
          ar: 'شبكة نقاط',
          de: 'Punktraster',
          es: 'Cuadrícula de puntos',
          fr: 'Grille de points',
          it: 'Griglia di punti',
          'pt-BR': 'Grade de pontos',
          ru: 'Сетка точек',
          tr: 'Nokta ızgarası',
          vi: 'Lưới chấm',
          id: 'Kisi titik',
          hi: 'बिंदुओं का ग्रिड',
          ja: 'ドットグリッド',
          ko: '점 격자',
          'zh-CN': '点阵',
        },
        animated: false,
        sided: true,
        markup:
          '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1920 1080"><defs><pattern id="d" width="30" height="30" patternUnits="userSpaceOnUse"><circle cx="15" cy="15" r="1.6" fill="#15213f" fill-opacity=".16"/></pattern><radialGradient id="v" cx=".5" cy=".5" r=".72"><stop offset=".5" stop-opacity="1"/><stop offset="1" stop-opacity=".35"/></radialGradient><radialGradient id="l"><stop offset="0" stop-color="#6c4cf1" stop-opacity=".2"/><stop offset="1" stop-color="#6c4cf1" stop-opacity="0"/></radialGradient><mask id="m" mask-type="alpha" style="mask-type:alpha" maskUnits="userSpaceOnUse" x="0" y="0" width="1920" height="1080"><rect width="1920" height="1080" fill="url(#v)"/></mask></defs><circle cx="576" cy="561.6" r="760" fill="url(#l)"/><rect width="1920" height="1080" fill="url(#d)" mask="url(#m)"/></svg>',
      },
    ],
  },
  [ANIMATIONS]: {
    version: 1,
    animations: [
      {
        id: 'shuttle',
        name: {
          he: 'נקודה על קו',
          en: 'Dot on a line',
          ar: 'نقطة على خط',
          de: 'Punkt auf einer Linie',
          es: 'Punto en una línea',
          fr: 'Point sur une ligne',
          it: 'Punto su una linea',
          'pt-BR': 'Ponto em uma linha',
          ru: 'Точка на линии',
          tr: 'Çizgi üzerinde nokta',
          vi: 'Chấm trên đường thẳng',
          id: 'Titik di garis',
          hi: 'रेखा पर बिंदु',
          ja: '線上の点',
          ko: '선 위의 점',
          'zh-CN': '线上的点',
        },
        group: 'path',
        size: { w: 560, h: 140 },
        reads: true,
        markup:
          '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 560 140"><style>.k{animation:glide 2.8s cubic-bezier(.65,0,.35,1) infinite alternate}.p{animation:fill 2.8s cubic-bezier(.65,0,.35,1) infinite alternate}@keyframes glide{from{transform:translateX(0)}to{transform:translateX(460px)}}@keyframes fill{from{stroke-dashoffset:100}to{stroke-dashoffset:0}}</style><path d="M50 70H510" stroke="#15213f" stroke-opacity=".14" stroke-width="12" stroke-linecap="round"/><path class="p" d="M50 70H510" pathLength="100" stroke="#6c4cf1" stroke-width="12" stroke-linecap="round" stroke-dasharray="100 100" stroke-dashoffset="100"/><g class="k"><circle cx="50" cy="70" r="40" fill="#6c4cf1" fill-opacity=".15"/><circle cx="50" cy="70" r="24" fill="#6c4cf1" stroke="#fbf6ec" stroke-width="6"/></g></svg>',
      },
      {
        id: 'conveyor',
        name: {
          he: 'קופסאות במסלול',
          en: 'Boxes on a path',
          ar: 'صناديق على مسار',
          de: 'Boxen auf einer Bahn',
          es: 'Cajas en un recorrido',
          fr: 'Boîtes sur un parcours',
          it: 'Scatole su un percorso',
          'pt-BR': 'Caixas em um caminho',
          ru: 'Коробки на пути',
          tr: 'Yoldaki kutular',
          vi: 'Hộp trên đường đi',
          id: 'Kotak di lintasan',
          hi: 'पथ पर डिब्बे',
          ja: '経路を進む箱',
          ko: '경로 위의 상자',
          'zh-CN': '路径上的方块',
        },
        group: 'path',
        size: { w: 380, h: 160 },
        reads: true,
        line: {
          points: [
            { x: 0, y: 160 },
            { x: 380, y: 0 },
          ],
          stroke: { color: { token: 'secondary' }, width: 3.5, dash: 'dashed', cap: 'round' },
          startHead: 'none',
          endHead: 'none',
          curve: 'curved',
          flow: { speed: 90, rider: 'box', count: 4, color: { token: 'text' } },
        },
      },
    ],
    shapes: [
      {
        id: 'ring',
        name: {
          he: 'טבעת מסתובבת',
          en: 'Turning ring',
          ar: 'حلقة تدور',
          de: 'Drehender Ring',
          es: 'Anillo que gira',
          fr: 'Anneau qui tourne',
          it: 'Anello che ruota',
          'pt-BR': 'Anel girando',
          ru: 'Вращающееся кольцо',
          tr: 'Dönen halka',
          vi: 'Vòng xoay',
          id: 'Cincin berputar',
          hi: 'घूमती अंगूठी',
          ja: '回転するリング',
          ko: '회전하는 고리',
          'zh-CN': '旋转的圆环',
        },
        preset: 'ellipse',
        side: 260,
        look: 'dashed',
        ink: 'primary',
        ambient: { kind: 'spin', duration: 8000 },
      },
      {
        id: 'arrow',
        name: {
          he: 'חץ מתנדנד',
          en: 'Wiggling arrow',
          ar: 'سهم يتمايل',
          de: 'Wackelnder Pfeil',
          es: 'Flecha que se balancea',
          fr: 'Flèche qui oscille',
          it: 'Freccia che oscilla',
          'pt-BR': 'Seta balançando',
          ru: 'Покачивающаяся стрелка',
          tr: 'Sallanan ok',
          vi: 'Mũi tên lắc lư',
          id: 'Panah bergoyang',
          hi: 'हिलता तीर',
          ja: '揺れる矢印',
          ko: '흔들리는 화살표',
          'zh-CN': '摇摆的箭头',
        },
        preset: 'arrowRight',
        side: 260,
        look: 'fill',
        ink: 'primary',
        ambient: { kind: 'swing', duration: 2400, rhythm: 'pause', amount: 10 },
        reads: true,
      },
    ],
  },
};

/** The name of a comet in every language of the app: what the new items below are named. */
export const COMET: Record<ContentLanguage, string> = {
  he: 'שביט',
  en: 'Comet',
  ar: 'مذنب',
  de: 'Komet',
  es: 'Cometa',
  fr: 'Comète',
  it: 'Cometa',
  'pt-BR': 'Cometa',
  ru: 'Комета',
  tr: 'Kuyruklu yıldız',
  vi: 'Sao chổi',
  id: 'Komet',
  hi: 'धूमकेतु',
  ja: '彗星',
  ko: '혜성',
  'zh-CN': '彗星',
};

/** The content of a new background or animation in each language: its name. */
export const motionLanguages = (languages: readonly ContentLanguage[] = ['he', 'en']) =>
  Object.fromEntries(languages.map((lang) => [lang, { name: COMET[lang] }]));

/** A picture that moves by itself: a dot turning about the middle, in the theme's primary colour. */
export const motionPicture = (w = 400, h = 400) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}"><style>.t{animation:t 6s linear infinite;transform-origin:${w / 2}px ${h / 2}px}@keyframes t{to{transform:rotate(360deg)}}</style><circle class="t" cx="${w / 2}" cy="${h / 4}" r="24" fill="#6c4cf1"/></svg>`;

/** Uploads of a new background, and of an animation of each kind, named a comet. */
export const NEW_MOTION = {
  background: {
    type: 'backgrounds',
    action: 'add',
    id: 'aurora',
    animated: true,
    sided: false,
    markup: motionPicture(1920, 1080),
  },
  picture: {
    type: 'animations',
    action: 'add',
    id: 'comet',
    kind: 'picture',
    group: 'spin',
    size: { w: 400, h: 400 },
    reads: false,
    markup: motionPicture(),
  },
  line: {
    type: 'animations',
    action: 'add',
    id: 'comet-trail',
    kind: 'line',
    group: 'lines',
    size: { w: 430, h: 80 },
    reads: true,
    line: {
      points: [
        { x: 0, y: 80 },
        { x: 220, y: 0 },
        { x: 430, y: 50 },
      ],
      stroke: { color: { token: 'secondary' }, width: 6, dash: 'dashed', cap: 'round' },
      startHead: 'circle',
      endHead: 'triangle',
      curve: 'curved',
      flow: { speed: 40 },
    },
  },
  shape: {
    type: 'animations',
    action: 'add',
    id: 'comet',
    kind: 'shape',
    shape: {
      preset: 'star6',
      side: 220,
      look: 'fill',
      ink: 'accent',
      ambient: { kind: 'pulse', duration: 1400, rhythm: 'pause', amount: 0.16 },
    },
  },
} as const;

/**
 * Serves a published library of these files, and the paths named besides, from the site of
 * `MEDIA`, until the test ends.
 */
export function publishLibrary(also: readonly string[] = [], more: Record<string, unknown> = {}) {
  forgetLibrary();
  const files: Record<string, unknown> = {
    'fonts/catalog.json': FONTS,
    'templates/harbour/template.json': TEMPLATE,
    'templates/pictures.json': { harbourPier: PICTURE },
    ...more,
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

/** The Worker's settings of signing in, and the people it names. */
const CLIENT = 'client-1.apps.googleusercontent.com';
export const EDITOR = 'editor@example.com';
const SIGN_IN = {
  GOOGLE_CLIENT_ID: CLIENT,
  GOOGLE_CLIENT_SECRET: 'client-secret',
  SESSION_SECRET: 'a-session-secret-of-at-least-32-characters',
  LIBRARY_EDITORS: `${EDITOR}, other-editor@example.com`,
};

const base64url = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');

/**
 * The cookie of a session, signed in all the way through the Worker's own routes, with Google's
 * token endpoint standing in for Google.
 */
async function sessionAs(email: string, env: object): Promise<string> {
  const login = await worker.fetch(
    new Request(`${SITE}/auth/login`, { redirect: 'manual' }),
    env as never,
  );
  const google = new URL(login.headers.get('Location')!);
  const pending = login.headers
    .getSetCookie()
    .find((one) => one.startsWith('__Host-library-signin='));
  const claims = {
    iss: 'https://accounts.google.com',
    aud: CLIENT,
    exp: Math.floor(Date.now() / 1000) + 3600,
    nonce: google.searchParams.get('nonce'),
    sub: `sub-${email}`,
    email,
    email_verified: true,
    name: email.split('@')[0],
  };
  const token = [base64url({ alg: 'RS256' }), base64url(claims), 'signature'].join('.');
  const answer = mock.method(globalThis, 'fetch', () =>
    Promise.resolve(Response.json({ id_token: token })),
  );
  const back = await worker.fetch(
    new Request(`${SITE}/auth/callback?state=${google.searchParams.get('state')}&code=a-code`, {
      headers: { Cookie: pending!.split(';')[0]! },
      redirect: 'manual',
    }),
    env as never,
  );
  answer.mock.restore();
  const session = back.headers
    .getSetCookie()
    .find((one) => one.startsWith('__Host-library-session='));
  if (!session) throw new Error(`${email} was not signed in`);
  return session.split(';')[0]!;
}

/**
 * Calls the Worker as someone: an editor signed in on the library's page (by default), another
 * account, a program by its key, or no one; with a bucket of its own for each test (`env`).
 */
export async function caller<B extends Bucket = MemoryBucket>(
  /** Signed in as `email` (the editor's by default), sending `bearer` alone, or as nobody. */
  as: { email?: string; bearer?: string; nobody?: boolean } = {},
  bucket: B = new MemoryBucket() as Bucket as B,
  /** More of the Worker's settings, or others. */
  more: Partial<Env> = {},
) {
  const env = {
    ...SIGN_IN,
    UPLOADS: bucket,
    MEDIA_LIBRARY_URL: MEDIA,
    ASSETS: { fetch: () => Promise.resolve(new Response('the page')) },
    ...more,
  };
  const headers: Record<string, string> = {};
  if (as.bearer) headers.Authorization = `Bearer ${as.bearer}`;
  else if (!as.nobody) {
    headers.Cookie = await sessionAs(as.email ?? EDITOR, env);
    // The page's own requests say where they come from.
    headers.Origin = SITE;
  }
  const call = (path: string, init: RequestInit = {}) => {
    const all = new Headers(init.headers);
    for (const [name, value] of Object.entries(headers)) if (!all.has(name)) all.set(name, value);
    return worker.fetch(new Request(SITE + path, { ...init, headers: all }), env);
  };
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
