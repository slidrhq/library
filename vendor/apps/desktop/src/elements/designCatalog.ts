import type { Localized, Slide } from '@slidr/model';

/**
 * The catalogs of Elements → Designs as the media library holds them, and how the app makes one
 * of them. Nothing here reads: `designs.ts` and `managedDesigns.ts` do.
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
}

/** The two catalogs as one, and what of it came from the managed one. */
export interface MergedDesignCatalog extends DesignCatalog {
  /** The managed designs that are in the catalog: an id the authored one has is not. */
  managed: Set<string>;
  names: Map<string, DesignNames>;
  groupNames: Map<string, DesignNames>;
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
  const ids = new Set<string>();
  const names = new Map<string, DesignNames>();
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
  return { groups, groupIds, slides, subjects, managed: ids, names, groupNames };
}

/** A name in the language of `lang` (`he`, `he-IL`; anything else is English), if it has one. */
export function localName(names: DesignNames | undefined, lang: string): string | undefined {
  const name: unknown = names?.[lang.startsWith('he') ? 'he' : 'en'];
  return typeof name === 'string' && name.trim() ? name : undefined;
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
