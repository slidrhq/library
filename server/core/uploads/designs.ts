/**
 * Designs: the ready-made slides of Elements. An uploaded design joins those Slidr Studio makes,
 * in `elements/designs/managed.json`, which publishing merges and never writes over, with its
 * picture in `images/designs/` (docs/media-library.md of the app, "Designs made by Slidr Studio").
 * So it is named as theirs are, `m-<words>`, and named in Hebrew and English in the catalog itself.
 *
 * Each language holds the whole slide, drawn for that language. A design is uploaded in Hebrew and
 * English, and is accepted when it is written in every language of the app, as the app's tests
 * hold every design to be (`designs.test.ts`). Each slide may come with its picture made ahead, as
 * the galleries show it (`thumb-<language>`), which publishing names by the slide it is of
 * (`../media/designFiles.ts`).
 */
import {
  BASE_LANGUAGES,
  CONTENT_LANGUAGES,
  LANGUAGE_NAMES,
  LANGUAGE_SCRIPT,
  SLIDE_HEIGHT,
  SLIDE_WIDTH,
  Slide,
  plainText,
  walkElements,
  type ContentLanguage,
} from '@slidr/model';
import { familyIn, type FontShelf } from '../../../vendor/desktop/src/elements/designFonts.ts';
import { isRecord } from '../http.ts';
import { REVS, THUMB_HEIGHT, THUMB_WIDTH, thumbPath } from '../media/designFiles.ts';
import {
  Issues,
  PICTURE_BYTES,
  SLUG,
  isText,
  languagesToCheck,
  placeholderIn,
  quote,
  unknownKeys,
  wordedOf,
  type Draft,
  type FileRule,
  type Handler,
} from './handler.ts';
import type { Library } from './library.ts';
import { TAGS_FIELD, checkTags } from './tags.ts';

/** The id of a design made outside the authored catalog. */
const ID = /^m-[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ID_MOST = 64;
const NAME_MOST = 80;

const OTHER_LANGUAGES = CONTENT_LANGUAGES.filter(
  (lang) => !(BASE_LANGUAGES as readonly string[]).includes(lang),
);

const picture: FileRule = {
  name: 'picture',
  about: 'The picture the slide shows, which its images name `__subject__`.',
  required: true,
  types: ['image/webp'],
  maxBytes: PICTURE_BYTES,
  path: (id) => `images/designs/${id}.webp`,
};

const backdrop: FileRule = {
  name: 'backdrop',
  about:
    'A photograph under a cut-out picture, which the slide names `__backdrop__`. Only a design ' +
    'that lays its picture over a photograph has one.',
  required: false,
  types: ['image/webp'],
  maxBytes: PICTURE_BYTES,
  path: (id) => `images/designs/${id}-bg.webp`,
};

/** The most a picture made ahead of a design takes: they are some tens of kilobytes. */
const THUMB_BYTES = 1024 * 1024;

/**
 * The picture of a design's slide in a language that the galleries show, made ahead (ADR-109 and
 * ADR-111 of the app): a design without one is drawn live there, and one with it is shown as it
 * at once. Publishing names it by the slide it is of, so a slide changed since is drawn live again.
 */
const thumb = (lang: ContentLanguage): FileRule => ({
  name: `thumb-${lang}`,
  about:
    `The slide in ${LANGUAGE_NAMES[lang].english} as the galleries show it, ${THUMB_WIDTH} × ` +
    `${THUMB_HEIGHT} pixels, drawn by the app's renderer as a thumbnail (\`ScaledSlide\`). ` +
    'Without it the galleries draw the slide themselves.',
  required: false,
  types: ['image/webp'],
  maxBytes: THUMB_BYTES,
  path: (id) => thumbPath(lang, id),
});

/** The language of a picture made ahead of a design, by the name of its file; none for another. */
export const thumbLanguage = (name: string) =>
  name.startsWith('thumb-') ? name.slice('thumb-'.length) : undefined;

/** The pictures made ahead an upload brings: each of their size. */
function checkThumbs(draft: Draft, issues: Issues) {
  for (const [name, file] of Object.entries(draft.files)) {
    if (!thumbLanguage(name)) continue;
    if (file.width !== THUMB_WIDTH || file.height !== THUMB_HEIGHT) {
      issues.add(
        `files.${name}`,
        `${name} is ${file.width ?? '?'} × ${file.height ?? '?'} pixels: a slide as the galleries show it is ${THUMB_WIDTH} × ${THUMB_HEIGHT}.`,
      );
    }
  }
}

const slideField = {
  name: 'slide',
  type: 'Slide',
  about:
    'The slide in this language, as the model holds it (`/api/schemas/slide.json`). Its images ' +
    'name the picture `__subject__` (and `__backdrop__`); every run of its text names a font of ' +
    "the library that has the language's letters.",
  required: true,
} as const;

/** The pictures the slide of a design may name. */
const subjectAndBackdrop = (withBackdrop: boolean) =>
  withBackdrop ? ['__subject__', '__backdrop__'] : ['__subject__'];

/** The issues of a design's slide in one language. */
function checkSlide(
  lang: ContentLanguage,
  value: unknown,
  context: { backdrop: boolean; shelf: FontShelf },
  issues: Issues,
) {
  const at = `languages.${lang}.slide`;
  const parsed = Slide.safeParse(value);
  if (!parsed.success) {
    issues.addSchema(at, parsed.error, lang);
    return;
  }
  const slide = parsed.data;

  // The picture, and the backdrop where there is one: on the slide itself, and no other.
  const pictures = subjectAndBackdrop(context.backdrop);
  for (const element of walkElements(slide.elements)) {
    const asset = 'assetId' in element ? element.assetId : undefined;
    if (element.type === 'image' && !asset) {
      issues.add(at, `The image ${element.id} shows no picture.`, lang);
    } else if (asset && !pictures.includes(asset)) {
      issues.add(
        at,
        `${element.id} shows ${asset}: a design shows its own picture, named ` +
          `${pictures.join(' or ')}, and no other file.`,
        lang,
      );
    }
  }
  const shown = new Set(
    slide.elements.flatMap((one) => (one.type === 'image' && one.assetId ? [one.assetId] : [])),
  );
  for (const name of pictures.filter((one) => !shown.has(one))) {
    issues.add(at, `No image of the slide shows ${name}.`, lang);
  }

  // Real words, in text boxes and in the shapes that carry them.
  const worded = wordedOf(slide.elements);
  if (worded.length < 3) {
    issues.add(at, 'A design has at least three texts, in text boxes or shapes.', lang);
  }
  const copy = worded.map(({ content }) => plainText(content)).join(' ');
  if (copy.trim().length <= 25) issues.add(at, 'A design says more than 25 characters.', lang);
  const placeholder = placeholderIn(worded.map(({ content }) => content));
  if (placeholder) issues.add(at, `${quote(placeholder)} stands for text never written.`, lang);

  // Each run in a font of the library that has the language's letters (ADR-105): what is wrong is
  // said once for each font, with the first text it sets.
  const script = LANGUAGE_SCRIPT[lang];
  const wrong = new Map<string, { what: string; fix: string; texts: string[] }>();
  const note = (key: string, what: string, fix: string, text: string) => {
    const found = wrong.get(key) ?? { what, fix, texts: [] };
    found.texts.push(text);
    wrong.set(key, found);
  };
  for (const { element, content } of worded) {
    for (const run of content.paragraphs.flatMap((paragraph) => paragraph.runs)) {
      const text = `${quote(run.text)} in ${element.id}`;
      const font = run.marks?.font;
      if (!font) note('', 'names no font', '', text);
      else if (!context.shelf.families.has(font)) {
        note(font, `is set in ${font}, a font the library does not have`, '', text);
      } else {
        const family = familyIn(context.shelf, font, lang, run.text);
        if (family !== font) {
          note(
            font,
            `is set in ${font}, which has no ${script} letters`,
            family
              ? `set it in ${family}, its counterpart`
              : 'and it names no counterpart for them',
            text,
          );
        }
      }
    }
  }
  for (const { what, fix, texts } of wrong.values()) {
    const [first = ''] = texts;
    const message =
      texts.length === 1
        ? `${first} ${what}${fix ? `: ${fix}` : ''}.`
        : `${texts.length} texts, as ${first}, ${what.replace(/^is /, 'are ')}${fix ? `: ${fix.replace(' it ', ' them ')}` : ''}.`;
    issues.add(at, message, lang);
  }
}

/** The issues of each language's content, for the fields a language may hold. */
async function checkLanguages(
  draft: Draft,
  library: Library,
  context: { backdrop: boolean; named: boolean; only?: readonly ContentLanguage[] },
  issues: Issues,
) {
  const checked = languagesToCheck(draft, context.only);
  if (checked.length === 0) return;
  const { named } = context;
  const shelf = await library.fonts();
  for (const [lang, part] of checked) {
    const at = `languages.${lang}`;
    if (!isRecord(part)) {
      issues.add(at, 'The content of a language is an object.', lang);
      continue;
    }
    const base = (BASE_LANGUAGES as readonly string[]).includes(lang);
    const known = named && base ? ['slide', 'name', 'groupName', 'tags'] : ['slide'];
    for (const key of unknownKeys(part, known)) {
      issues.add(
        `${at}.${key}`,
        key === 'name' || key === 'groupName'
          ? `A design is named in Hebrew and English only, not in ${LANGUAGE_NAMES[lang].english}: the app names it so in every language.`
          : key === 'tags'
            ? `A design is tagged in Hebrew and English only, the languages the app's search reads, not in ${LANGUAGE_NAMES[lang].english}.`
            : `A design's content in a language has no field ${key}.`,
        lang,
      );
    }
    if (named && base) {
      if (!isText(part.name, NAME_MOST)) {
        issues.add(`${at}.name`, `The design's name, up to ${NAME_MOST} characters.`, lang);
      }
      if (part.groupName !== undefined && !isText(part.groupName, NAME_MOST)) {
        issues.add(`${at}.groupName`, `The group's name, up to ${NAME_MOST} characters.`, lang);
      }
      // The words the search of Ready slides finds it by, written with it (ADR-108 of the app).
      checkTags(`${at}.tags`, lang, part.tags, issues);
    }
    checkSlide(lang, part.slide, { backdrop: context.backdrop, shelf }, issues);
  }
}

/** `add`: a new design. */
export const addDesign: Handler = {
  type: 'designs',
  action: 'add',
  about:
    'A new ready-made slide. It joins the designs Slidr Studio makes (`elements/designs/managed.json`), ' +
    'with its picture in `images/designs/`, its names and its search tags in Hebrew and English.',
  id: "The new design's id: `m-` and lowercase words joined by hyphens, as `m-harbour-launch`, not taken in the library.",
  fields: [
    {
      name: 'group',
      type: 'string',
      about:
        'The group of the gallery it is shown in, as `techproduct`. A group the library does not ' +
        'have is added, named by `groupName`.',
      required: true,
    },
    {
      name: 'subject',
      type: '[x, y]',
      about: `The point of the slide where its picture's subject is, in pixels of the slide (${SLIDE_WIDTH} × ${SLIDE_HEIGHT}). The gallery crops a thumbnail around it.`,
      required: true,
    },
  ],
  languages: { required: BASE_LANGUAGES, allowed: CONTENT_LANGUAGES, complete: CONTENT_LANGUAGES },
  languageFields: [
    slideField,
    {
      name: 'name',
      type: 'string',
      about: "The design's name in the gallery.",
      required: true,
      languages: BASE_LANGUAGES,
    },
    {
      name: 'groupName',
      type: 'string',
      about: 'The name of its group, for a group the library does not have yet.',
      required: false,
      languages: BASE_LANGUAGES,
    },
    TAGS_FIELD,
  ],
  files: [picture, backdrop, ...CONTENT_LANGUAGES.map(thumb)],
  async check(draft, library, only) {
    const issues = new Issues();
    const id = draft.target;
    checkThumbs(draft, issues);
    if (!ID.test(id) || id.length > ID_MOST) {
      issues.add(
        'id',
        `A design is named \`m-\` and lowercase words joined by hyphens, as m-harbour-launch, in up to ${ID_MOST} characters.`,
      );
    } else if (await library.has(picture.path(id))) {
      issues.add(
        'id',
        `The library has a design ${id} already. To write it in more languages, upload a translation of it.`,
      );
    }
    const { group, subject } = draft.fields;
    if (typeof group !== 'string' || !SLUG.test(group) || group.length > 40) {
      issues.add('group', 'A group is named in lowercase words joined by hyphens, as techproduct.');
    }
    const point = Array.isArray(subject) ? (subject as unknown[]) : [];
    const [x, y] = point;
    if (
      point.length !== 2 ||
      typeof x !== 'number' ||
      typeof y !== 'number' ||
      !(x >= 0 && x <= SLIDE_WIDTH && y >= 0 && y <= SLIDE_HEIGHT)
    ) {
      issues.add(
        'subject',
        `The subject is a point of the slide, [x, y], within ${SLIDE_WIDTH} × ${SLIDE_HEIGHT}.`,
      );
    }
    const withBackdrop = draft.files.backdrop !== undefined;
    await checkLanguages(draft, library, { backdrop: withBackdrop, named: true, only }, issues);
    return issues.all;
  },
};

/** `translate`: a published design, in more languages. */
export const translateDesign: Handler = {
  type: 'designs',
  action: 'translate',
  about:
    'A published design, in languages it is not yet written in, or drawn again in one it is. ' +
    "The designs uploaded or made by Slidr Studio (`m-…`) take translations here; the app's own " +
    'are translated with its scripts.',
  id: "The published design's id, as `m-techmeetup`.",
  fields: [],
  languages: { required: [], allowed: OTHER_LANGUAGES, complete: [] },
  languageFields: [slideField],
  files: OTHER_LANGUAGES.map(thumb),
  async check(draft, library, only) {
    const issues = new Issues();
    const id = draft.target;
    checkThumbs(draft, issues);
    const published = await library.has(picture.path(id));
    if (!published) issues.add('id', `The library has no design ${id}.`);
    else if (!ID.test(id)) {
      issues.add(
        'id',
        `${id} is one of the app's own designs, which are translated with its scripts.`,
      );
    }
    if (!issues.none) return issues.all;
    const withBackdrop = await library.has(backdrop.path(id));
    await checkLanguages(draft, library, { backdrop: withBackdrop, named: false, only }, issues);
    return issues.all;
  },
};

/** The word of a slide, as `elements/designs/revs.json` gives it: 16 hexadecimal digits. */
const WORD = /^[0-9a-f]{16}$/;

/**
 * `draw`: the pictures made ahead of a published design's slides, drawn again of the slides as
 * they are published. Each language names the word of the slide its picture is of, and is taken
 * while the slide has that word (`../media/designFiles.ts`).
 */
export const drawDesign: Handler = {
  type: 'designs',
  action: 'draw',
  about:
    "Pictures of a published design's slides as the galleries show them, drawn of the slides as " +
    "they are published, which it does not change: of any design, the app's own too, in any " +
    'language it is written in. Slidr Studio draws those the library lacks.',
  id: "The published design's id, as `m-techmeetup`.",
  fields: [],
  languages: { required: [], allowed: CONTENT_LANGUAGES, complete: [] },
  languageFields: [
    {
      name: 'word',
      type: 'string',
      about:
        'The word of the slide the picture was drawn of, as `elements/designs/revs.json` gives it ' +
        "(the app's `designWord.ts`). The picture is taken while the slide has that word.",
      required: true,
    },
  ],
  files: CONTENT_LANGUAGES.map(thumb),
  async check(draft, library, only) {
    const issues = new Issues();
    const id = draft.target;
    checkThumbs(draft, issues);
    if (!(await library.has(picture.path(id)))) {
      issues.add('id', `The library has no design ${id}.`);
      return issues.all;
    }
    if (Object.keys(draft.languages).length === 0) {
      issues.add('languages', 'A drawing brings the picture of one slide at least.');
    }
    for (const name of Object.keys(draft.files)) {
      const lang = thumbLanguage(name) as ContentLanguage | undefined;
      if (lang && !isRecord(draft.languages[lang])) {
        issues.add(`files.${name}`, `${name} is of no language of the upload.`);
      }
    }
    const checked = languagesToCheck(draft, only);
    if (checked.length === 0) return issues.all;
    const revs = (await library.has(REVS))
      ? await library.json<{ designs?: Partial<Record<string, Record<string, string>>> }>(REVS)
      : undefined;
    for (const [lang, part] of checked) {
      const at = `languages.${lang}`;
      const english = LANGUAGE_NAMES[lang].english;
      if (!isRecord(part)) {
        issues.add(at, 'The content of a language is an object.', lang);
        continue;
      }
      for (const key of unknownKeys(part, ['word'])) {
        issues.add(`${at}.${key}`, `A drawing's content in a language has no field ${key}.`, lang);
      }
      if (!draft.files[`thumb-${lang}`]) {
        issues.add(`files.thumb-${lang}`, `The picture of the slide in ${english}.`, lang);
      }
      const word = revs?.designs?.[lang]?.[id];
      if (typeof part.word !== 'string' || !WORD.test(part.word)) {
        issues.add(
          `${at}.word`,
          `The word of the slide drawn, 16 hexadecimal digits, as ${REVS} gives it.`,
          lang,
        );
      } else if (!word) {
        issues.add(at, `The library has no slide of ${id} in ${english}.`, lang);
      } else if (word !== part.word) {
        issues.add(
          `${at}.word`,
          `The slide in ${english} is no longer the one drawn: draw it again.`,
          lang,
        );
      }
    }
    return issues.all;
  },
};
