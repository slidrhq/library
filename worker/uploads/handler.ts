/**
 * What every kind of upload is made of, and the checks they share. Each part of the library that
 * takes uploads says, for each thing an upload of it may do (`add`, `translate`), which fields it
 * has, which languages it is written in, which files it brings, and how it is checked
 * (`designs.ts`, `templates.ts`; `content.ts` names them all).
 */
import {
  plainText,
  walkElements,
  type ContentLanguage,
  type Element,
  type RichText,
} from '@slidr/model';
import type { Issue } from '../http.ts';
import type { Library } from './library.ts';

/** The parts of the library, as its page names them (`src/sections.ts`). */
export const TYPES = [
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
] as const;
export type TypeId = (typeof TYPES)[number];

/**
 * What an upload does: `add` puts a new item into the library, `translate` writes a published
 * item in more languages.
 */
export const ACTIONS = ['add', 'translate'] as const;
export type ActionId = (typeof ACTIONS)[number];

/** A field of an upload, as `GET /api/content` describes it. */
export interface Field {
  name: string;
  /** Its JSON type, in words: `string`, `[x, y]`, `Slide`. */
  type: string;
  about: string;
  required: boolean;
  /** The languages it is written in, when not every language of the upload. */
  languages?: readonly ContentLanguage[];
}

/** A file an upload brings, sent as a part of its form by this name. */
export interface FileRule {
  name: string;
  about: string;
  required: boolean;
  /** Its media types, as its bytes show them. */
  types: readonly string[];
  maxBytes: number;
  /** Its place in the library, for the item's id. */
  path: (id: string) => string;
}

/** A file of an upload, as it is kept. */
export interface StoredFile {
  /** Its place in the library once it is published. */
  path: string;
  type: string;
  bytes: number;
  sha256: string;
  /** A picture's size in pixels. */
  width?: number;
  height?: number;
}

/** What an upload holds: the item, in each of its languages, and its files. */
export interface Draft {
  type: TypeId;
  action: ActionId;
  /** The item's id in the library: the new one it adds, or the published one it translates. */
  target: string;
  /** The fields that are written once, in no language. */
  fields: Record<string, unknown>;
  /** The item's content in each language, as `languageFields` describes it. */
  languages: Partial<Record<ContentLanguage, unknown>>;
  files: Record<string, StoredFile>;
}

export interface Handler {
  type: TypeId;
  action: ActionId;
  about: string;
  /** What the upload's `id` names. */
  id: string;
  fields: readonly Field[];
  languages: {
    /** The languages the upload is made with. */
    required: readonly ContentLanguage[];
    /** The languages it may be written in. */
    allowed: readonly ContentLanguage[];
    /** The languages it has to be written in before it is accepted. */
    complete: readonly ContentLanguage[];
  };
  /** What the content of one language holds. */
  languageFields: readonly Field[];
  files: readonly FileRule[];
  /**
   * Everything wrong with the upload, against the published library; none when it holds. With
   * `only`, the content of those languages alone is checked, beside the fields: a change to one
   * language leaves the others as they were checked.
   */
  check(draft: Draft, library: Library, only?: readonly ContentLanguage[]): Promise<Issue[]>;
}

const MIB = 1024 * 1024;
/** A picture of the library: the largest are a few megabytes. */
export const PICTURE_BYTES = 16 * MIB;

/** Lowercase letters and digits, joined by hyphens: `harbour-launch`. */
export const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Words that stand for text that was never written. The app's tests hold every design to it
 * (`apps/desktop/src/elements/designs.test.ts`).
 */
const PLACEHOLDER =
  /lorem ipsum|placeholder|add your text|טקסט לדוגמה|texte d'exemple|texto de ejemplo|beispieltext/i;

/** The issues kept of one language, so an answer stays readable. */
const MOST_PER_LANGUAGE = 20;

/** Collects the issues of a check, each at its place. */
export class Issues {
  readonly all: Issue[] = [];
  private readonly count = new Map<string, number>();

  add(path: string, message: string, language?: ContentLanguage) {
    const key = language ?? '';
    const seen = (this.count.get(key) ?? 0) + 1;
    this.count.set(key, seen);
    const where = language ? { language } : {};
    if (seen <= MOST_PER_LANGUAGE) this.all.push({ path, message, ...where });
    else if (seen === MOST_PER_LANGUAGE + 1) {
      this.all.push({ path, message: 'More issues follow; fix these first.', ...where });
    }
  }

  /** The issues a schema found, under `at`. */
  addSchema(
    at: string,
    error: { issues: readonly { path: readonly PropertyKey[]; message: string }[] },
    language?: ContentLanguage,
  ) {
    for (const issue of error.issues) {
      const path = [at, ...issue.path.map(String)].join('.');
      this.add(path, issue.message, language);
    }
  }

  get none() {
    return this.all.length === 0;
  }
}

/** The fields of an object that are not among those named. */
export function unknownKeys(value: Record<string, unknown>, known: readonly string[]): string[] {
  return Object.keys(value).filter((key) => !known.includes(key));
}

/** A string of 1 to `most` characters, after trimming. */
export const isText = (value: unknown, most: number): value is string =>
  typeof value === 'string' && value.trim().length > 0 && value.length <= most;

/** The languages of a draft to check: all of them, or those named. */
export const languagesToCheck = (draft: Draft, only?: readonly ContentLanguage[]) =>
  Object.entries(draft.languages).filter(
    ([lang]) => !only || only.includes(lang as ContentLanguage),
  ) as [ContentLanguage, unknown][];

/** The texts of a slide's elements: its text boxes, and the shapes that carry words. */
export function wordedOf(elements: readonly Element[]): { element: Element; content: RichText }[] {
  return [...walkElements(elements)].flatMap((element) =>
    (element.type === 'text' || element.type === 'shape') && element.content
      ? [{ element, content: element.content }]
      : [],
  );
}

/** Text that was never written, if a copy has any. */
export function placeholderIn(contents: readonly RichText[]): string | undefined {
  return contents.map(plainText).join(' ').match(PLACEHOLDER)?.[0];
}

/** A text, short enough to quote in a message. */
export const quote = (text: string) => `"${text.length > 40 ? `${text.slice(0, 39)}…` : text}"`;
