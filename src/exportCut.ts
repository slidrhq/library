/**
 * The catalogs an export writes again with some of their items (`exportParts.ts`): those of the
 * designs and of the frames, when some of their groups only are chosen. Each is the library's file
 * with what is of another item left out, and its `from`, which says what it was made of, naming the
 * files as the archive holds them: so an app takes the archive, unpacked, as a library of its own
 * (docs/media-library.md of the app, "A copy"). A library that brings it in merges each into its
 * own an item at a time (`server/core/media/archiveMerge.ts`).
 *
 * Nothing here reads: the page reads the files, and hashes what is written of them.
 */
import { FRAMES_CATALOG } from './exportParts';

type Json = Record<string, unknown>;

const isRecord = (value: unknown): value is Json =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** A record with the members `keep` takes alone, in their order. */
const only = (value: unknown, keep: (key: string) => boolean): Json =>
  Object.fromEntries(Object.entries(isRecord(value) ? value : {}).filter(([key]) => keep(key)));

/** Each member of a record of records with the members `keep` takes alone. */
const eachOnly = (value: unknown, keep: (key: string) => boolean): Json =>
  Object.fromEntries(
    Object.entries(isRecord(value) ? value : {}).map(([key, inner]) => [key, only(inner, keep)]),
  );

/** The members of a catalog of designs that hold something of each design, by its id. */
const BY_DESIGN = ['slides', 'subjects', 'names', 'tags', 'languages'] as const;

/** A design's pictures are named by its id, the backdrop's then `-bg` (`designPicturePaths`). */
const pictureKept = (keep: ReadonlySet<string>) => (name: string) =>
  keep.has(name) || (name.endsWith('-bg') && keep.has(name.slice(0, -3)));

/** A catalog of designs, whole or of one language, with the designs of `keep` alone. */
export function cutDesignCatalog(catalog: Json, keep: ReadonlySet<string>): Json {
  const out: Json = { ...catalog };
  const kept = (id: string) => keep.has(id);
  for (const member of BY_DESIGN) {
    if (member in catalog) out[member] = only(catalog[member], kept);
  }
  if ('sizes' in catalog) out.sizes = only(catalog.sizes, pictureKept(keep));
  const groupIds: Record<string, string[]> = {};
  for (const [group, ids] of Object.entries(isRecord(catalog.groupIds) ? catalog.groupIds : {})) {
    const listed: unknown[] = Array.isArray(ids) ? ids : [];
    const left = listed.filter((id): id is string => typeof id === 'string' && kept(id));
    if (left.length > 0) groupIds[group] = left;
  }
  if ('groupIds' in catalog) out.groupIds = groupIds;
  const hasGroup = (group: unknown) => typeof group === 'string' && Object.hasOwn(groupIds, group);
  if (Array.isArray(catalog.groups)) out.groups = catalog.groups.filter(hasGroup);
  if ('groupNames' in catalog) out.groupNames = only(catalog.groupNames, hasGroup);
  return out;
}

/** `revs.json`: the words of the designs of `keep` alone, in each language. */
export function cutRevs(revs: Json, keep: ReadonlySet<string>): Json {
  const out: Json = { ...revs, designs: eachOnly(revs.designs, (id) => keep.has(id)) };
  if (isRecord(revs.catalogs)) {
    out.catalogs = Object.fromEntries(
      Object.entries(revs.catalogs).map(([path, ids]) => [
        path,
        Array.isArray(ids) ? ids.filter((id) => typeof id === 'string' && keep.has(id)) : [],
      ]),
    );
  }
  return out;
}

/** Every string a value holds, however deep. */
function stringsIn(value: unknown, into: Set<string>) {
  if (typeof value === 'string') into.add(value);
  else if (Array.isArray(value)) for (const one of value) stringsIn(one, into);
  else if (isRecord(value)) for (const one of Object.values(value)) stringsIn(one, into);
}

/**
 * The catalog of the frames with the frames of `keep` alone: their groups, those of them shown
 * first, and the stickers they put beside their pictures.
 */
export function cutFrames(catalog: Json, keep: ReadonlySet<string>): Json {
  const groups = (Array.isArray(catalog.groups) ? catalog.groups : [])
    .filter(isRecord)
    .map((group) => ({
      ...group,
      frames: (Array.isArray(group.frames) ? group.frames : []).filter(
        (frame) => isRecord(frame) && typeof frame.id === 'string' && keep.has(frame.id),
      ),
    }))
    .filter((group) => group.frames.length > 0);
  const out: Json = { ...catalog, groups };
  if (Array.isArray(catalog.featured)) {
    out.featured = catalog.featured.filter((id) => typeof id === 'string' && keep.has(id));
  }
  if (isRecord(catalog.stickers)) {
    const named = new Set<string>();
    stringsIn(groups, named);
    out.stickers = only(catalog.stickers, (name) => named.has(name));
  }
  return out;
}

/** A catalog written again with the items of `keep` alone, by its place; as it is, for another. */
export function cutCatalog(path: string, file: Json, keep: ReadonlySet<string>): Json {
  if (path === FRAMES_CATALOG) return cutFrames(file, keep);
  if (path === 'elements/designs/revs.json') return cutRevs(file, keep);
  if (/^elements\/designs\/.+\.json$/.test(path)) return cutDesignCatalog(file, keep);
  if (path === 'images/designs/sizes.json') return only(file, pictureKept(keep));
  if (path === 'images/designs/thumbs/index.json') {
    return { ...file, designs: eachOnly(file.designs, (id) => keep.has(id)) };
  }
  if (path === 'tags/designs.json' || path === 'tags/frames.json') {
    return { ...file, tags: only(file.tags, (id) => keep.has(id)) };
  }
  return file;
}

/**
 * The `from` of a file the archive holds, of the files as it holds them (`hashOf`): a file written
 * again by its hash now, and one it does not hold left out. A file made of other files than the
 * library has (`was`) is left as it is: a gallery does not take it, and still does not.
 */
export function fromIn(
  file: Json,
  was: (path: string) => string | undefined,
  hashOf: (path: string) => string | undefined,
): Json {
  if (!isRecord(file.from)) return file;
  const made = Object.entries(file.from);
  if (made.length === 0 || made.some(([path, hash]) => was(path) !== hash)) return file;
  const from: Record<string, string> = {};
  for (const [path] of made) {
    const now = hashOf(path);
    if (now) from[path] = now;
  }
  return { ...file, from };
}

/** Whether a file says what it was made of: it is written again after those it was made of. */
export const isMadeOf = (file: Json) => isRecord(file.from);

/** A catalog's text again, as the library wrote it: in lines, or in one. */
export function textOf(file: Json, as: string): string {
  const lines = /^\{\s*\n/.test(as.slice(0, 8));
  const end = as.endsWith('\n') ? '\n' : '';
  return `${lines ? JSON.stringify(file, null, 2) : JSON.stringify(file)}${end}`;
}
