/**
 * The catalog of the designs, `elements/designs/index.json`: every ready-made slide of Elements, in
 * the order the gallery shows them (docs/media-library.md of the app, ADR-118 of the app).
 *
 *   groups       the groups, in order
 *   groupIds     the designs of each group, in order
 *   slides       the slide of each design in each language it is drawn in
 *   subjects     the point of each design's picture where its subject is
 *   names        the name of a design in Hebrew and English, where the app's messages have none
 *   groupNames   the same, of a group
 *
 * Beside it, the size of each picture (`images/designs/sizes.json`) and the search tags of each
 * design (`tags/designs.json`).
 *
 * It is some 54 MB, more than a Worker holds as objects, or twice as bytes: it is read by the
 * structure of its JSON (`merge.ts`), the slides of a design parsed only where they are changed,
 * and written as parts of the bytes it was read from with what changed between them (`parts.ts`).
 *
 * The designs Slidr Studio made were once a catalog of their own, `elements/designs/managed.json`,
 * listed after the others. A library that still has it has it folded in by its next publication
 * (`foldManaged`), as the app listed the two.
 */
import type { Bucket } from '../bucket.ts';
import { isRecord } from '../http.ts';
import type { Draft } from '../uploads/handler.ts';
import { readBytes, toBytes, toText } from './live.ts';
import { MANAGED_IN_LANGUAGE } from './merged.ts';
import {
  OPEN_OBJECT,
  PublishError,
  byLanguage,
  encodeTags,
  inOrder,
  membersOf,
  skipSpace,
  tagsPath,
  type DesignRecord,
  type TagsFile,
} from './merge.ts';
import type { Parts } from './parts.ts';
import type { Writing } from './writing.ts';

export const CATALOG = 'elements/designs/index.json';
/** The catalog of the designs Slidr Studio made, of a library of before. */
export const MANAGED = 'elements/designs/managed.json';
export const SIZES = 'images/designs/sizes.json';
export const DESIGN_TAGS = tagsPath('designs');

type Slides = Record<string, unknown>;

/** Where a member of an object is: its name, and its value. */
interface Place {
  from: number;
  start: number;
  end: number;
}

const isPoint = (value: unknown): value is [number, number] =>
  Array.isArray(value) && value.length === 2 && value.every((n) => typeof n === 'number');

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((one): one is string => typeof one === 'string') : [];

/** The members of a catalog, in the order one it had not is written. */
const MEMBERS = ['groups', 'groupIds', 'slides', 'subjects', 'names', 'groupNames'];

/** A catalog of designs, read by the structure of its JSON, and changed. */
export class DesignCatalog {
  private readonly bytes: Uint8Array;
  /** Its members as read, the slides one of them; and what follows it, a line's end. */
  private readonly top: (Place & { key: string })[];
  private readonly after: Uint8Array;
  /** Each member but the slides, parsed; and as it was read, as JSON. */
  private readonly values = new Map<string, unknown>();
  private readonly read = new Map<string, string>();
  /** Where the slides of each design are, in order. */
  private readonly places = new Map<string, Place>();
  private readonly order: string[] = [];
  /** The slides of each design put in since: parsed, or their bytes in another catalog. */
  private readonly put = new Map<string, Slides | Uint8Array>();

  private constructor(bytes: Uint8Array, name: string) {
    this.bytes = bytes;
    const { members, close } = membersOf(bytes, skipSpace(bytes, 0), name);
    this.top = members;
    this.after = bytes.subarray(close + 1);
    for (const member of members) {
      if (member.key !== 'slides') {
        const value = JSON.parse(toText(bytes.subarray(member.start, member.end))) as unknown;
        this.values.set(member.key, value);
        this.read.set(member.key, JSON.stringify(value));
        continue;
      }
      if (bytes[member.start] !== OPEN_OBJECT) {
        throw new PublishError(`The slides of ${name} are not an object.`);
      }
      for (const design of membersOf(bytes, member.start, name).members) {
        if (!this.places.has(design.key)) this.order.push(design.key);
        this.places.set(design.key, design);
      }
    }
  }

  /** The catalog of `bytes`; an empty one where there are none. */
  static of(bytes: Uint8Array | undefined, name = CATALOG): DesignCatalog {
    return new DesignCatalog(bytes ?? toBytes('{}\n'), name);
  }

  private record<T>(key: string): Record<string, T> {
    let value = this.values.get(key);
    if (!isRecord(value)) this.values.set(key, (value = {}));
    return value as Record<string, T>;
  }

  get groups(): string[] {
    let value = this.values.get('groups');
    if (!Array.isArray(value)) this.values.set('groups', (value = []));
    return value as string[];
  }

  get groupIds() {
    return this.record<unknown>('groupIds');
  }

  get subjects() {
    return this.record<unknown>('subjects');
  }

  get names() {
    return this.record<unknown>('names');
  }

  get groupNames() {
    return this.record<unknown>('groupNames');
  }

  /** Another member, as `sizes` and `tags` of `managed.json`; empty when it has none. */
  member(key: string): Record<string, unknown> {
    const value = this.values.get(key);
    return isRecord(value) ? value : {};
  }

  /** Every design with slides, in the order of the slides. */
  ids(): string[] {
    return [...this.order, ...[...this.put.keys()].filter((id) => !this.places.has(id))];
  }

  has(id: string): boolean {
    return this.places.has(id) || this.put.has(id);
  }

  /** The bytes of a design's slides: as read, or as put. */
  rawSlides(id: string): Uint8Array | undefined {
    const put = this.put.get(id);
    if (put) return put instanceof Uint8Array ? put : toBytes(JSON.stringify(put));
    const place = this.places.get(id);
    return place && this.bytes.subarray(place.start, place.end);
  }

  /** A design's slides, by language. */
  slides(id: string): Slides | undefined {
    const put = this.put.get(id);
    if (put && !(put instanceof Uint8Array)) return put;
    const raw = this.rawSlides(id);
    const value = raw && (JSON.parse(toText(raw)) as unknown);
    return isRecord(value) ? value : undefined;
  }

  /** Puts a design's slides in: parsed, or their bytes as another catalog has them. */
  setSlides(id: string, slides: Slides | Uint8Array) {
    this.put.set(id, slides);
  }

  /**
   * The catalog as it is now, in parts: what did not change, as it was read. A member it had not
   * is written after the others, and none that is empty.
   */
  parts(): Parts {
    const out: Uint8Array[] = [];
    const text = (value: string) => out.push(toBytes(value));
    const keys = this.top.map(({ key }) => key);
    for (const key of [...MEMBERS, ...this.values.keys()]) {
      if (!keys.includes(key)) keys.push(key);
    }
    text('{');
    let first = true;
    for (const key of keys) {
      const place = this.top.find((member) => member.key === key);
      if (key === 'slides') {
        if (!place && this.put.size === 0) continue;
        if (!first) text(',');
        first = false;
        this.slidesInto(out);
        continue;
      }
      if (!this.values.has(key)) continue;
      const now = JSON.stringify(this.values.get(key));
      if (!place && (now === '{}' || now === '[]')) continue;
      if (!first) text(',');
      first = false;
      if (place && now === this.read.get(key)) out.push(this.bytes.subarray(place.from, place.end));
      else text(`${JSON.stringify(key)}:${now}`);
    }
    text('}');
    out.push(this.after.length > 0 ? this.after : toBytes('\n'));
    return out;
  }

  /** The slides, each design that did not change in the bytes it was read in, a run at a time. */
  private slidesInto(out: Uint8Array[]) {
    const text = (value: string) => out.push(toBytes(value));
    let run: [number, number] | undefined;
    let any = false;
    const flush = () => {
      if (!run) return;
      if (any) text(',');
      out.push(this.bytes.subarray(run[0], run[1]));
      any = true;
      run = undefined;
    };
    const own = (id: string, slides: Slides | Uint8Array) => {
      flush();
      if (any) text(',');
      text(`${JSON.stringify(id)}:`);
      if (slides instanceof Uint8Array) out.push(slides);
      else text(JSON.stringify(slides));
      any = true;
    };
    text('"slides":{');
    for (const id of this.order) {
      const put = this.put.get(id);
      if (put) {
        own(id, put);
        continue;
      }
      const place = this.places.get(id)!;
      run = run ? [run[0], place.end] : [place.from, place.end];
    }
    flush();
    for (const [id, slides] of this.put) if (!this.places.has(id)) own(id, slides);
    text('}');
  }
}

/**
 * Puts into `target` the designs of `source` it has not, as the app listed two catalogs: a group
 * `target` has takes them after its own designs; another comes after its groups, in the order
 * `source` has them. A design without slides is left out, as the gallery leaves it out; a group's
 * names go with it where `target` names it not. The ids it put in.
 */
export function appendDesigns(target: DesignCatalog, source: DesignCatalog): string[] {
  const added = new Set<string>();
  for (const group of new Set(strings(source.groups))) {
    const mine: string[] = [];
    for (const id of strings(source.groupIds[group])) {
      if (target.has(id) || added.has(id)) continue;
      const raw = source.rawSlides(id);
      if (raw?.[0] !== OPEN_OBJECT) continue;
      target.setSlides(id, raw);
      const subject = source.subjects[id];
      if (isPoint(subject)) target.subjects[id] = subject;
      const name = source.names[id];
      if (isRecord(name)) target.names[id] = name;
      mine.push(id);
      added.add(id);
    }
    if (mine.length === 0) continue;
    if (!target.groups.includes(group)) target.groups.push(group);
    target.groupIds[group] = [...strings(target.groupIds[group]), ...mine];
  }
  for (const [group, names] of Object.entries(source.groupNames)) {
    if (target.groups.includes(group) && isRecord(names) && !isRecord(target.groupNames[group])) {
      target.groupNames[group] = names;
    }
  }
  return [...added];
}

/**
 * Puts a design into the catalog, in place when it is there, as Slidr Studio's own publication did
 * (`merge_design` of its `library.py`): a design has one group, a group it is the first of is
 * named as the upload names it, and a group left without designs goes.
 */
export function putDesign(catalog: DesignCatalog, design: DesignRecord) {
  const { id, group } = design;
  const groups = catalog.groups;
  if (!groups.includes(group)) {
    groups.push(group);
    if (!isRecord(catalog.groupNames[group])) {
      catalog.groupNames[group] = design.groupName ?? { he: group, en: group };
    }
  }
  for (const [other, ids] of Object.entries(catalog.groupIds)) {
    if (other !== group && Array.isArray(ids) && ids.includes(id)) ids.splice(ids.indexOf(id), 1);
  }
  const ids = strings(catalog.groupIds[group]);
  if (!ids.includes(id)) ids.push(id);
  catalog.groupIds[group] = ids;
  catalog.setSlides(id, design.slides);
  catalog.subjects[id] = design.subject;
  catalog.names[id] = design.name;
  for (const empty of groups.filter((one) => strings(catalog.groupIds[one]).length === 0)) {
    groups.splice(groups.indexOf(empty), 1);
    delete catalog.groupIds[empty];
    delete catalog.groupNames[empty];
  }
}

/**
 * Puts the slides of an upload of `designs: translate` beside those its design has, in the app's
 * order of languages. The languages it wrote.
 */
export function putTranslation(
  catalog: DesignCatalog,
  id: string,
  languages: Draft['languages'],
): string[] {
  const slides = catalog.slides(id);
  if (!slides) throw new PublishError(`The catalog of the designs has no design ${id}.`);
  const written = Object.entries(languages)
    .filter(([, content]) => isRecord(content) && content.slide)
    .map(([lang]) => lang);
  if (written.length === 0) throw new PublishError(`The translation of ${id} holds no slide.`);
  const mine: Slides = { ...slides };
  for (const lang of written) {
    mine[lang] = (languages as Record<string, { slide: unknown }>)[lang]!.slide;
  }
  catalog.setSlides(id, byLanguage(mine));
  return inOrder(written);
}

/* ---------------------------------------------------------------- beside the catalog */

/** `images/designs/sizes.json`: the width and height of each picture, by its name. */
export type Sizes = Record<string, [number, number]>;

export const encodeSizes = (sizes: Sizes) => `${JSON.stringify(sizes, null, 2)}\n`;

export const sizesOf = (file: unknown): Sizes =>
  isRecord(file)
    ? (Object.fromEntries(Object.entries(file).filter(([, size]) => isPoint(size))) as Sizes)
    : {};

/** The tags of a file of tags, by item; none where it is none. */
export const tagsOf = (file: unknown): TagsFile['tags'] =>
  isRecord(file) && isRecord(file.tags) ? { ...(file.tags as TagsFile['tags']) } : {};

/**
 * The file of the designs' tags with a design's tags in the languages given, in place of those it
 * had in them; its others stay.
 */
export function putDesignTags(
  file: unknown,
  id: string,
  given: Record<string, string[]>,
): TagsFile {
  const tags = tagsOf(file);
  const had = isRecord(tags[id]) ? tags[id] : {};
  tags[id] = byLanguage({ ...had, ...given });
  return { version: 1, tags };
}

/* ---------------------------------------------------------------- the catalog of before */

/** A JSON file of the library as the publication leaves it; none where it has none. */
export async function readJson(media: Bucket, writing: Writing, path: string): Promise<unknown> {
  if (!writing.hashOf(path)) return undefined;
  const bytes = await readBytes(media, path);
  return bytes && (JSON.parse(toText(bytes)) as unknown);
}

/**
 * The sizes of the pictures with those `managed.json` gave the designs of Slidr Studio; none where
 * it gave none.
 */
export function foldSizes(file: unknown, managed: DesignCatalog): Sizes | undefined {
  const theirs = sizesOf(managed.member('sizes'));
  if (Object.keys(theirs).length === 0) return undefined;
  const sizes = sizesOf(file);
  for (const [name, size] of Object.entries(theirs)) sizes[name] ??= size;
  return sizes;
}

/**
 * The tags of the designs with those `managed.json` gave the designs of Slidr Studio, each beside
 * the tags given it in the file, as the app read the two; none where it gave none.
 */
export function foldTags(file: unknown, managed: DesignCatalog): TagsFile | undefined {
  const own = managed.member('tags');
  if (Object.keys(own).length === 0) return undefined;
  const tags = tagsOf(file);
  for (const [id, given] of Object.entries(own)) {
    if (!isRecord(given)) continue;
    const listed: Record<string, unknown> = isRecord(tags[id]) ? tags[id] : {};
    const both = inOrder(new Set([...Object.keys(given), ...Object.keys(listed)]));
    tags[id] = Object.fromEntries(
      both.map((lang) => [lang, [...new Set([...strings(given[lang]), ...strings(listed[lang])])]]),
    );
  }
  return { version: 1, tags };
}

/**
 * Folds `managed.json`, the catalog of the designs Slidr Studio made, into the catalog of the
 * designs (ADR-118 of the app): its designs after the others, as the app listed them; the sizes of
 * their pictures into `images/designs/sizes.json`, and their tags into `tags/designs.json`. Then
 * it goes, with its files of each language. Whether the library had it.
 */
export async function foldManaged(media: Bucket, writing: Writing): Promise<boolean> {
  if (!writing.hashOf(MANAGED)) return false;
  const managed = DesignCatalog.of(await readBytes(media, MANAGED), MANAGED);
  const catalog = DesignCatalog.of(
    writing.hashOf(CATALOG) ? await readBytes(media, CATALOG) : undefined,
  );
  appendDesigns(catalog, managed);
  await writing.put(CATALOG, catalog.parts());
  const sizes = foldSizes(await readJson(media, writing, SIZES), managed);
  if (sizes) await writing.put(SIZES, toBytes(encodeSizes(sizes)));
  const tags = foldTags(await readJson(media, writing, DESIGN_TAGS), managed);
  if (tags) await writing.put(DESIGN_TAGS, toBytes(encodeTags(tags)));
  await writing.remove(MANAGED);
  for (const path of writing.paths()) {
    if (MANAGED_IN_LANGUAGE.test(path)) await writing.remove(path);
  }
  return true;
}
