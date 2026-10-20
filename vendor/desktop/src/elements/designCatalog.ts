import type { Localized, Slide } from '@slidr/model';
import {
  searchIcons,
  withTags,
  wordsOf,
  type SearchWords,
  type Tags,
  type TagsOf,
} from '../media/icons/search';

/**
 * The catalogs of Elements → Designs as the media library holds them, how the app makes one
 * of them, and how it searches them. Nothing here reads: `designs.ts` and `managedDesigns.ts` do.
 */

/** A name in the two languages of the interface. */
export interface DesignNames {
  he?: string;
  en?: string;
}

/**
 * The ready-made slides of `elements/designs/index.json`, authored. A design's slide is drawn in
 * Hebrew and in English, and in whatever other language its author drew it.
 */
export interface DesignCatalog {
  groups: string[];
  groupIds: Record<string, string[]>;
  slides: Record<string, Localized<Slide>>;
  subjects: Record<string, [number, number]>;
}

/**
 * The designs Slidr Studio publishes, `elements/designs/managed.json`, apart from the
 * authored catalog. Their ids start with `m-`; the file names them and their groups, and holds
 * the pixel sizes of their pictures, which `images/designs/sizes.json` does not.
 */
export interface ManagedDesignCatalog extends DesignCatalog {
  version: number;
  groupNames: Record<string, DesignNames>;
  names: Record<string, DesignNames>;
  sizes: Record<string, [number, number]>;
  /** The search tags the studio wrote with each design (ADR-108); older files have none. */
  tags?: Record<string, Tags>;
}

/** The two catalogs as one, and what of it came from the managed one. */
export interface MergedDesignCatalog extends DesignCatalog {
  /** The managed designs that are in the catalog: an id the authored one has is not. */
  managed: Set<string>;
  names: Map<string, DesignNames>;
  groupNames: Map<string, DesignNames>;
  /** The tags `managed.json` gives its designs in the catalog. */
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

/**
 * The authored catalog with the managed one after it. A managed group the authored catalog has
 * takes its designs after the authored ones; another group comes after the authored groups, in
 * the managed order, when it has a design. Only a design with a slide is listed, once; where both
 * catalogs have an id, the authored design is the one kept.
 */
export function mergeCatalogs(
  authored: Partial<DesignCatalog> | undefined,
  managed: Partial<ManagedDesignCatalog> | undefined,
): MergedDesignCatalog {
  const slides = { ...record<Localized<Slide>>(authored?.slides) };
  const has = (id: string) => Object.hasOwn(slides, id);
  const groups = strings(authored?.groups);
  const groupIds = Object.fromEntries(
    Object.entries(record<unknown>(authored?.groupIds)).map(([group, ids]) => [
      group,
      strings(ids).filter(has),
    ]),
  );
  const subjects = { ...record<[number, number]>(authored?.subjects) };

  const managedSlides = record<Localized<Slide> | undefined>(managed?.slides);
  const managedIds = record<unknown>(managed?.groupIds);
  const managedSubjects = record<unknown>(managed?.subjects);
  const managedNames = record<unknown>(managed?.names);
  const managedTags = record<unknown>(managed?.tags);
  const ids = new Set<string>();
  const names = new Map<string, DesignNames>();
  const tags = new Map<string, Tags>();
  for (const group of new Set(strings(managed?.groups))) {
    const added: string[] = [];
    for (const id of strings(managedIds[group])) {
      const slide = Object.hasOwn(managedSlides, id) ? managedSlides[id] : undefined;
      if (has(id) || !slide || typeof slide !== 'object') continue;
      slides[id] = slide;
      ids.add(id);
      added.push(id);
      const subject = managedSubjects[id];
      if (Object.hasOwn(managedSubjects, id) && isPoint(subject)) subjects[id] = subject;
      if (Object.hasOwn(managedNames, id)) names.set(id, record<string>(managedNames[id]));
      if (Object.hasOwn(managedTags, id)) {
        const own = record<unknown>(managedTags[id]);
        tags.set(id, { en: strings(own.en), he: strings(own.he) });
      }
    }
    if (groups.includes(group)) {
      groupIds[group] = [...(groupIds[group] ?? []), ...added];
    } else if (added.length > 0) {
      groups.push(group);
      groupIds[group] = added;
    }
  }

  const groupNames = new Map(
    Object.entries(record<unknown>(managed?.groupNames)).map(([group, name]) => [
      group,
      record<string>(name),
    ]),
  );
  return { groups, groupIds, slides, subjects, managed: ids, names, groupNames, tags };
}

/** A name in the language of `lang` (`he`, `he-IL`; anything else is English), if it has one. */
export function localName(names: DesignNames | undefined, lang: string): string | undefined {
  const name: unknown = names?.[lang.startsWith('he') ? 'he' : 'en'];
  return typeof name === 'string' && name.trim() ? name : undefined;
}

/**
 * The tags of every design: the library's (`tags/designs.json`), and with them those `managed.json`
 * gives a design of the studio.
 */
export function designTagsOf(library: TagsOf, managed: ReadonlyMap<string, Tags>): TagsOf {
  const all: Record<string, Tags> = { ...library };
  for (const [id, own] of managed) {
    const listed = all[id];
    all[id] = {
      en: [...new Set([...(own.en ?? []), ...(listed?.en ?? [])])],
      he: [...new Set([...(own.he ?? []), ...(listed?.he ?? [])])],
    };
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

/** The width and height of a managed picture (`<id>`, `<id>-bg`), as `managed.json` lists it. */
export function managedSize(
  managed: Partial<ManagedDesignCatalog> | undefined,
  name: string,
): [number, number] | undefined {
  const sizes = record<unknown>(managed?.sizes);
  const size = Object.hasOwn(sizes, name) ? sizes[name] : undefined;
  return isPoint(size) ? size : undefined;
}
