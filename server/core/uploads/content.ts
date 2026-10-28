/**
 * The parts of the library, and what an upload may do to each (`GET /api/content`).
 *
 * A part takes new items where what is uploaded stays: designs join the catalog of the designs,
 * which publishing writes into and no script writes over, and a template's sample takes more
 * languages beside those its source writes. The other parts are written whole by the app's own
 * scripts, from packages they read, or are drawn by the app's code, so a new item in them would be
 * written over, or never shown; each says why (`closed`). Opening one takes the app first: a
 * catalog that publishing writes into, as the designs' is. Every part the app searches takes the
 * search tags of its items (`tag`, `tags.ts`), which are a file of their own, `tags/<part>.json`.
 */
import {
  BASE_LANGUAGES,
  CONTENT_LANGUAGES,
  LANGUAGE_NAMES,
  LANGUAGE_SCRIPT,
  languageDir,
  type ContentLanguage,
} from '@slidr/model';
import { addDesign, drawDesign, translateDesign } from './designs.ts';
import type { ActionId, Handler, TypeId } from './handler.ts';
import { tagHandler } from './tags.ts';
import { translateTemplate } from './templates.ts';

/** The languages a part of the library is written in. */
type Written =
  /** Any language of the app, Hebrew and English first. */
  | 'content'
  /** Hebrew and English only. */
  | 'base'
  /** No language: shapes, drawings. */
  | 'none'
  /** Scripts, not languages: a font has letters. */
  | 'scripts';

interface Part {
  type: TypeId;
  written: Written;
  /** Where it is in the library. */
  paths: readonly string[];
  handlers: readonly Handler[];
  /** Why it takes no new items. */
  closed?: string;
}

/**
 * The files of art sets, each the set's drawings and its licence. A set is a part of what is drawn
 * from it (`ART` in the app's `elements/stickers.ts`), as the page counts it (`src/sections.ts`).
 */
const artSets = (...sets: string[]) =>
  sets.flatMap((set) => [`elements/art/${set}.json`, `elements/art/${set}.notice.json`]);

/** A part the app searches: it takes the tags of its items, kept in `tags/<part>.json`. */
const tagged = (part: Part): Part => ({
  ...part,
  paths: [...part.paths, `tags/${part.type}.json`],
  handlers: [...part.handlers, tagHandler(part.type)],
});

export const PARTS: readonly Part[] = [
  tagged({
    type: 'designs',
    written: 'content',
    paths: ['elements/designs/index.json', 'images/designs/'],
    handlers: [addDesign, translateDesign, drawDesign],
  }),
  {
    type: 'templates',
    written: 'content',
    paths: ['templates/catalog.json'],
    handlers: [translateTemplate],
  },
  tagged({
    type: 'cards',
    written: 'base',
    paths: ['elements/cards/catalog.json'],
    handlers: [],
    closed:
      'The app offers only the card sets its code names (`CardSetId` in ' +
      '`desktop/src/elements/cardSets.ts`), so a new set would not be shown.',
  }),
  tagged({
    type: 'frames',
    written: 'base',
    paths: ['elements/catalogs/frames-catalog.json', 'images/frames/'],
    handlers: [],
    closed:
      "The app's `scripts/generate-frames-catalog.mjs` writes the catalog whole, from the frames " +
      'it draws, and would drop an uploaded one.',
  }),
  tagged({
    type: 'shapes',
    written: 'none',
    paths: ['elements/catalogs/shapes.json'],
    handlers: [],
    closed:
      "Each shape is a preset of the app's renderer: a new one needs the renderer to draw it.",
  }),
  tagged({
    type: 'graphics',
    written: 'base',
    paths: [
      'elements/catalogs/graphics-catalog.json',
      ...artSets(
        'fluent-color',
        'fluent-emoji',
        'noto',
        'streamline-kameleon-color',
        'fluent-emoji-flat',
        'streamline-stickies-color',
        'streamline-ultimate-color',
        'streamline-emojis',
        'streamline-flex-color',
        'streamline-freehand-color',
      ),
    ],
    handlers: [],
    closed:
      "The app's `scripts/generate-graphics-catalog.mjs` writes the catalog whole, from the art " +
      'sets, and would drop an uploaded graphic. The sets are packages, each published with its ' +
      'licence, and the app offers only those its code names (`ART` in ' +
      '`desktop/src/elements/stickers.ts`).',
  }),
  tagged({
    type: 'emoji',
    written: 'base',
    paths: ['elements/catalogs/emoji-catalog.json', ...artSets('twemoji')],
    handlers: [],
    closed:
      "The app's `scripts/generate-emoji-catalog.mjs` writes the catalog whole, from Twemoji, " +
      'and would drop an uploaded emoji.',
  }),
  tagged({
    type: 'icons',
    written: 'base',
    paths: ['icons/'],
    handlers: [],
    closed: 'The Lucide and Tabler sets, as their packages publish them.',
  }),
  {
    type: 'fonts',
    written: 'scripts',
    paths: ['fonts/'],
    handlers: [],
    closed:
      "The app's `scripts/gen-builtin-fonts.mjs` writes the catalog whole, from the font " +
      'packages it names, and would drop an uploaded family.',
  },
];

export const partOf = (type: string) => PARTS.find((part) => part.type === type);

export const handlerOf = (type: string, action: string): Handler | undefined =>
  partOf(type)?.handlers.find((handler) => handler.action === action);

const WRITTEN: Record<Written, readonly ContentLanguage[]> = {
  content: CONTENT_LANGUAGES,
  base: BASE_LANGUAGES,
  none: [],
  scripts: [],
};

/** The languages, and each part, as `GET /api/content` answers them. */
export function describeContent() {
  return {
    languages: CONTENT_LANGUAGES.map((code) => ({
      code,
      ...LANGUAGE_NAMES[code],
      dir: languageDir(code),
      script: LANGUAGE_SCRIPT[code],
      base: (BASE_LANGUAGES as readonly string[]).includes(code),
    })),
    types: PARTS.map((part) => ({
      type: part.type,
      languages: part.written === 'scripts' ? 'scripts' : WRITTEN[part.written],
      paths: part.paths,
      uploads: part.handlers.length > 0,
      ...(part.closed ? { closed: part.closed } : {}),
      actions: Object.fromEntries(
        part.handlers.map((handler) => [handler.action satisfies ActionId, describe(handler)]),
      ),
    })),
  };
}

function describe(handler: Handler) {
  return {
    about: handler.about,
    id: handler.id,
    fields: handler.fields,
    languages: handler.languages,
    languageFields: handler.languageFields,
    files: handler.files.map(({ path, ...rule }) => ({ ...rule, path: path('<id>') })),
  };
}
