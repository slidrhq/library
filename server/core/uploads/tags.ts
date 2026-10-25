/**
 * Search tags: the words in Hebrew and English that the app finds a thing by beside its name, so
 * that "יום הולדת" finds the birthday invitation, the cake and the balloons (ADR-108 of the app).
 * The library keeps them a file a part, `tags/<part>.json`, each item under the key its catalog
 * gives it; a design uploaded here carries its own, which publishing writes beside its names in
 * `managed.json`.
 *
 * Every upload that brings tags holds them to one rule (`checkTags`), the same the app's
 * `scripts/tag-elements.mjs` cleans Claude's answers by. A part of the library whose items are
 * searched takes an upload of `tag`: the tags of some of its published items, by their keys,
 * which publishing merges into its file.
 */
import {
  BASE_LANGUAGES,
  CONTENT_LANGUAGES,
  LANGUAGE_NAMES,
  type ContentLanguage,
} from '@slidr/model';
import { shapePresets } from '../../../vendor/packages/renderer/src/geometry.ts';
import { isRecord } from '../http.ts';
import {
  Issues,
  languagesToCheck,
  quote,
  unknownKeys,
  type Handler,
  type TypeId,
} from './handler.ts';
import type { Library } from './library.ts';

/** The fewest tags a language gives an item, and the most. */
export const TAGS_FEWEST = 3;
export const TAGS_MOST = 20;
/** The longest tag, in characters and in words. */
const TAG_CHARACTERS = 40;
const TAG_WORDS = 4;

const HEBREW = /\p{Script=Hebrew}/u;
const NIQQUD = /[֑-ׇ]/u;
const LETTERS: Record<ContentLanguage, RegExp> = {
  he: /\p{Script=Hebrew}/u,
  en: /\p{Script=Latin}/u,
  ar: /\p{Script=Arabic}/u,
  de: /\p{Script=Latin}/u,
  es: /\p{Script=Latin}/u,
  fr: /\p{Script=Latin}/u,
  it: /\p{Script=Latin}/u,
  'pt-BR': /\p{Script=Latin}/u,
  ru: /\p{Script=Cyrillic}/u,
  tr: /\p{Script=Latin}/u,
  vi: /\p{Script=Latin}/u,
  id: /\p{Script=Latin}/u,
  hi: /\p{Script=Devanagari}/u,
  ja: /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u,
  ko: /\p{Script=Hangul}/u,
  'zh-CN': /\p{Script=Han}/u,
};

/** Words about the drawing rather than what it shows, in either language. */
const MEDIUM = new Set([
  'icon',
  'icons',
  'illustration',
  'drawing',
  'sticker',
  'emoji',
  'clipart',
  'clip art',
  'graphic',
  'outline',
  'flat',
  '3d',
  'אייקון',
  'אייקונים',
  'איור',
  'ציור',
  'סטיקר',
  'מדבקה',
  'אימוגי',
  'אמוגי',
  'קליפארט',
  'גרפיקה',
  'קו מתאר',
  'קווי מתאר',
]);

/** A tag as it is kept: its spaces single, its letters composed. */
const tidy = (tag: string) => tag.normalize('NFC').replace(/\s+/g, ' ').trim();

/**
 * The issues of the tags of one item in one language, at `at`: a list of 3 to 20 tags, each of
 * one to four words, in the language's own letters (Hebrew without niqqud, English in lower case),
 * none twice, and none about how the item is drawn.
 */
export function checkTags(at: string, lang: ContentLanguage, value: unknown, issues: Issues) {
  const language = LANGUAGE_NAMES[lang].english;
  if (
    !Array.isArray(value) ||
    value.length < TAGS_FEWEST ||
    value.length > TAGS_MOST ||
    !value.every((tag) => typeof tag === 'string')
  ) {
    issues.add(
      at,
      `The search tags in ${language}: a list of ${TAGS_FEWEST} to ${TAGS_MOST} words people type to find it.`,
      lang,
    );
    return;
  }
  const seen = new Set<string>();
  value.forEach((tag: string, i) => {
    const where = `${at}.${i}`;
    const plain = tidy(tag);
    const bare = plain.replace(/['"׳״`’]/g, '');
    if (!plain || plain.length > TAG_CHARACTERS || plain.split(' ').length > TAG_WORDS) {
      issues.add(
        where,
        `A tag is one to ${TAG_WORDS} words, in up to ${TAG_CHARACTERS} characters.`,
        lang,
      );
    } else if (plain !== tag) {
      issues.add(where, `${quote(tag)} is written ${quote(plain)}, with single spaces.`, lang);
    } else if (!LETTERS[lang].test(tag) || (lang !== 'he' && HEBREW.test(tag))) {
      issues.add(where, `${quote(tag)} is not written in ${language} letters.`, lang);
    } else if (lang === 'he' && NIQQUD.test(tag)) {
      issues.add(where, `${quote(tag)} is written without niqqud.`, lang);
    } else if (lang === 'en' && tag !== tag.toLowerCase()) {
      issues.add(where, `${quote(tag)} is written in lower case.`, lang);
    } else if (MEDIUM.has(bare.toLowerCase())) {
      issues.add(where, `${quote(tag)} says how it is drawn, not what it is or is for.`, lang);
    } else if (seen.has(tag)) {
      issues.add(where, `${quote(tag)} is there twice.`, lang);
    }
    seen.add(tag);
  });
}

/** The tags of a language, as `Field` describes them to `GET /api/content`. */
export const TAGS_FIELD = {
  name: 'tags',
  type: 'Tags',
  about:
    `The words people type to find it in the app's search, beside its name: what it is or shows, ` +
    `what it is for, the occasions and themes it suits. ${TAGS_FEWEST} to ${TAGS_MOST}, ` +
    'the most telling first, each of one to four words: Hebrew without niqqud, English in lower case.',
  required: true,
  languages: BASE_LANGUAGES,
} as const;

/* ---------------------------------------------------------------- the items of a part */

type Keys = (library: Library) => Promise<ReadonlySet<string>>;

/** A catalog of the library, or nothing when it has none. */
const catalogOf = async <T>(library: Library, path: string): Promise<T | undefined> =>
  (await library.has(path)) ? library.json<T>(path) : undefined;

/** The keys the items of each part that is searched are tagged under, as the app reads them. */
const KEYS: Partial<Record<TypeId, { about: string; keys: Keys }>> = {
  designs: {
    about: 'a design by its id, as `birthday` or `m-techmeetup`',
    // Every design, the app's and the studio's, has its picture at `images/designs/<id>.webp`.
    async keys(library) {
      const ids = (await library.paths()).flatMap((path) => {
        const id = /^images\/designs\/([^/]+)\.webp$/.exec(path)?.[1];
        return id && !id.endsWith('-bg') ? [id] : [];
      });
      return new Set(ids);
    },
  },
  cards: {
    about: 'a card set by its id, as `steps`',
    async keys(library) {
      const catalog = await catalogOf<{ order?: unknown[] }>(
        library,
        'elements/cards/catalog.json',
      );
      return new Set((catalog?.order ?? []).filter((id): id is string => typeof id === 'string'));
    },
  },
  frames: {
    about: 'a frame by its id, as `magnet-birthday`',
    async keys(library) {
      const catalog = await catalogOf<{ groups?: { frames?: { id?: unknown }[] }[] }>(
        library,
        'elements/catalogs/frames-catalog.json',
      );
      const ids = (catalog?.groups ?? [])
        .flatMap((group) => group.frames ?? [])
        .map((one) => one.id);
      return new Set(ids.filter((id): id is string => typeof id === 'string'));
    },
  },
  shapes: {
    about:
      'a shape as `shape:<preset>` (`shape:rightArrow`), a line as `line:<kind>`, the card as `card`',
    // The shapes are the renderer's presets, and the lines and the card the app's own.
    async keys(library) {
      const catalog = await catalogOf<{ shapes?: object; lines?: object }>(
        library,
        'elements/catalogs/shapes.json',
      );
      return new Set([
        ...[...shapePresets, ...Object.keys(catalog?.shapes ?? {})].map(
          (preset) => `shape:${preset}`,
        ),
        ...Object.keys(catalog?.lines ?? {}).map((kind) => `line:${kind}`),
        'card',
      ]);
    },
  },
  graphics: {
    about: 'a graphic by its drawing, `<art set>:<name>`, as `fluent-emoji:balloon`',
    async keys(library) {
      const catalog = await catalogOf<{ icons?: unknown[] }[]>(
        library,
        'elements/catalogs/graphics-catalog.json',
      );
      const keys = (catalog ?? []).flatMap((style) => style.icons ?? []);
      return new Set(keys.filter((key): key is string => typeof key === 'string'));
    },
  },
  emoji: {
    about: 'an emoji by its name, as `birthday-cake`',
    async keys(library) {
      const catalog = await catalogOf<{ emoji?: unknown[] }[]>(
        library,
        'elements/catalogs/emoji-catalog.json',
      );
      const lines = (catalog ?? []).flatMap((group) => group.emoji ?? []);
      return new Set(
        lines.flatMap((line) => (typeof line === 'string' ? [line.split('|')[0]!] : [])),
      );
    },
  },
  icons: {
    about: 'an icon as `<set>:<name>`, as `lucide:cake` or `tabler:balloon` (both its styles)',
    async keys(library) {
      const lucide = await catalogOf<object>(library, 'icons/lucide/tags.json');
      const tabler = await catalogOf<object>(library, 'icons/tabler/icons.json');
      return new Set([
        ...Object.keys(lucide ?? {}).map((name) => `lucide:${name}`),
        ...Object.keys(tabler ?? {}).map((name) => `tabler:${name}`),
      ]);
    },
  },
};

/** The parts whose items the app searches by tags, in the order of the library. */
export const TAGGED = Object.keys(KEYS) as TypeId[];

/** `tag`: the search tags of published items of a part. */
export function tagHandler(type: TypeId): Handler {
  const part = KEYS[type]!;
  return {
    type,
    action: 'tag',
    about:
      `The search tags of published ${type}, in any supported language, by the key of each: ` +
      `${part.about}. Publishing merges them into \`tags/${type}.json\`: an item named here takes ` +
      'these tags in place of those it had, and the others keep theirs.',
    id: `The part whose items these tags are for: \`${type}\`.`,
    fields: [],
    languages: { required: BASE_LANGUAGES, allowed: CONTENT_LANGUAGES, complete: BASE_LANGUAGES },
    languageFields: [
      {
        name: 'tags',
        type: 'Record<key, Tags>',
        about: `The tags of each item in this language, by its key (${part.about}). ${TAGS_FIELD.about}`,
        required: true,
      },
    ],
    files: [],
    async check(draft, library, only) {
      const issues = new Issues();
      if (draft.target !== type) {
        issues.add('id', `An upload of the tags of ${type} is named ${type}.`);
        return issues.all;
      }
      const checked = languagesToCheck(draft, only);
      if (checked.length === 0) return issues.all;
      const keys = await part.keys(library);
      // What each language tags, to hold it to the other's.
      const tagged = Object.fromEntries(
        Object.entries(draft.languages).map(([lang, content]) => [
          lang,
          isRecord(content) && isRecord(content.tags) ? Object.keys(content.tags) : [],
        ]),
      );
      for (const [lang, content] of checked) {
        const at = `languages.${lang}`;
        if (!isRecord(content) || !isRecord(content.tags)) {
          issues.add(
            `${at}.tags`,
            'The tags of the items, by their keys: { "<key>": [ … ] }.',
            lang,
          );
          continue;
        }
        for (const key of unknownKeys(content, ['tags'])) {
          issues.add(`${at}.${key}`, `The tags of a language are under tags, and no ${key}.`, lang);
        }
        const entries = Object.entries(content.tags);
        if (entries.length === 0) issues.add(`${at}.tags`, 'Tags for one item at least.', lang);
        const others = CONTENT_LANGUAGES.filter(
          (other) => other !== lang && Object.hasOwn(draft.languages, other),
        );
        for (const [key, tags] of entries) {
          if (!keys.has(key)) {
            issues.add(
              `${at}.tags.${key}`,
              `The library has no ${type.replace(/s$/, '')} ${key}.`,
              lang,
            );
            continue;
          }
          for (const other of others) {
            if (!tagged[other]!.includes(key)) {
              issues.add(
                `${at}.tags.${key}`,
                `${key} has no tags in ${LANGUAGE_NAMES[other].english}: an item is tagged in both.`,
                lang,
              );
            }
          }
          checkTags(`${at}.tags.${key}`, lang, tags, issues);
        }
      }
      return issues.all;
    },
  };
}
