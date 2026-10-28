import { CONTENT_LANGUAGES, type Localized, type Slide } from '@slidr/model';
import {
  searchIcons,
  withTags,
  wordsOf,
  type SearchWords,
  type Tags,
  type TagsOf,
} from '../media/icons/search';

/**
 * The catalog of Elements → Designs as the media library holds it, how the app reads it with the
 * catalog of before of a library that still has one, and how it searches them. Nothing here
 * reads: `designs.ts` and `designThumbs.ts` do.
 */

/** A name in the two languages of the interface. */
export interface DesignNames {
  he?: string;
  en?: string;
}

/**
 * The catalog of the ready-made slides, `elements/designs/index.json` (ADR-118). A design's slide
 * is drawn in Hebrew and in English, and in whatever other language its author drew it; a catalog
 * the publisher writes in one language (`InLanguage`) holds the slides of that one alone. The app's
 * messages name the first designs and their groups (`designs.name.<id>`); the catalog names in
 * Hebrew and English the designs made since, and their groups. The sizes of the designs' pictures
 * are `images/designs/sizes.json`, and their search tags `tags/designs.json`.
 */
export interface DesignCatalog {
  groups: string[];
  groupIds: Record<string, string[]>;
  slides: Record<string, Partial<Localized<Slide>>>;
  subjects: Record<string, [number, number]>;
  names?: Record<string, DesignNames>;
  groupNames?: Record<string, DesignNames>;
}

/**
 * The catalog of the designs Slidr Studio made, `elements/designs/managed.json`, of a library not
 * published since the catalogs were made one (ADR-118): after the other, its designs named `m-…`,
 * with the pixel sizes of their pictures and their search tags in it too. Its next publication
 * folds it into the catalog.
 */
export interface ManagedDesignCatalog extends DesignCatalog {
  version?: number;
  sizes?: Record<string, [number, number]>;
  /** The search tags the studio wrote with each design (ADR-108); older files have none. */
  tags?: Record<string, Tags>;
}

/**
 * What the publisher adds to a catalog it writes again in one language (`<language>/index.json`,
 * ADR-109): its slides are of that language alone.
 */
export interface InLanguage {
  /** Every language each design of the whole catalog is drawn in. */
  languages: Record<string, string[]>;
  /** The hash of each file it was made from, by its place in the library. */
  from: Record<string, string>;
}

/**
 * Whether a file the publisher wrote was made from the files the manifest names now: it gives the
 * hash of each in `from`. A copy pulled from the site, published again by a publisher that does
 * not write such files, holds them as they were, beside newer files.
 */
export function madeFrom(
  from: unknown,
  files: Readonly<Record<string, { sha256: string } | undefined>>,
): boolean {
  const made = Object.entries(record<unknown>(from));
  return made.length > 0 && made.every(([path, hash]) => files[path]?.sha256 === hash);
}

/** The catalog as the gallery reads it, with the designs of a catalog of before after its own. */
export interface MergedDesignCatalog extends Omit<DesignCatalog, 'names' | 'groupNames'> {
  names: Map<string, DesignNames>;
  groupNames: Map<string, DesignNames>;
  /** The sizes of the pictures a catalog of before gave. */
  sizes: Map<string, [number, number]>;
  /** The tags a catalog of before gave its designs. */
  tags: Map<string, Tags>;
}

/** A JSON object, or an empty one for anything else. */
function record<T>(value: unknown): Record<string, T> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, T>)
    : {};
}

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];

const isPoint = (value: unknown): value is [number, number] =>
  Array.isArray(value) && value.length === 2 && value.every((n) => typeof n === 'number');

/** A member of a catalog, by an id it has of its own (not `constructor`). */
const own = <T>(of: Record<string, T>, id: string): T | undefined =>
  Object.hasOwn(of, id) ? of[id] : undefined;

/**
 * The catalogs as one, in order: the catalog, and the catalog of before where a library still has
 * it, as its next publication folds the two (`designCatalog.ts` of Slidr Library). The first takes
 * every group it has; a group another has takes that one's designs after those it has, and a new
 * group comes after the others when it has a design. Only a design with a slide is listed, once:
 * an id of two catalogs is the first's, with its subject, its name and its tags.
 */
export function mergeCatalogs(
  ...catalogs: (Partial<ManagedDesignCatalog> | undefined)[]
): MergedDesignCatalog {
  const slides: Record<string, Partial<Localized<Slide>>> = {};
  const groups: string[] = [];
  const groupIds: Record<string, string[]> = {};
  const subjects: Record<string, [number, number]> = {};
  const names = new Map<string, DesignNames>();
  const groupNames = new Map<string, DesignNames>();
  const sizes = new Map<string, [number, number]>();
  const tags = new Map<string, Tags>();
  catalogs.forEach((catalog, at) => {
    const theirs = record<Partial<Localized<Slide>> | undefined>(catalog?.slides);
    const ids = record<unknown>(catalog?.groupIds);
    const points = record<unknown>(catalog?.subjects);
    const named = record<unknown>(catalog?.names);
    const tagged = record<unknown>(catalog?.tags);
    // The first catalog's own slides are its, even of a design no group lists.
    if (at === 0) {
      for (const [id, slide] of Object.entries(theirs)) {
        if (slide && typeof slide === 'object') slides[id] = slide;
      }
    }
    for (const group of new Set(strings(catalog?.groups))) {
      const added: string[] = [];
      for (const id of strings(ids[group])) {
        const slide = own(theirs, id);
        if (!slide || typeof slide !== 'object') continue;
        if (at > 0 && Object.hasOwn(slides, id)) continue;
        slides[id] = slide;
        added.push(id);
        const subject = own(points, id);
        if (isPoint(subject)) subjects[id] = subject;
        const name = own(named, id);
        if (name !== undefined) names.set(id, record<string>(name));
        const given = own(tagged, id);
        if (given !== undefined) tags.set(id, tagsOf(given));
      }
      if (groups.includes(group)) {
        groupIds[group] = [...(groupIds[group] ?? []), ...added];
      } else if (at === 0 || added.length > 0) {
        groups.push(group);
        groupIds[group] = added;
      }
    }
    for (const [group, name] of Object.entries(record<unknown>(catalog?.groupNames))) {
      if (!groupNames.has(group)) groupNames.set(group, record<string>(name));
    }
    for (const [name, size] of Object.entries(record<unknown>(catalog?.sizes))) {
      if (isPoint(size) && !sizes.has(name)) sizes.set(name, size);
    }
  });
  return { groups, groupIds, slides, subjects, names, groupNames, sizes, tags };
}

/** The tags of a design in each language the app has content in. */
function tagsOf(given: unknown): Tags {
  const each = record<unknown>(given);
  const localized: Tags = {};
  for (const lang of CONTENT_LANGUAGES) {
    if (Object.hasOwn(each, lang)) localized[lang] = strings(each[lang]);
  }
  return localized;
}

/** A name in the language of `lang` (`he`, `he-IL`; anything else is English), if it has one. */
export function localName(names: DesignNames | undefined, lang: string): string | undefined {
  const name: unknown = names?.[lang.startsWith('he') ? 'he' : 'en'];
  return typeof name === 'string' && name.trim() ? name : undefined;
}

/**
 * The tags of every design: the library's (`tags/designs.json`), and with them those a catalog of
 * before gives a design of the studio.
 */
export function designTagsOf(library: TagsOf, managed: ReadonlyMap<string, Tags>): TagsOf {
  const all: Record<string, Tags> = { ...library };
  for (const [id, own] of managed) {
    const listed = all[id];
    const merged: Tags = {};
    for (const lang of CONTENT_LANGUAGES) {
      if (own[lang] || listed?.[lang]) {
        merged[lang] = [...new Set([...(own[lang] ?? []), ...(listed?.[lang] ?? [])])];
      }
    }
    all[id] = merged;
  }
  return all;
}

/** A design as the search sees it: its names, and the name of its group, in both languages. */
export interface DesignWords extends SearchWords {
  id: string;
}

/**
 * The words a design is found by: its name in English and in Hebrew, the name of its group (a
 * design of "Invitations" is found by that word) and its tags.
 */
export function designWords(
  id: string,
  name: DesignNames,
  group: DesignNames,
  tags: Tags | undefined,
): DesignWords {
  const nameWords = wordsOf(name.en ?? '');
  const nameHebrew = wordsOf(name.he ?? '');
  const own: DesignWords = {
    id,
    filled: false,
    nameWords,
    tagWords: [],
    nameTerms: nameHebrew.length > 0 ? [nameHebrew.join(' ')] : [],
    nameHebrew,
    tagTerms: [],
    tagHebrew: [],
  };
  const grouped = { en: group.en ? [group.en] : [], he: group.he ? [group.he] : [] };
  return withTags(withTags(own, grouped), tags);
}

/** The designs that match every word of a query in Hebrew or English, best first. */
export function searchDesigns(designs: readonly DesignWords[], query: string): string[] {
  return searchIcons(designs, query, { count: designs.length }).map(({ id }) => id);
}
