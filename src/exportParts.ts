/**
 * What the page exports of the library (`Export.tsx`): its parts as the overview names them
 * (`sections.ts`), each with the search tags of its kind (`tags/<kind>.json`); and, of three of
 * them, smaller pieces to choose among, where the app does without the others:
 *
 * - **the designs**, by the language of the decks they are offered in: a gallery reads the catalog
 *   of its own language (`elements/designs/<language>/`) and its pictures made ahead
 *   (`images/designs/thumbs/<width>/<language>/`), and a language without them offers none;
 * - **the templates**, one by one (`templates/<id>/`, and its photographs): a template whose file
 *   is not there is left out (`builtIn.ts` of the app); and the reference decks, which no app reads;
 * - **the fonts**, by the letters each family is made for (`for`, `fonts/catalog.json`): a deck
 *   offers the families of its language and of English. A family made for two is in both.
 *
 * What every piece of a part needs (its catalogs, the designs' pictures) goes with any of them,
 * and the rest of the parts go whole: the icons' search reads both sets at once, and a style of
 * graphics draws from several art sets. An archive holds the library's own files as they are, and
 * no catalog is written again.
 *
 * What was chosen is kept in a cookie of this browser, for the next export.
 */
import { CONTENT_LANGUAGES } from '@slidr/model';
import type { Manifest } from './media';
import { SECTIONS, inSection } from './sections';

/** A piece of a part, to be chosen apart from the others. */
export interface Piece {
  id: string;
  paths: string[];
  bytes: number;
}

export interface Part {
  /** A section of `sections.ts`, or `other`. */
  id: string;
  /** What goes with any of its pieces; all of it, where it has none. */
  core: string[];
  coreBytes: number;
  pieces: Piece[];
  files: number;
  bytes: number;
}

/** The files of no part: what the library holds that the page does not show. */
export const OTHER = 'other';
/** The reference decks of the templates. */
export const REFERENCE_DECKS = 'reference-decks';

/** The kinds whose search tags are a file of their own (ADR-108 of the app). */
const TAGGED = new Set(['designs', 'cards', 'frames', 'shapes', 'graphics', 'emoji', 'icons']);

/** The letters a family of fonts is made for (`fonts/catalog.json`), in the order they are offered. */
export const SCRIPTS = [
  'he',
  'latin',
  'arabic',
  'cyrillic',
  'vietnamese',
  'devanagari',
  'japanese',
  'korean',
  'chinese',
];

/** Of the fonts catalog, what says which family is made for which letters, and where its files are. */
export interface FontsCatalog {
  families?: { family: string; for?: string[]; scripts?: string[] }[];
  faces?: { family: string; path: string }[];
}

function partOf(path: string): string {
  const tags = /^tags\/([^/]+)\.json$/.exec(path)?.[1];
  if (tags && TAGGED.has(tags)) return tags;
  const section = SECTIONS.find((one) => one.id !== 'files' && inSection(one, path));
  return section?.id ?? OTHER;
}

/** The pieces a file of a part is in; none where it goes with any of them. */
type PiecesOf = (path: string) => string[];

const designPieces: PiecesOf = (path) => {
  const lang =
    /^elements\/designs\/([^/]+)\//.exec(path)?.[1] ??
    /^images\/designs\/thumbs\/\d+\/([^/]+)\//.exec(path)?.[1];
  return lang ? [lang] : [];
};

function templatePieces(ids: readonly string[]): PiecesOf {
  // The longest id first: a photograph is named by its template's id, then a dash.
  const longest = [...ids].sort((a, b) => b.length - a.length);
  return (path) => {
    if (path.startsWith(`templates/${REFERENCE_DECKS}/`)) return [REFERENCE_DECKS];
    const folder = /^templates\/([^/]+)\//.exec(path)?.[1];
    if (folder) return ids.includes(folder) ? [folder] : [];
    const picture = /^images\/templates\/([^/]+)$/.exec(path)?.[1];
    const id = picture ? longest.find((one) => picture.startsWith(`${one}-`)) : undefined;
    return id ? [id] : [];
  };
}

function fontPieces(catalog: FontsCatalog | undefined): PiecesOf {
  const made = new Map(
    (catalog?.families ?? []).map(({ family, for: madeFor, scripts }) => [
      family,
      madeFor?.length ? madeFor : (scripts ?? []).slice(0, 1),
    ]),
  );
  const folders = new Map<string, string[]>();
  for (const face of catalog?.faces ?? []) {
    const folder = /^fonts\/([^/]+)\//.exec(face.path)?.[1];
    if (folder && !folders.has(folder)) folders.set(folder, made.get(face.family) ?? []);
  }
  return (path) => {
    const folder = /^fonts\/([^/]+)\//.exec(path)?.[1];
    return folder ? (folders.get(folder) ?? []) : [];
  };
}

/** The order pieces are offered in, by their ids. */
const ORDER: Record<string, readonly string[]> = {
  designs: CONTENT_LANGUAGES,
  fonts: SCRIPTS,
};

/** The parts of a library, and the pieces of those that have them. */
export function partsOf(manifest: Manifest, fonts?: FontsCatalog): Part[] {
  const templates = Object.keys(manifest.files)
    .map((path) => /^templates\/([^/]+)\/template\.json$/.exec(path)?.[1])
    .filter((id): id is string => id !== undefined && id !== REFERENCE_DECKS);
  const piecesOf: Record<string, PiecesOf> = {
    designs: designPieces,
    templates: templatePieces(templates),
    fonts: fontPieces(fonts),
  };
  const parts = new Map<string, Part>();
  for (const [path, { size }] of Object.entries(manifest.files)) {
    const id = partOf(path);
    let part = parts.get(id);
    if (!part) {
      part = { id, core: [], coreBytes: 0, pieces: [], files: 0, bytes: 0 };
      parts.set(id, part);
    }
    part.files += 1;
    part.bytes += size;
    const pieces = piecesOf[id]?.(path) ?? [];
    if (pieces.length === 0) {
      part.core.push(path);
      part.coreBytes += size;
    }
    for (const pieceId of pieces) {
      let piece = part.pieces.find((one) => one.id === pieceId);
      if (!piece) {
        piece = { id: pieceId, paths: [], bytes: 0 };
        part.pieces.push(piece);
      }
      piece.paths.push(path);
      piece.bytes += size;
    }
  }
  const rank = (id: string) => {
    const at = SECTIONS.findIndex((section) => section.id === id);
    return at === -1 ? SECTIONS.length : at;
  };
  return [...parts.values()]
    .sort((a, b) => rank(a.id) - rank(b.id))
    .map((part) => {
      const order = ORDER[part.id];
      const placed = (id: string) => (order?.includes(id) ? order.indexOf(id) : Infinity);
      part.pieces.sort((a, b) => placed(a.id) - placed(b.id) || (a.id < b.id ? -1 : 1));
      return part;
    });
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

/** The files chosen, in order: what an archive of the choice holds, but its manifest. */
export function chosenPaths(parts: readonly Part[], chosen: Chosen): string[] {
  const paths = new Set<string>();
  for (const part of parts) {
    if (stateOf(chosen, part) === 'none') continue;
    for (const path of part.core) paths.add(path);
    for (const piece of part.pieces) {
      if (isChosen(chosen, part, piece)) for (const path of piece.paths) paths.add(path);
    }
  }
  return [...paths].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

// ---- What was chosen, for the next time

const COOKIE = 'slidr-library-export';
const YEAR = 365 * 24 * 60 * 60;

/** A choice, and whether the archive is gzipped. */
export interface Saved {
  chosen: Chosen;
  gzip: boolean;
}

export const DEFAULT: Saved = { chosen: '*', gzip: true };

const isChoice = (value: unknown): value is Chosen =>
  value === '*' ||
  (typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every(
      (of) => of === '*' || (Array.isArray(of) && of.every((id) => typeof id === 'string')),
    ));

/** What this browser chose the last time; everything, gzipped, the first time. */
export function readSaved(): Saved {
  const held = document.cookie
    .split('; ')
    .find((one) => one.startsWith(`${COOKIE}=`))
    ?.slice(COOKIE.length + 1);
  if (!held) return DEFAULT;
  try {
    const value = JSON.parse(decodeURIComponent(held)) as { chosen?: unknown; gzip?: unknown };
    return {
      chosen: isChoice(value.chosen) ? value.chosen : DEFAULT.chosen,
      gzip: typeof value.gzip === 'boolean' ? value.gzip : DEFAULT.gzip,
    };
  } catch {
    return DEFAULT;
  }
}

/** Keeps a choice in this browser for a year. */
export function save(saved: Saved) {
  const value = encodeURIComponent(JSON.stringify({ chosen: saved.chosen, gzip: saved.gzip }));
  const secure = location.protocol === 'https:' ? '; Secure' : '';
  document.cookie = `${COOKIE}=${value}; Max-Age=${YEAR}; Path=/; SameSite=Lax${secure}`;
}
