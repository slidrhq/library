import { useEffect, useState, type DependencyList } from 'react';
import { CONTENT_LANGUAGES, LANGUAGE_NAMES, languageDir } from '@slidr/model';
import type { TagKind } from '@desktop/media/icons/library';
import type { SearchWords, Tags, TagsOf } from '@desktop/media/icons/search';
import { iconsModule, type iconSearchModule } from './app';
import { useT } from './i18n';

/**
 * Where the library browser is: a section, and in it a group or a folder, an item, and a slide
 * of that item.
 */
export interface LibraryRoute {
  section: string;
  item?: string;
  folder?: string;
  group?: string;
  slide?: number;
}

/** The answer of an asynchronous read, followed as its inputs change. */
export function useRead<T>(
  read: () => Promise<T>,
  deps: DependencyList,
): { value?: T; error?: string } {
  const [state, setState] = useState<{ value?: T; error?: string; deps?: DependencyList }>({});
  useEffect(() => {
    let live = true;
    read().then(
      (value) => live && setState({ value, deps }),
      (error: unknown) =>
        live && setState({ error: error instanceof Error ? error.message : String(error), deps }),
    );
    return () => {
      live = false;
    };
    // The caller names what the read depends on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  const current =
    state.deps !== undefined &&
    state.deps.length === deps.length &&
    state.deps.every((dep, i) => Object.is(dep, deps[i]));
  return current ? state : {};
}

/** Whether a text matches what the person searched for, in any of its names. */
export function matches(query: string, ...names: (string | undefined)[]): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return names.some((name) => name?.toLowerCase().includes(needle));
}

type Search = Awaited<ReturnType<typeof iconSearchModule>>;

/**
 * Whether a query finds a thing as the app's search does (ADR-108 of the app): every word of it,
 * in Hebrew or English, in the thing's name, in `more` (the name of its group) or in its tags.
 */
export function finds(
  search: Search,
  query: string,
  name: { he?: string; en?: string },
  ...more: (Tags | undefined)[]
): boolean {
  if (!query.trim()) return true;
  const nameHebrew = search.wordsOf(name.he ?? '');
  let words: SearchWords = {
    filled: false,
    nameWords: search.wordsOf(name.en ?? ''),
    tagWords: [],
    nameTerms: [nameHebrew.join(' ')],
    nameHebrew,
    tagTerms: [],
    tagHebrew: [],
  };
  for (const tags of more) words = search.withTags(words, tags);
  return search.searchIcons([words], query, { count: 1 }).length > 0;
}

/** The library's search tags of a kind, by key, as the app reads them; none when it has none. */
export const tagsOf = (kind: TagKind): Promise<TagsOf> =>
  iconsModule().then((icons) => icons.searchTags(kind));

/** The search tags of an item in every language it carries. */
export function TagFacts({ tags }: { tags: Tags | undefined }) {
  const t = useT();
  return (
    <>
      <dt>{t('library.icons.tags')}</dt>
      {CONTENT_LANGUAGES.filter((lang) => tags?.[lang]?.length).map((lang) => (
        <dd key={lang} lang={lang} dir={languageDir(lang)}>
          <strong>{LANGUAGE_NAMES[lang].native}: </strong>
          {tags?.[lang]?.join(', ')}
        </dd>
      ))}
      {!CONTENT_LANGUAGES.some((lang) => tags?.[lang]?.length) && <dd>—</dd>}
    </>
  );
}
