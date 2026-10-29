/**
 * The files an archive brought in merges into the library's rather than writing over them
 * (`merged.ts`): each as the archive has it, with what only the library has beside it. So a
 * library that publishes designs, tags or samples of its own keeps them when it takes in another's.
 *
 * - The catalog of the designs, a design at a time: each design the archive has is as the archive
 *   has it; one only the library has comes after, in its group, as `appendDesigns` puts it.
 * - The sizes of the pictures, and the words their pictures made ahead were drawn of, an entry at
 *   a time; the search tags of each part, an item and a language at a time: the archive's where
 *   both have one.
 * - The samples of the templates, a template and a language at a time.
 * - The catalog of the frames, a group and a frame at a time, as the page exports them by their
 *   groups: a frame only the library has comes after the others of its group.
 *
 * An archive of a library of before holds `managed.json` too: it is folded into the archive's
 * catalog first, as a publication folds the library's (`foldManaged`), and its files of each
 * language are left out. A file that is not JSON is written as the archive has it.
 */
import type { Bucket } from '../bucket.ts';
import { isRecord } from '../http.ts';
import {
  CATALOG,
  DESIGN_TAGS,
  DesignCatalog,
  MANAGED,
  SIZES,
  appendDesigns,
  encodeSizes,
  foldSizes,
  foldTags,
  sizesOf,
  tagsOf,
} from './designCatalog.ts';
import { THUMBS } from './designFiles.ts';
import { readBytes, toBytes, toText } from './live.ts';
import {
  OPEN_OBJECT,
  TEMPLATES,
  byLanguage,
  encodeTags,
  membersOf,
  skipSpace,
  spliceSample,
  type Member,
  type TagsFile,
} from './merge.ts';
import { MANAGED_IN_LANGUAGE } from './merged.ts';
import type { Parts } from './parts.ts';
import type { Writing } from './writing.ts';

/** A JSON file's value; none where it is not JSON. */
function parsed(bytes: Uint8Array | undefined): unknown {
  if (!bytes) return undefined;
  try {
    return JSON.parse(toText(bytes)) as unknown;
  } catch {
    return undefined;
  }
}

/** Entries of `ours` that `theirs` has not, after those of `theirs`; whether there were any. */
function withOurs<T>(theirs: Record<string, T>, ours: Record<string, T>): boolean {
  let any = false;
  for (const [key, value] of Object.entries(ours)) {
    if (Object.hasOwn(theirs, key)) continue;
    theirs[key] = value;
    any = true;
  }
  return any;
}

/** The samples of a catalog of templates, where each template's are. */
function samplesOf(bytes: Uint8Array): Map<string, Member> {
  const top = membersOf(bytes, skipSpace(bytes, 0), TEMPLATES);
  const samples = top.members.find((member) => member.key === 'samples');
  if (!samples || bytes[samples.start] !== OPEN_OBJECT) return new Map();
  return new Map(membersOf(bytes, samples.start, TEMPLATES).members.map((one) => [one.key, one]));
}

/** The archive's catalog of templates, with each sample of ours in a language its template's lack. */
export function mergeSamples(theirs: Uint8Array, ours: Uint8Array): Uint8Array {
  const have = samplesOf(theirs);
  let merged = theirs;
  for (const [template, place] of samplesOf(ours)) {
    const languages = parsed(ours.subarray(place.start, place.end));
    if (!isRecord(languages)) continue;
    const there = have.get(template);
    const known = there ? parsed(theirs.subarray(there.start, there.end)) : undefined;
    for (const [lang, sample] of Object.entries(languages)) {
      if (isRecord(known) && Object.hasOwn(known, lang)) continue;
      merged = spliceSample(merged, template, lang, sample);
    }
  }
  return merged;
}

/** The archive's tags, with ours: an item and a language at a time, the archive's where both have. */
export function mergeItemTags(theirs: TagsFile['tags'], ours: TagsFile['tags']): boolean {
  let any = false;
  for (const [key, mine] of Object.entries(ours)) {
    const given = theirs[key];
    if (!isRecord(mine)) continue;
    if (!isRecord(given)) {
      theirs[key] = mine;
      any = true;
      continue;
    }
    const extra = Object.keys(mine).filter((lang) => !Object.hasOwn(given, lang));
    if (extra.length === 0) continue;
    theirs[key] = byLanguage({ ...mine, ...given });
    any = true;
  }
  return any;
}

/** The catalog of the frames (the app's `frames.ts`). */
export const FRAMES = 'elements/catalogs/frames-catalog.json';

type Frame = Record<string, unknown> & { id: string };

const framesIn = (group: Record<string, unknown>): Frame[] =>
  (Array.isArray(group.frames) ? group.frames : []).filter(
    (frame): frame is Frame => isRecord(frame) && typeof frame.id === 'string',
  );

/**
 * The archive's catalog of the frames, with ours: each frame the archive has as it has it, and one
 * only ours has after the others of its group, or in its group, where ours has it among the
 * archive's groups; the stickers and the frames shown first, the archive's, then those only ours
 * has. Whether ours added any.
 */
export function mergeFrames(
  theirs: Record<string, unknown>,
  ours: Record<string, unknown>,
): boolean {
  const groups = (Array.isArray(theirs.groups) ? theirs.groups : []).filter(isRecord);
  const have = new Set(groups.flatMap((group) => framesIn(group).map((frame) => frame.id)));
  let any = false;
  // Where the group of ours before it is among the archive's.
  let after = -1;
  for (const group of (Array.isArray(ours.groups) ? ours.groups : []).filter(isRecord)) {
    const at = groups.findIndex((one) => one.id === group.id);
    if (at !== -1) after = at;
    const more = framesIn(group).filter((frame) => !have.has(frame.id));
    if (more.length === 0) continue;
    for (const frame of more) have.add(frame.id);
    if (at !== -1) groups[at]!.frames = [...framesIn(groups[at]!), ...more];
    else groups.splice((after += 1), 0, { ...group, frames: more });
    any = true;
  }
  theirs.groups = groups;
  if (isRecord(ours.stickers)) {
    const stickers = isRecord(theirs.stickers) ? theirs.stickers : {};
    if (withOurs(stickers, ours.stickers)) {
      theirs.stickers = stickers;
      any = true;
    }
  }
  const featured: unknown[] = Array.isArray(theirs.featured) ? theirs.featured : [];
  const listed: unknown[] = Array.isArray(ours.featured) ? ours.featured : [];
  const first = listed.filter(
    (id) => typeof id === 'string' && have.has(id) && !featured.includes(id),
  );
  if (first.length > 0) {
    theirs.featured = [...featured, ...first];
    any = true;
  }
  return any;
}

/** `images/designs/thumbs/index.json` (`designFiles.ts`). */
interface Thumbs {
  widths: number[];
  designs: Record<string, Record<string, string>>;
}

const thumbsOf = (value: unknown): Thumbs | undefined =>
  isRecord(value) && isRecord(value.designs)
    ? {
        widths: Array.isArray(value.widths)
          ? value.widths.filter((width): width is number => typeof width === 'number')
          : [],
        designs: Object.fromEntries(
          Object.entries(value.designs).map(([lang, words]) => [
            lang,
            isRecord(words) ? ({ ...words } as Record<string, string>) : {},
          ]),
        ),
      }
    : undefined;

/**
 * Writes the files of an archive that merge into the library's (`held`, by path), each merged with
 * the library's as the publication leaves it. Answers how many the library had already as they
 * are.
 */
export async function mergeHeld(
  media: Bucket,
  writing: Writing,
  held: ReadonlyMap<string, Uint8Array>,
): Promise<number> {
  const ours = (path: string) =>
    writing.hashOf(path) ? readBytes(media, path) : Promise.resolve(undefined);
  const files = new Map<string, Uint8Array | Parts>();

  // The designs: an archive of before has two catalogs, one before they are merged with ours.
  let sizesFile = parsed(held.get(SIZES));
  let tagsFile = parsed(held.get(DESIGN_TAGS));
  let sizesFolded = false;
  let tagsFolded = false;
  const catalogBytes = held.get(CATALOG);
  const managedBytes = held.get(MANAGED);
  if (catalogBytes || managedBytes) {
    const catalog = DesignCatalog.of(catalogBytes);
    let changed = !catalogBytes;
    if (managedBytes) {
      const managed = DesignCatalog.of(managedBytes, MANAGED);
      changed = appendDesigns(catalog, managed).length > 0 || changed;
      const sizes = foldSizes(sizesFile, managed);
      if (sizes) [sizesFile, sizesFolded] = [sizes, true];
      const tags = foldTags(tagsFile, managed);
      if (tags) [tagsFile, tagsFolded] = [tags, true];
    }
    const mine = await ours(CATALOG);
    if (mine) changed = appendDesigns(catalog, DesignCatalog.of(mine)).length > 0 || changed;
    files.set(CATALOG, changed || !catalogBytes ? catalog.parts() : catalogBytes);
  }

  if (held.has(SIZES) || sizesFolded) {
    const theirs = held.has(SIZES) && sizesFile === undefined ? undefined : sizesOf(sizesFile);
    if (!theirs) files.set(SIZES, held.get(SIZES)!);
    else {
      const more = withOurs(theirs, sizesOf(parsed(await ours(SIZES))));
      files.set(SIZES, more || sizesFolded ? toBytes(encodeSizes(theirs)) : held.get(SIZES)!);
    }
  }

  const thumbs = held.get(THUMBS);
  if (thumbs) {
    const theirs = thumbsOf(parsed(thumbs));
    const mine = thumbsOf(parsed(await ours(THUMBS)));
    let more = false;
    if (theirs && mine) {
      for (const width of mine.widths) {
        if (theirs.widths.includes(width)) continue;
        theirs.widths.push(width);
        more = true;
      }
      for (const [lang, words] of Object.entries(mine.designs)) {
        more = withOurs((theirs.designs[lang] ??= {}), words) || more;
      }
    }
    files.set(THUMBS, more ? toBytes(`${JSON.stringify(theirs, null, 2)}\n`) : thumbs);
  }

  for (const [path, bytes] of held) {
    if (!path.startsWith('tags/')) continue;
    const file = path === DESIGN_TAGS ? tagsFile : parsed(bytes);
    if (!isRecord(file)) {
      files.set(path, bytes);
      continue;
    }
    const tags = tagsOf(file);
    const more = mergeItemTags(tags, tagsOf(parsed(await ours(path))));
    const folded = path === DESIGN_TAGS && tagsFolded;
    files.set(path, more || folded ? toBytes(encodeTags({ version: 1, tags })) : bytes);
  }
  if (tagsFolded && !held.has(DESIGN_TAGS)) {
    const tags = tagsOf(tagsFile);
    mergeItemTags(tags, tagsOf(parsed(await ours(DESIGN_TAGS))));
    files.set(DESIGN_TAGS, toBytes(encodeTags({ version: 1, tags })));
  }

  const frames = held.get(FRAMES);
  if (frames) {
    const theirs = parsed(frames);
    const mine = parsed(await ours(FRAMES));
    const more = isRecord(theirs) && isRecord(mine) && mergeFrames(theirs, mine);
    files.set(FRAMES, more ? toBytes(`${JSON.stringify(theirs, null, 2)}\n`) : frames);
  }

  const templates = held.get(TEMPLATES);
  if (templates) {
    const mine = await ours(TEMPLATES);
    let merged = templates;
    try {
      if (mine) merged = mergeSamples(templates, mine);
    } catch {
      // A catalog that is not JSON is written as the archive has it.
    }
    files.set(TEMPLATES, merged);
  }

  let same = 0;
  for (const [path, data] of files) {
    if (MANAGED_IN_LANGUAGE.test(path) || path === MANAGED) continue;
    if (!(await writing.put(path, data))) same += 1;
  }
  return same;
}
