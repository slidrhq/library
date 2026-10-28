/**
 * The files a publication writes of the catalog of the designs, beside it (ADR-109 of the app):
 *
 *   elements/designs/<language>/index.json    the catalog with the slides of one language alone,
 *                                             the languages each design is drawn in, and the hash
 *                                             of the catalog it was made from (`from`)
 *   elements/designs/revs.json                the word of each design in each language, of its
 *                                             slide and its pictures, and what it was made from
 *   images/designs/thumbs/index.json          the word each picture made ahead was drawn from
 *
 * A gallery reads the designs of its language, and shows the picture made ahead of a design while
 * the design has the word that picture was drawn from (the app's `designWord.ts`, which makes the
 * words here too). An app takes none of these files when they are of another library than the
 * one it reads: so every publication that changes a catalog, or a picture of a design, writes them
 * again, and a publication of no upload (**Bring the designs up to date** of the page) writes them
 * when they are of another one. A design uploaded with the pictures made of it
 * (`thumb-<language>`, drawn by Slidr Studio as the app draws it) has them at once; a design
 * without, or changed since, is drawn live, alone.
 *
 * The catalog is some 54 MB, more than a Worker can hold as objects: it is read by the structure of
 * its JSON (`merge.ts`), a slide at a time, and a catalog the last words were made of, with the
 * pictures of its designs, is not read at all.
 */
import {
  designDrawing,
  designPicturePaths,
  designWord,
} from '../../../vendor/desktop/src/elements/designWord.ts';
import type { Bucket } from '../bucket.ts';
import { isRecord } from '../http.ts';
import { readBytes, toBytes, toText } from './live.ts';
import { OPEN_OBJECT, membersOf, skipSpace } from './merge.ts';
import type { Writing } from './writing.ts';

const DESIGNS = 'elements/designs';
/** The catalog (`designCatalog.ts`). */
const CATALOGS = ['index.json'] as const;
export const REVS = `${DESIGNS}/revs.json`;
export const THUMBS = 'images/designs/thumbs/index.json';
/** The size of a picture made ahead of a design (ADR-111 of the app). */
export const THUMB_WIDTH = 320;
export const THUMB_HEIGHT = 180;

export const thumbPath = (lang: string, id: string) =>
  `images/designs/thumbs/${THUMB_WIDTH}/${lang}/${id}.webp`;

/** A key of a catalog's slides that names a language: `he`, `pt-BR`, `zh-CN`. */
const LANGUAGE = /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,4})?$/;

/** `revs.json`. */
interface Revs {
  /** The hash of each file the words were made of: the catalogs, and the designs' pictures. */
  from: Record<string, string>;
  /** By language, then by design. */
  designs: Record<string, Record<string, string>>;
  /**
   * The designs the catalog gave words, in its order; written since the library writes them. Each
   * of two catalogs, of a library of before: Slidr Studio reads it to know where a design is.
   */
  catalogs?: Record<string, string[]>;
}

/** `images/designs/thumbs/index.json`. */
interface ThumbsIndex {
  widths: number[];
  /** By language, then by design: the word each picture was drawn from. */
  designs: Record<string, Record<string, string>>;
}

/**
 * The pictures made ahead a publication wrote: of each design, its languages, each with the word
 * of the slide it was drawn of; none where it was drawn of the slide published with it.
 */
export type Drawn = Map<string, Map<string, string | undefined>>;

/** A catalog of designs as the structure of its JSON says it, without reading it as objects. */
interface Catalog {
  bytes: Uint8Array;
  /** Its members but its slides, as compact JSON, by their names; `slides` where they stand. */
  members: (string | { slides: true })[];
  /** Each design whose slides are an object, in order, with where the slide of each language is. */
  designs: { id: string; slides: Map<string, [number, number]> }[];
}

/** What is made of the slides, not part of a catalog: the reader writes it. */
const OWN = ['languages', 'from'];

function catalogOf(bytes: Uint8Array, name: string): Catalog {
  const top = membersOf(bytes, skipSpace(bytes, 0), name);
  const members: Catalog['members'] = [];
  const designs: Catalog['designs'] = [];
  for (const member of top.members) {
    if (OWN.includes(member.key)) continue;
    if (member.key !== 'slides') {
      const value = JSON.parse(toText(bytes.subarray(member.start, member.end))) as unknown;
      members.push(`${JSON.stringify(member.key)}:${JSON.stringify(value)}`);
      continue;
    }
    members.push({ slides: true });
    if (bytes[member.start] !== OPEN_OBJECT) continue;
    for (const design of membersOf(bytes, member.start, name).members) {
      if (bytes[design.start] !== OPEN_OBJECT) continue;
      const slides = new Map<string, [number, number]>();
      for (const slide of membersOf(bytes, design.start, name).members) {
        if (LANGUAGE.test(slide.key)) slides.set(slide.key, [slide.start, slide.end]);
      }
      designs.push({ id: design.key, slides });
    }
  }
  if (!members.some((member) => typeof member !== 'string')) members.push({ slides: true });
  return { bytes, members, designs };
}

const slideOf = (catalog: Catalog, [start, end]: [number, number]) =>
  JSON.parse(toText(catalog.bytes.subarray(start, end))) as unknown;

async function readJson<T>(media: Bucket, writing: Writing, path: string): Promise<T | undefined> {
  if (!writing.hashOf(path)) return undefined;
  const bytes = await readBytes(media, path);
  if (!bytes) return undefined;
  try {
    return JSON.parse(toText(bytes)) as T;
  } catch {
    return undefined;
  }
}

/** The last words written, when they are words. */
function revsOf(value: unknown): Revs | undefined {
  if (!isRecord(value) || !isRecord(value.from) || !isRecord(value.designs)) return undefined;
  return value as unknown as Revs;
}

/**
 * Writes the files made of the catalogs of the designs, as `writing` leaves the library, wherever
 * they are not of it; and the word of each picture made ahead in `drawn` into the index of them.
 */
export async function writeDesignFiles(media: Bucket, writing: Writing, drawn: Drawn = new Map()) {
  const catalogs = CATALOGS.map((name) => {
    const path = `${DESIGNS}/${name}`;
    return { name, path, hash: writing.hashOf(path) };
  });
  if (catalogs.every(({ hash }) => !hash) && !writing.hashOf(REVS)) return;
  const last = revsOf(await readJson(media, writing, REVS));
  const pictureHash = (path: string) => writing.hashOf(path) ?? null;

  /** The designs whose words `last` holds of a catalog as it is, with their pictures as they are. */
  const kept = (path: string, hash: string | undefined, ids: readonly string[] | undefined) =>
    last &&
    hash &&
    last.from[path] === hash &&
    ids?.every((id) =>
      designPicturePaths(id).every(
        (picture) => (last.from[picture] ?? null) === pictureHash(picture),
      ),
    )
      ? ids
      : undefined;

  // Words written before the library wrote them name no catalog: they are of the one there is.
  const read = new Map<string, Catalog>();
  const ids = new Map<string, readonly string[]>();
  for (const catalog of catalogs) {
    if (!catalog.hash) continue;
    let known = last?.catalogs?.[catalog.path];
    if (!known && last && Object.keys(last.catalogs ?? {}).length === 0) {
      known = [
        ...new Set(Object.values(last.designs).flatMap((words) => Object.keys(words))),
      ].sort();
    }
    const same = kept(catalog.path, catalog.hash, known);
    if (same) {
      ids.set(catalog.path, same);
      continue;
    }
    const bytes = await readBytes(media, catalog.path);
    if (!bytes) continue;
    const walked = catalogOf(bytes, catalog.path);
    read.set(catalog.path, walked);
    ids.set(
      catalog.path,
      walked.designs.map(({ id }) => id),
    );
  }

  const revs: Revs = { from: {}, designs: {}, catalogs: {} };
  const listed = new Set<string>();
  for (const { name, path, hash } of catalogs) {
    const walked = read.get(path);
    // A catalog the library no longer has, or that changed, leaves no file of a language behind.
    const languages = new Set(walked?.designs.flatMap(({ slides }) => [...slides.keys()]));
    for (const other of writing.paths()) {
      const lang = languageOf(other, name);
      if (lang && (!hash || (walked && !languages.has(lang)))) await writing.remove(other);
    }
    if (!hash || !ids.has(path)) continue;
    revs.from[path] = hash;
    const own: string[] = [];
    for (const id of ids.get(path)!) {
      if (listed.has(id)) continue;
      listed.add(id);
      own.push(id);
      for (const picture of designPicturePaths(id)) {
        const pictureOf = pictureHash(picture);
        if (pictureOf) revs.from[picture] = pictureOf;
      }
    }
    revs.catalogs![path] = own;
    if (!walked) {
      for (const [lang, words] of Object.entries(last!.designs)) {
        for (const id of own) {
          if (words[id]) (revs.designs[lang] ??= {})[id] = words[id];
        }
      }
      continue;
    }
    await writeLanguages(walked, { name, path, hash }, new Set(own), revs, pictureHash, writing);
  }

  // Written as it was, it is left as it is.
  await writing.put(REVS, toBytes(JSON.stringify(revs)));
  if ([...drawn.values()].some((languages) => languages.size > 0)) {
    await writeThumbs(media, writing, drawn, revs);
  }
}

/**
 * The catalog in each of its languages, and the words of the designs that are its own (`mine`):
 * a slide at a time, each language once.
 */
async function writeLanguages(
  catalog: Catalog,
  { name, path, hash }: { name: string; path: string; hash: string },
  mine: ReadonlySet<string>,
  revs: Revs,
  pictureHash: (path: string) => string | null,
  writing: Writing,
) {
  const tail = tailOf(catalog, path, hash);
  for (const lang of languagesOf(catalog)) {
    const { bytes, slides } = inLanguage(catalog, lang, tail);
    for (const { id, slide } of slides) {
      if (!mine.has(id)) continue;
      const pictures = designPicturePaths(id).map(pictureHash);
      (revs.designs[lang] ??= {})[id] = await designWord(designDrawing(slide, pictures));
    }
    await writing.put(`${DESIGNS}/${lang}/${name}`, bytes);
  }
}

/** The language of a catalog's file of one language (`elements/designs/fr/index.json`); none for another file. */
function languageOf(path: string, name: string): string | undefined {
  if (!path.startsWith(`${DESIGNS}/`) || !path.endsWith(`/${name}`)) return undefined;
  const lang = path.slice(DESIGNS.length + 1, -name.length - 1);
  return LANGUAGE.test(lang) ? lang : undefined;
}

/** The languages a catalog's slides are written in. */
const languagesOf = (catalog: Catalog) => [
  ...new Set(catalog.designs.flatMap(({ slides }) => [...slides.keys()])),
];

/** What follows the slides in each language: the languages of each design, and the catalog's hash. */
function tailOf(catalog: Catalog, path: string, hash: string) {
  const drawnIn = Object.fromEntries(
    catalog.designs.map(({ id, slides }) => [id, [...slides.keys()]]),
  );
  return `,"languages":${JSON.stringify(drawnIn)},"from":${JSON.stringify({ [path]: hash })}}`;
}

/** The catalog with the slides of one language alone, as a gallery in it reads it; and the slides. */
function inLanguage(catalog: Catalog, lang: string, tail: string) {
  const slides: string[] = [];
  const read: { id: string; slide: unknown }[] = [];
  for (const { id, slides: places } of catalog.designs) {
    const place = places.get(lang);
    if (!place) continue;
    const slide = slideOf(catalog, place);
    slides.push(`${JSON.stringify(id)}:${JSON.stringify({ [lang]: slide })}`);
    read.push({ id, slide });
  }
  const members = catalog.members.map((member) =>
    typeof member === 'string' ? member : `"slides":{${slides.join(',')}}`,
  );
  return { bytes: toBytes(`{${members.join(',')}${tail}`), slides: read };
}

/** The hash of each catalog a file of one language was made of (its `from`, written last). */
function madeOf(bytes: Uint8Array): Record<string, string> | undefined {
  const end = /"from":(\{[^{}]*\})\}\s*$/.exec(toText(bytes.subarray(-1024)));
  try {
    const from: unknown = end
      ? JSON.parse(end[1]!)
      : (JSON.parse(toText(bytes)) as { from?: unknown }).from;
    return isRecord(from) ? (from as Record<string, string>) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Writes again each file of a language the library has whose catalog changed since it was made:
 * an archive that brought the catalogs in with some of their languages only leaves the others so
 * (`archive.ts`), and a gallery takes no file of another catalog. The words of the designs are of
 * the catalogs (`revs.json`), and stay. Answers the files it wrote, or took away where the catalog
 * no longer has their language.
 */
export async function refreshLanguages(media: Bucket, writing: Writing): Promise<string[]> {
  const refreshed: string[] = [];
  for (const name of CATALOGS) {
    const path = `${DESIGNS}/${name}`;
    const hash = writing.hashOf(path);
    if (!hash) continue;
    const stale: string[] = [];
    for (const other of writing.paths()) {
      const lang = languageOf(other, name);
      if (!lang) continue;
      const bytes = await readBytes(media, other);
      if (!bytes || madeOf(bytes)?.[path] !== hash) stale.push(lang);
    }
    if (stale.length === 0) continue;
    const bytes = await readBytes(media, path);
    if (!bytes) continue;
    const catalog = catalogOf(bytes, path);
    const tail = tailOf(catalog, path, hash);
    const written = new Set(languagesOf(catalog));
    for (const lang of stale.sort()) {
      const target = `${DESIGNS}/${lang}/${name}`;
      if (written.has(lang)) await writing.put(target, inLanguage(catalog, lang, tail).bytes);
      else await writing.remove(target);
      refreshed.push(target);
    }
  }
  return refreshed;
}

/** The word of each picture made ahead that `drawn` names, as its design is now. */
async function writeThumbs(media: Bucket, writing: Writing, drawn: Drawn, revs: Revs) {
  const read = await readJson<Partial<ThumbsIndex>>(media, writing, THUMBS);
  const index: ThumbsIndex = {
    widths: Array.isArray(read?.widths) ? read.widths : [THUMB_WIDTH],
    designs: isRecord(read?.designs) ? read.designs : {},
  };
  for (const [id, languages] of drawn) {
    for (const [lang, of] of languages) {
      // A picture of a slide changed since it was drawn is not of the slide: it is drawn live.
      const word = revs.designs[lang]?.[id];
      const words = (index.designs[lang] ??= {});
      if (word && (of === undefined || of === word)) words[id] = word;
      else delete words[id];
    }
  }
  await writing.put(THUMBS, toBytes(`${JSON.stringify(index, null, 2)}\n`));
}
