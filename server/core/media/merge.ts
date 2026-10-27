/**
 * What a publication writes of each kind of upload into the files of the library: the search
 * tags of a part into `tags/<part>.json`, a design into the catalog of the designs Slidr Studio
 * makes (`elements/designs/managed.json`), a template's sample into `templates/catalog.json`.
 * Each is a function of the file as it is and the upload, and changes nothing else of the file.
 */
import { BASE_LANGUAGES, CONTENT_LANGUAGES } from '@slidr/model';
import { isRecord } from '../http.ts';
import type { Draft } from '../uploads/handler.ts';
import { toBytes, toText } from './live.ts';

/** What a publication cannot write of an upload, in words. */
export class PublishError extends Error {}

/** Codes of languages in the app's order, Hebrew and English first; others after, as they came. */
function inOrder(codes: Iterable<string>): string[] {
  const all = [...codes];
  return [
    ...CONTENT_LANGUAGES.filter((code) => all.includes(code)),
    ...all.filter((code) => !(CONTENT_LANGUAGES as readonly string[]).includes(code)),
  ];
}

const byLanguage = <T>(values: Record<string, T>): Record<string, T> =>
  Object.fromEntries(inOrder(Object.keys(values)).map((code) => [code, values[code]!]));

/* ---------------------------------------------------------------- search tags */

/** `tags/<part>.json`: each item's tags by language, under the key its catalog gives it. */
export interface TagsFile {
  version: 1;
  tags: Record<string, Record<string, string[]>>;
}

export const tagsPath = (part: string) => `tags/${part}.json`;

/**
 * The tags of an upload of `tag` merged into its part's file: an item the upload names takes
 * the tags it gives, in every language it gives them, in place of those it had; every other item
 * keeps its own. A new item goes last.
 */
export function mergeTags(file: unknown, languages: Draft['languages']): TagsFile {
  const tags: TagsFile['tags'] =
    isRecord(file) && isRecord(file.tags) ? ({ ...file.tags } as TagsFile['tags']) : {};
  const given: Record<string, Record<string, string[]>> = {};
  for (const [lang, content] of Object.entries(languages)) {
    if (isRecord(content) && isRecord(content.tags)) {
      given[lang] = content.tags as Record<string, string[]>;
    }
  }
  const order = inOrder(Object.keys(given));
  const keys = [...new Set(order.flatMap((lang) => Object.keys(given[lang]!)))];
  for (const key of keys) {
    tags[key] = Object.fromEntries(
      order
        .filter((lang) => Array.isArray(given[lang]![key]))
        .map((lang) => [lang, [...given[lang]![key]!]]),
    );
  }
  return { version: 1, tags };
}

/** A file of tags as the app's `tag-elements.mjs` writes it: an item a line. */
export function encodeTags(file: TagsFile): string {
  const lines = Object.entries(file.tags).map(
    ([key, value]) => `    ${JSON.stringify(key)}: ${JSON.stringify(value)}`,
  );
  return `{\n  "version": 1,\n  "tags": {\n${lines.join(',\n')}\n  }\n}\n`;
}

/* ---------------------------------------------------------------- designs */

export const MANAGED = 'elements/designs/managed.json';

type Names = Record<string, string>;

/** The catalog of the designs Slidr Studio makes (docs/media-library.md of the app). */
export interface ManagedCatalog {
  version: number;
  groups: string[];
  groupNames: Record<string, Names>;
  groupIds: Record<string, string[]>;
  slides: Record<string, Record<string, unknown>>;
  subjects: Record<string, [number, number]>;
  names: Record<string, Names>;
  sizes: Record<string, [number, number]>;
  tags: Record<string, Record<string, string[]>>;
  [key: string]: unknown;
}

export const emptyCatalog = (): ManagedCatalog => ({
  version: 1,
  groups: [],
  groupNames: {},
  groupIds: {},
  slides: {},
  subjects: {},
  names: {},
  sizes: {},
  tags: {},
});

/** A design as a catalog keeps it. */
export interface DesignRecord {
  id: string;
  name: Names;
  group: string;
  groupName?: Names;
  slides: Record<string, unknown>;
  subject: [number, number];
  size: [number, number];
  tags?: Record<string, string[]>;
}

const text = (value: unknown) => (typeof value === 'string' && value.trim() ? value : undefined);

/**
 * The design of an upload of `designs: add`: its names and its group's in Hebrew and English,
 * its slide in each language, the point of its picture's subject, its picture's size and its
 * search tags. The library checked each when it took the upload; what is missing after all is
 * not published.
 */
export function designOf(upload: Draft & { id?: string }): DesignRecord {
  const where = `${upload.target}`;
  const languages = upload.languages as Record<string, Record<string, unknown> | undefined>;
  const slides = byLanguage(
    Object.fromEntries(
      Object.entries(languages)
        .filter(([, content]) => isRecord(content) && content.slide)
        .map(([lang, content]) => [lang, content!.slide]),
    ),
  );
  if (BASE_LANGUAGES.some((lang) => !Object.hasOwn(slides, lang))) {
    throw new PublishError(`${where} has no Hebrew or English slide.`);
  }
  const name: Names = {};
  for (const lang of BASE_LANGUAGES) {
    const one = text(languages[lang]?.name);
    if (!one) throw new PublishError(`${where} is not named in Hebrew and English.`);
    name[lang] = one;
  }
  const { group, subject } = upload.fields;
  if (typeof group !== 'string' || !group) throw new PublishError(`${where} names no group.`);
  const point = Array.isArray(subject) ? (subject as unknown[]) : [];
  if (point.length !== 2 || point.some((n) => typeof n !== 'number')) {
    throw new PublishError(`${where} says no point of its picture's subject.`);
  }
  const picture = upload.files.picture;
  if (!picture?.width || !picture.height) {
    throw new PublishError(`${where} says no size of its picture.`);
  }
  const record: DesignRecord = {
    id: upload.target,
    name,
    group,
    slides,
    subject: [point[0] as number, point[1] as number],
    size: [picture.width, picture.height],
  };
  const groupNames = BASE_LANGUAGES.map((lang) => text(languages[lang]?.groupName));
  if (groupNames.every(Boolean)) {
    record.groupName = Object.fromEntries(BASE_LANGUAGES.map((lang, i) => [lang, groupNames[i]!]));
  }
  const tags = BASE_LANGUAGES.map((lang) => languages[lang]?.tags);
  if (tags.every((one) => Array.isArray(one) && one.length > 0)) {
    record.tags = Object.fromEntries(
      BASE_LANGUAGES.map((lang, i) => [lang, [...(tags[i] as string[])]]),
    );
  }
  return record;
}

/**
 * Puts a design into the managed catalog, in place when it is there, as Slidr Studio's own
 * publication did (`merge_design` of its `library.py`): a design has one group, a group keeps
 * the names it was first published with, and a group left without designs goes.
 */
export function mergeDesign(catalog: ManagedCatalog, design: DesignRecord): ManagedCatalog {
  for (const [key, value] of Object.entries(emptyCatalog())) {
    if (!Object.hasOwn(catalog, key)) catalog[key] = value;
  }
  const { id, group } = design;
  if (!catalog.groups.includes(group)) catalog.groups.push(group);
  catalog.groupNames[group] ??= design.groupName ?? { he: group, en: group };
  for (const [other, ids] of Object.entries(catalog.groupIds)) {
    if (other !== group && ids.includes(id)) ids.splice(ids.indexOf(id), 1);
  }
  const ids = (catalog.groupIds[group] ??= []);
  if (!ids.includes(id)) ids.push(id);
  catalog.slides[id] = design.slides;
  catalog.subjects[id] = design.subject;
  catalog.names[id] = design.name;
  catalog.sizes[id] = design.size;
  if (design.tags) catalog.tags[id] = design.tags;
  else delete catalog.tags[id];
  for (const empty of catalog.groups.filter((one) => !catalog.groupIds[one]?.length)) {
    catalog.groups.splice(catalog.groups.indexOf(empty), 1);
    delete catalog.groupIds[empty];
    delete catalog.groupNames[empty];
  }
  catalog.groupIds = Object.fromEntries(catalog.groups.map((one) => [one, catalog.groupIds[one]!]));
  return catalog;
}

/**
 * Puts the slides of an upload of `designs: translate` beside those its design has, in the
 * app's order of languages. The languages it wrote.
 */
export function mergeTranslation(
  catalog: ManagedCatalog,
  id: string,
  languages: Draft['languages'],
): string[] {
  const slides = catalog.slides?.[id];
  if (!isRecord(slides)) {
    throw new PublishError(`The catalog of the studio's designs has no design ${id}.`);
  }
  const written = Object.entries(languages)
    .filter(([, content]) => isRecord(content) && content.slide)
    .map(([lang]) => lang);
  if (written.length === 0) throw new PublishError(`The translation of ${id} holds no slide.`);
  const mine: Record<string, unknown> = { ...slides };
  for (const lang of written)
    mine[lang] = (languages as Record<string, { slide: unknown }>)[lang]!.slide;
  catalog.slides[id] = byLanguage(mine);
  return inOrder(written);
}

/* ---------------------------------------------------------------- the samples of templates */

export const TEMPLATES = 'templates/catalog.json';

// The catalog of templates is some 17 MB, more than a Worker can hold as objects: a sample is
// written into its text, found by reading only the structure of the JSON around it. Every byte
// that is not ASCII is part of a string in UTF-8, so the structure is read byte by byte. The
// catalogs of the designs are read so too (`designFiles.ts`); `name` names the file read in what
// is said of one that is not JSON.

const QUOTE = 0x22;
const BACKSLASH = 0x5c;
export const OPEN_OBJECT = 0x7b;
const CLOSE_OBJECT = 0x7d;
const OPEN_ARRAY = 0x5b;
const CLOSE_ARRAY = 0x5d;
const COMMA = 0x2c;
const COLON = 0x3a;

const isSpace = (byte: number) => byte === 0x20 || byte === 0x0a || byte === 0x0d || byte === 0x09;

export function skipSpace(bytes: Uint8Array, at: number) {
  while (at < bytes.length && isSpace(bytes[at]!)) at += 1;
  return at;
}

/** The end of the string that starts at `at` (its opening quote), past its closing quote. */
function endOfString(bytes: Uint8Array, at: number, name: string) {
  for (let i = at + 1; i < bytes.length; i += 1) {
    if (bytes[i] === BACKSLASH) i += 1;
    else if (bytes[i] === QUOTE) return i + 1;
  }
  throw new PublishError(`${name} ends inside a string.`);
}

/** The end of the value that starts at `at`. */
function endOfValue(bytes: Uint8Array, at: number, name: string) {
  const first = bytes[at];
  if (first === QUOTE) return endOfString(bytes, at, name);
  if (first === OPEN_OBJECT || first === OPEN_ARRAY) {
    let depth = 0;
    for (let i = at; i < bytes.length; i += 1) {
      const byte = bytes[i]!;
      if (byte === QUOTE) i = endOfString(bytes, i, name) - 1;
      else if (byte === OPEN_OBJECT || byte === OPEN_ARRAY) depth += 1;
      else if (byte === CLOSE_OBJECT || byte === CLOSE_ARRAY) {
        depth -= 1;
        if (depth === 0) return i + 1;
      }
    }
    throw new PublishError(`${name} ends inside a value.`);
  }
  let i = at;
  while (
    i < bytes.length &&
    ![COMMA, CLOSE_OBJECT, CLOSE_ARRAY].includes(bytes[i]!) &&
    !isSpace(bytes[i]!)
  )
    i += 1;
  return i;
}

export interface Member {
  key: string;
  /** Where its value starts and ends. */
  start: number;
  end: number;
}

/** The members of the object that starts at `at`, and where it closes. */
export function membersOf(
  bytes: Uint8Array,
  at: number,
  name: string,
): { members: Member[]; close: number } {
  if (bytes[at] !== OPEN_OBJECT) {
    throw new PublishError(`${name} is not an object where one is read.`);
  }
  const members: Member[] = [];
  let i = skipSpace(bytes, at + 1);
  if (bytes[i] === CLOSE_OBJECT) return { members, close: i };
  for (;;) {
    if (bytes[i] !== QUOTE) throw new PublishError(`${name} has a member without a name.`);
    const keyEnd = endOfString(bytes, i, name);
    const key = JSON.parse(toText(bytes.subarray(i, keyEnd))) as string;
    i = skipSpace(bytes, keyEnd);
    if (bytes[i] !== COLON) throw new PublishError(`${name} has a member without a value.`);
    const start = skipSpace(bytes, i + 1);
    const end = endOfValue(bytes, start, name);
    members.push({ key, start, end });
    i = skipSpace(bytes, end);
    if (bytes[i] === COMMA) i = skipSpace(bytes, i + 1);
    else if (bytes[i] === CLOSE_OBJECT) return { members, close: i };
    else throw new PublishError(`${name} is not JSON.`);
  }
}

function splice(bytes: Uint8Array, start: number, end: number, insert: string): Uint8Array {
  const middle = toBytes(insert);
  const out = new Uint8Array(bytes.length - (end - start) + middle.length);
  out.set(bytes.subarray(0, start), 0);
  out.set(middle, start);
  out.set(bytes.subarray(end), start + middle.length);
  return out;
}

/** Inserts a member as the last of the object whose closing brace is at `close`. */
const insertMember = (
  bytes: Uint8Array,
  close: number,
  empty: boolean,
  key: string,
  value: unknown,
) =>
  splice(bytes, close, close, `${empty ? '' : ','}${JSON.stringify(key)}:${JSON.stringify(value)}`);

/**
 * The catalog of templates with a template's sample in one language, in place of the one it had
 * (`samples[<template>][<language>]`), its languages in the app's order: as Slidr Studio's
 * `merge_sample` wrote it. Nothing else of the catalog changes, byte for byte.
 */
export function spliceSample(
  catalog: Uint8Array,
  template: string,
  lang: string,
  sample: unknown,
): Uint8Array {
  const root = skipSpace(catalog, 0);
  const top = membersOf(catalog, root, TEMPLATES);
  const samples = top.members.find((member) => member.key === 'samples');
  if (!samples) {
    return insertMember(catalog, top.close, top.members.length === 0, 'samples', {
      [template]: { [lang]: sample },
    });
  }
  const inside = membersOf(catalog, samples.start, TEMPLATES);
  const mine = inside.members.find((member) => member.key === template);
  if (!mine) {
    return insertMember(catalog, inside.close, inside.members.length === 0, template, {
      [lang]: sample,
    });
  }
  const written = JSON.parse(toText(catalog.subarray(mine.start, mine.end))) as unknown;
  const languages: Record<string, unknown> = isRecord(written) ? { ...written } : {};
  languages[lang] = sample;
  return splice(catalog, mine.start, mine.end, JSON.stringify(byLanguage(languages)));
}
