/**
 * The parts of the library, and what an upload may do to each (`GET /api/content`).
 *
 * A part takes uploads where what is uploaded stays: designs join the catalog Slidr Studio
 * publishes into, and a template's sample takes more languages beside those its source writes.
 * The other parts are written whole by the app's own scripts, from packages they read, or are
 * drawn by the app's code, so an upload into them would be written over, or never shown; each
 * says why. Opening one takes the app first: a catalog of its own that publishing merges, as
 * `managed.json` is for designs.
 */
import {
  BASE_LANGUAGES,
  CONTENT_LANGUAGES,
  LANGUAGE_NAMES,
  LANGUAGE_SCRIPT,
  languageDir,
  type ContentLanguage,
} from '@slidr/model';
import { addDesign, translateDesign } from './designs.ts';
import type { ActionId, Handler, TypeId } from './handler.ts';
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
  /** Why it takes no uploads. */
  closed?: string;
}

export const PARTS: readonly Part[] = [
  {
    type: 'designs',
    written: 'content',
    paths: ['elements/designs/managed.json', 'images/designs/'],
    handlers: [addDesign, translateDesign],
  },
  {
    type: 'templates',
    written: 'content',
    paths: ['templates/catalog.json'],
    handlers: [translateTemplate],
  },
  {
    type: 'cards',
    written: 'base',
    paths: ['elements/cards/catalog.json'],
    handlers: [],
    closed:
      'The app offers only the card sets its code names (`CardSetId` in ' +
      '`apps/desktop/src/elements/cardSets.ts`), so a new set would not be shown.',
  },
  {
    type: 'frames',
    written: 'base',
    paths: ['elements/catalogs/frames-catalog.json', 'images/frames/'],
    handlers: [],
    closed:
      "The app's `scripts/generate-frames-catalog.mjs` writes the catalog whole, from the frames " +
      'it draws, and would drop an uploaded one.',
  },
  {
    type: 'shapes',
    written: 'none',
    paths: ['elements/catalogs/shapes.json'],
    handlers: [],
    closed:
      "Each shape is a preset of the app's renderer: a new one needs the renderer to draw it.",
  },
  {
    type: 'graphics',
    written: 'base',
    paths: ['elements/catalogs/graphics-catalog.json'],
    handlers: [],
    closed:
      "The app's `scripts/generate-graphics-catalog.mjs` writes the catalog whole, from the art " +
      'sets, and would drop an uploaded graphic.',
  },
  {
    type: 'emoji',
    written: 'base',
    paths: ['elements/catalogs/emoji-catalog.json'],
    handlers: [],
    closed:
      "The app's `scripts/generate-emoji-catalog.mjs` writes the catalog whole, from Twemoji, " +
      'and would drop an uploaded emoji.',
  },
  {
    type: 'art',
    written: 'none',
    paths: ['elements/art/'],
    handlers: [],
    closed:
      'The art sets are packages, each published with its licence, and the app offers only the ' +
      'sets its code names (`ART` in `apps/desktop/src/elements/stickers.ts`).',
  },
  {
    type: 'icons',
    written: 'base',
    paths: ['icons/'],
    handlers: [],
    closed: 'The Lucide and Tabler sets, as their packages publish them.',
  },
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
