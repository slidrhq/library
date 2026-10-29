/**
 * What the page exports of the library (`Export.tsx`): its parts as the overview names them
 * (`sections.ts`), each with the search tags of its kind (`tags/<kind>.json`), in the languages
 * chosen; and, of three of them, smaller pieces to choose among.
 *
 * The languages are chosen for the whole library, where the app does without the others:
 *
 * - a gallery reads the designs of its own language (`elements/designs/<language>/`) and their
 *   pictures made ahead (`images/designs/thumbs/<width>/<language>/`), and a language without
 *   them offers none;
 * - a magnet of the frames has its picture made ahead in Hebrew, and in English for every other
 *   language (`images/frames/<he|en>/`, `frameThumbs.ts`);
 * - a deck offers the fonts of its language and of English: a family made for other letters than
 *   Latin (`for`, `fonts/catalog.json`) goes with a language written in them, and one made for
 *   Latin letters always.
 *
 * The pieces are the groups the app shows a part by:
 *
 * - **the designs**, by the groups of their catalog: each design's pictures, and the pictures made
 *   of it ahead;
 * - **the frames**, by the groups of theirs: the pictures of a magnet made ahead;
 * - **the templates**, one by one (`templates/<id>/`, and its photographs): a template whose file
 *   is not there is left out (`builtIn.ts` of the app); and the reference decks, which no app reads.
 *
 * Of the designs and the frames, the catalogs that name every item (`cut`) are written again with
 * the items of the groups chosen alone, when some only are (`exportCut.ts`): a design the catalog
 * named without its pictures would be drawn without them. A library that brings the archive in
 * merges them into its own a design and a frame at a time, so what it has of the others stays.
 * What every piece of a part needs goes with any of them, and the other parts go whole: the
 * icons' search reads both sets at once, and a style of graphics draws from several art sets.
 *
 * What was chosen is kept in a cookie of this browser, for the next export.
 */
import { CONTENT_LANGUAGES, LANGUAGE_SCRIPT, type ContentLanguage } from '@slidr/model';
import type { Manifest } from './media';
import { SECTIONS, inSection } from './sections';

/** A piece of a part, to be chosen apart from the others. */
export interface Piece {
  id: string;
  /** Its files, of every language or of some (`LanguagesOf`). */
  paths: string[];
  /** The items of the part's catalogs it is: what they keep of it when they are written again. */
  items: string[];
  /** How much of the catalogs it is, to others of its part: by its items, unless it says. */
  weight: number;
}

export interface Part {
  /** A section of `sections.ts`, or `other`. */
  id: string;
  /** What goes with any of its pieces; all of it, where it has none. */
  core: string[];
  pieces: Piece[];
  /** The catalogs that name the items of every piece: written again when some pieces only are. */
  cut: string[];
  /** Every file of it, in every language. */
  paths: string[];
}

/** The files of no part: what the library holds that the page does not show. */
export const OTHER = 'other';
/** The reference decks of the templates. */
export const REFERENCE_DECKS = 'reference-decks';

export const FRAMES_CATALOG = 'elements/catalogs/frames-catalog.json';

/** The kinds whose search tags are a file of their own (ADR-108 of the app). */
const TAGGED = new Set(['designs', 'cards', 'frames', 'shapes', 'graphics', 'emoji', 'icons']);

/** Of the fonts catalog, what says which family is made for which letters, and where its files are. */
export interface FontsCatalog {
  families?: { family: string; for?: string[]; scripts?: string[] }[];
  faces?: { family: string; path: string }[];
}

/**
 * The groups of a part's catalog, in their order, each with the ids of its items, and how much of
 * the catalog it is where its items are not alike (a magnet of the frames is a hundred others).
 */
export type Groups = readonly { id: string; items: readonly string[]; weight?: number }[];

/** What the page reads of the catalogs, to know the pieces and the languages by. */
export interface Catalogs {
  fonts?: FontsCatalog;
  designs?: Groups;
  frames?: Groups;
}

function partOf(path: string): string {
  const tags = /^tags\/([^/]+)\.json$/.exec(path)?.[1];
  if (tags && TAGGED.has(tags)) return tags;
  const section = SECTIONS.find((one) => one.id !== 'files' && inSection(one, path));
  return section?.id ?? OTHER;
}

// ---- The languages

/** The languages a file is of: it goes when one of them is chosen. Undefined: of every language. */
export type LanguagesOf = (path: string) => readonly string[] | undefined;

const BUT_HEBREW = CONTENT_LANGUAGES.filter((lang) => lang !== 'he');

/** The languages written in the letters a family of fonts is made for. */
const writtenIn = (script: string) =>
  CONTENT_LANGUAGES.filter((lang) => LANGUAGE_SCRIPT[lang] === script);

export function languagesOf(fonts?: FontsCatalog): LanguagesOf {
  const made = new Map(
    (fonts?.families ?? []).map(({ family, for: madeFor, scripts }) => [
      family,
      madeFor?.length ? madeFor : (scripts ?? []).slice(0, 1),
    ]),
  );
  const folders = new Map<string, readonly string[] | undefined>();
  for (const face of fonts?.faces ?? []) {
    const folder = /^fonts\/([^/]+)\//.exec(face.path)?.[1];
    if (!folder || folders.has(folder)) continue;
    const scripts = made.get(face.family) ?? [];
    // A family for Latin letters is a deck's in any language; one for none known, too.
    const latin = scripts.length === 0 || scripts.includes('latin');
    folders.set(folder, latin ? undefined : scripts.flatMap(writtenIn));
  }
  return (path) => {
    const design =
      /^elements\/designs\/([^/]+)\//.exec(path)?.[1] ??
      /^images\/designs\/thumbs\/\d+\/([^/]+)\//.exec(path)?.[1];
    if (design) return [design];
    const frame = /^images\/frames\/([^/]+)\//.exec(path)?.[1];
    if (frame) return frame === 'en' ? BUT_HEBREW : [frame];
    const font = /^fonts\/([^/]+)\//.exec(path)?.[1];
    return font ? folders.get(font) : undefined;
  };
}

/** The languages the library has files of their own in, in the order they are offered. */
export function languagesIn(manifest: Manifest, of: LanguagesOf): ContentLanguage[] {
  const found = new Set<string>();
  for (const path of Object.keys(manifest.files)) {
    for (const lang of of(path) ?? []) found.add(lang);
  }
  return CONTENT_LANGUAGES.filter((lang) => found.has(lang));
}

/** The languages chosen: every one, those the library has later included (`*`); or some. */
export type Languages = '*' | string[];

/** Whether a file of these languages goes in the languages chosen. */
export const inLanguages = (languages: Languages, of: readonly string[] | undefined) =>
  of === undefined || languages === '*' || of.some((lang) => languages.includes(lang));

/** Chooses a language, or leaves it out: every one the library has chosen is all of them. */
export function chooseLanguage(
  languages: Languages,
  offered: readonly string[],
  lang: string,
  on: boolean,
): Languages {
  const now = new Set(languages === '*' ? offered : languages);
  if (on) now.add(lang);
  else now.delete(lang);
  return offered.every((one) => now.has(one)) ? '*' : offered.filter((one) => now.has(one));
}

// ---- The parts and their pieces

/** The item of a part a file is of: a design or a frame, by its id; none for another file. */
type ItemOf = (path: string) => string | undefined;

const designItem: ItemOf = (path) =>
  /^images\/designs\/thumbs\/\d+\/[^/]+\/(.+)\.webp$/.exec(path)?.[1] ??
  /^images\/designs\/([^/]+?)(?:-bg)?\.webp$/.exec(path)?.[1];

const frameItem: ItemOf = (path) => /^images\/frames\/[^/]+\/(.+)\.webp$/.exec(path)?.[1];

/** Whether a file is a catalog that names every design: what is made of it too. */
const isDesignCatalog = (path: string) =>
  /^elements\/designs\/.+\.json$/.test(path) ||
  path === 'images/designs/sizes.json' ||
  path === 'images/designs/thumbs/index.json' ||
  path === 'tags/designs.json';

const isFrameCatalog = (path: string) => path === FRAMES_CATALOG || path === 'tags/frames.json';

/** How a part is split: its pieces, and the catalogs written again with some of them. */
interface Split {
  pieces: Piece[];
  isCut: (path: string) => boolean;
  pieceOf: (path: string) => Piece | undefined;
}

/** The pieces of a part by the groups of its catalog: each with the files of its items. */
function byGroups(
  groups: Groups | undefined,
  itemOf: ItemOf,
  isCatalog: (path: string) => boolean,
): Split {
  const pieces = (groups ?? []).map(({ id, items, weight }): Piece => ({
    id,
    paths: [],
    items: [...items],
    weight: weight ?? items.length,
  }));
  const of = new Map<string, Piece>();
  for (const piece of pieces)
    for (const item of piece.items) if (!of.has(item)) of.set(item, piece);
  return {
    pieces,
    isCut: (path: string) => of.size > 0 && isCatalog(path),
    pieceOf: (path: string) => {
      const item = itemOf(path);
      return item === undefined ? undefined : of.get(item);
    },
  };
}

function templatePieces(ids: readonly string[]): Split & { found: () => Piece[] } {
  // The longest id first: a photograph is named by its template's id, then a dash.
  const longest = [...ids].sort((a, b) => b.length - a.length);
  const pieces = new Map<string, Piece>();
  const idOf = (path: string) => {
    if (path.startsWith(`templates/${REFERENCE_DECKS}/`)) return REFERENCE_DECKS;
    const folder = /^templates\/([^/]+)\//.exec(path)?.[1];
    if (folder) return ids.includes(folder) ? folder : undefined;
    const picture = /^images\/templates\/([^/]+)$/.exec(path)?.[1];
    return picture ? longest.find((one) => picture.startsWith(`${one}-`)) : undefined;
  };
  return {
    pieces: [],
    isCut: () => false,
    pieceOf: (path: string) => {
      const id = idOf(path);
      if (id === undefined) return undefined;
      let piece = pieces.get(id);
      if (!piece) pieces.set(id, (piece = { id, paths: [], items: [], weight: 0 }));
      return piece;
    },
    found: () => [...pieces.values()],
  };
}

/** The parts of a library, and the pieces of those that have them. */
export function partsOf(manifest: Manifest, catalogs: Catalogs = {}): Part[] {
  const templates = Object.keys(manifest.files)
    .map((path) => /^templates\/([^/]+)\/template\.json$/.exec(path)?.[1])
    .filter((id): id is string => id !== undefined && id !== REFERENCE_DECKS);
  const ofTemplates = templatePieces(templates);
  const split: Record<string, Split> = {
    designs: byGroups(catalogs.designs, designItem, isDesignCatalog),
    frames: byGroups(catalogs.frames, frameItem, isFrameCatalog),
    templates: ofTemplates,
  };
  const parts = new Map<string, Part>();
  for (const path of Object.keys(manifest.files)) {
    const id = partOf(path);
    let part = parts.get(id);
    if (!part) {
      part = { id, core: [], pieces: split[id]?.pieces ?? [], cut: [], paths: [] };
      parts.set(id, part);
    }
    part.paths.push(path);
    const of = split[id];
    if (of?.isCut(path)) {
      part.cut.push(path);
      continue;
    }
    const piece = of?.pieceOf(path);
    if (piece) piece.paths.push(path);
    else part.core.push(path);
  }
  const templatesPart = parts.get('templates');
  if (templatesPart) templatesPart.pieces = ofTemplates.found();
  const rank = (id: string) => {
    const at = SECTIONS.findIndex((section) => section.id === id);
    return at === -1 ? SECTIONS.length : at;
  };
  return [...parts.values()].sort((a, b) => rank(a.id) - rank(b.id));
}

/**
 * What is chosen: everything, the library's parts to come included (`*`); or each part chosen,
 * whole (`*`, its pieces to come included) or some of its pieces.
 */
export type Chosen = '*' | Record<string, '*' | string[]>;

const expand = (chosen: Chosen, parts: readonly Part[]): Record<string, '*' | string[]> =>
  chosen === '*' ? Object.fromEntries(parts.map((part) => [part.id, '*'])) : { ...chosen };

const settle = (next: Record<string, '*' | string[]>, parts: readonly Part[]): Chosen =>
  parts.length > 0 && parts.every((part) => next[part.id] === '*') ? '*' : next;

/** Whether a piece of a part is chosen. */
export function isChosen(chosen: Chosen, part: Part, piece: Piece): boolean {
  if (chosen === '*') return true;
  const of = chosen[part.id];
  return of === '*' || (Array.isArray(of) && of.includes(piece.id));
}

/** How much of a part is chosen. */
export function stateOf(chosen: Chosen, part: Part): 'all' | 'some' | 'none' {
  if (chosen === '*' || chosen[part.id] === '*') return 'all';
  if (!chosen[part.id]) return 'none';
  const some = part.pieces.filter((piece) => isChosen(chosen, part, piece)).length;
  return some === 0 ? 'none' : some === part.pieces.length ? 'all' : 'some';
}

/** Chooses a part whole, or none of it. */
export function choosePart(chosen: Chosen, parts: readonly Part[], part: Part, on: boolean) {
  const next = expand(chosen, parts);
  if (on) next[part.id] = '*';
  else delete next[part.id];
  return settle(next, parts);
}

/** Chooses a piece of a part, or leaves it out: a part none of whose pieces is chosen is not. */
export function choosePiece(
  chosen: Chosen,
  parts: readonly Part[],
  part: Part,
  piece: Piece,
  on: boolean,
) {
  const next = expand(chosen, parts);
  const ids = new Set(
    part.pieces.filter((one) => isChosen(chosen, part, one)).map((one) => one.id),
  );
  if (on) ids.add(piece.id);
  else ids.delete(piece.id);
  if (ids.size === 0) delete next[part.id];
  else if (ids.size === part.pieces.length) next[part.id] = '*';
  else next[part.id] = part.pieces.filter((one) => ids.has(one.id)).map((one) => one.id);
  return settle(next, parts);
}

/** Everything, or nothing. */
export const chooseAll = (on: boolean): Chosen => (on ? '*' : {});

/** What an archive of a choice holds. */
export interface Choice {
  /** The files, in order, but the archive's manifest. */
  paths: string[];
  /** The catalogs written again, each with the items of the pieces chosen that it keeps. */
  cut: Map<string, ReadonlySet<string>>;
  /** Of each catalog written again, about how much of it the pieces chosen are. */
  share: Map<string, number>;
}

/** The files chosen of the parts, in the languages chosen. */
export function chosenOf(
  parts: readonly Part[],
  chosen: Chosen,
  languages: Languages,
  of: LanguagesOf,
): Choice {
  const paths = new Set<string>();
  const cut = new Map<string, ReadonlySet<string>>();
  const share = new Map<string, number>();
  const add = (path: string) => {
    if (inLanguages(languages, of(path))) paths.add(path);
  };
  for (const part of parts) {
    const state = stateOf(chosen, part);
    if (state === 'none') continue;
    part.core.forEach(add);
    part.cut.forEach(add);
    const items = new Set<string>();
    let weight = 0;
    for (const piece of part.pieces) {
      if (!isChosen(chosen, part, piece)) continue;
      piece.paths.forEach(add);
      for (const item of piece.items) items.add(item);
      weight += piece.weight;
    }
    if (state !== 'some') continue;
    const all = part.pieces.reduce((sum, piece) => sum + piece.weight, 0);
    for (const path of part.cut) {
      if (!paths.has(path)) continue;
      cut.set(path, items);
      share.set(path, all > 0 ? weight / all : 1);
    }
  }
  return { paths: [...paths].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)), cut, share };
}

/** About how many bytes a choice is: a catalog written again by the share of it it keeps. */
export function bytesOf(manifest: Manifest, choice: Choice): number {
  let bytes = 0;
  for (const path of choice.paths) {
    bytes += (manifest.files[path]?.size ?? 0) * (choice.share.get(path) ?? 1);
  }
  return Math.round(bytes);
}

// ---- What was chosen, for the next time

const COOKIE = 'slidr-library-export';
const YEAR = 365 * 24 * 60 * 60;
/** Since the designs are chosen by their groups and the library by its languages. */
const VERSION = 2;

/** A choice, the languages it is in, and whether the archive is gzipped. */
export interface Saved {
  chosen: Chosen;
  languages: Languages;
  gzip: boolean;
}

export const DEFAULT: Saved = { chosen: '*', languages: '*', gzip: true };

const isChoice = (value: unknown): value is Chosen =>
  value === '*' ||
  (typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every(
      (of) => of === '*' || (Array.isArray(of) && of.every((id) => typeof id === 'string')),
    ));

const isLanguages = (value: unknown): value is Languages =>
  value === '*' || (Array.isArray(value) && value.every((lang) => typeof lang === 'string'));

/** What this browser chose the last time; everything, gzipped, the first time. */
export function readSaved(): Saved {
  const held = document.cookie
    .split('; ')
    .find((one) => one.startsWith(`${COOKIE}=`))
    ?.slice(COOKIE.length + 1);
  if (!held) return DEFAULT;
  try {
    const value = JSON.parse(decodeURIComponent(held)) as {
      v?: unknown;
      chosen?: unknown;
      languages?: unknown;
      gzip?: unknown;
    };
    const gzip = typeof value.gzip === 'boolean' ? value.gzip : DEFAULT.gzip;
    // A choice of before chose the designs and the fonts by their languages.
    if (value.v !== VERSION) return { ...DEFAULT, gzip };
    return {
      chosen: isChoice(value.chosen) ? value.chosen : DEFAULT.chosen,
      languages: isLanguages(value.languages) ? value.languages : DEFAULT.languages,
      gzip,
    };
  } catch {
    return DEFAULT;
  }
}

/** Keeps a choice in this browser for a year. */
export function save(saved: Saved) {
  const value = encodeURIComponent(
    JSON.stringify({
      v: VERSION,
      chosen: saved.chosen,
      languages: saved.languages,
      gzip: saved.gzip,
    }),
  );
  const secure = location.protocol === 'https:' ? '; Secure' : '';
  document.cookie = `${COOKIE}=${value}; Max-Age=${YEAR}; Path=/; SameSite=Lax${secure}`;
}
