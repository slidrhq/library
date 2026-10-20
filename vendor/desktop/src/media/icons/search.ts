/**
 * Searching the icon library (SHP-07, GEN-09): an index of every icon's words, in English from
 * the icon sets and in Hebrew from the app's own dictionary (`hebrew.json`), and a search over
 * it. Pure functions: the data comes from `library.ts`, which loads it when it is first needed.
 *
 * An icon's words are the parts of its name (`arrow-big-down`) and the tags its set gives it.
 * The Hebrew dictionary maps an English word to the Hebrew a user would type for it, so an
 * icon's Hebrew tags are the translations of its own words: Hebrew for "arrow" finds every arrow.
 * On top of those come the library's own tags in both languages (`withTags`, ADR-108), which the
 * graphics, emoji, frames, shapes, card sets and designs are searched by as well.
 */

import type { ContentLanguage } from '@slidr/model';

export type IconSet = 'lucide' | 'tabler';

/** What the search compares a query with: the words of a thing, in English and in Hebrew. */
export interface SearchWords {
  /** Drawn as a filled shape rather than in lines. */
  filled: boolean;
  /** The parts of the name, lower case. */
  nameWords: readonly string[];
  /** The set's tags, as single words. */
  tagWords: readonly string[];
  /** Hebrew for the name's words, normalised for comparing: whole terms (such as "hospital"). */
  nameTerms: readonly string[];
  /** The single words of those terms (such as "house", "sick"): a weaker match than a whole term. */
  nameHebrew: readonly string[];
  /** Hebrew for the tags: whole terms, then their single words. */
  tagTerms: readonly string[];
  tagHebrew: readonly string[];
}

export interface IconEntry extends SearchWords {
  /** `lucide:rocket`, `tabler:rocket`, `tabler:rocket-filled`: what `data-icon` takes. */
  id: string;
  set: IconSet;
  /** The name in its set, as the id carries it. */
  name: string;
}

/** English word to the Hebrew terms a user would type for it. */
export type HebrewTags = Readonly<Record<string, readonly string[]>>;

/**
 * The search tags of one thing, in each language: what a user may type to find it beyond its
 * name (a balloon: "birthday", "party"). The media library holds them by kind (`tags/`, ADR-108).
 */
export type Tags = Partial<Record<ContentLanguage, readonly string[]>>;

/** The tags of every thing of a kind, by its key in the kind's catalogue. */
export type TagsOf = Readonly<Record<string, Tags>>;

export interface IconSources {
  /** Lucide's `tags.json`: icon name to tags. */
  lucide: Readonly<Record<string, readonly string[]>>;
  /** Tabler's `icons.json`: icon name to tags and the styles it comes in. */
  tabler: Readonly<
    Record<
      string,
      { tags?: readonly (string | number)[]; styles?: { outline?: unknown; filled?: unknown } }
    >
  >;
  hebrew: HebrewTags;
}

const FINALS: Record<string, string> = { ך: 'כ', ם: 'מ', ן: 'נ', ף: 'פ', ץ: 'צ' };

/**
 * Text as the search compares it: lower case, without niqqud and without the geresh of loan
 * words, and with final letters as ordinary ones, so loanwords match with or without a geresh.
 */
export function normalize(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/([\p{Script=Latin}\p{Script=Hebrew}])\p{M}+/gu, '$1')
    .replace(/['"׳״`’]/g, '')
    .toLowerCase()
    .replace(/[ךםןףץ]/g, (letter) => FINALS[letter] ?? letter);
}

/** The words of a text, normalised. */
export function wordsOf(text: string): string[] {
  return normalize(text)
    .split(/[^\p{L}\p{M}\p{N}]+/u)
    .filter(Boolean);
}

const isHebrew = (word: string) => /\p{Script=Hebrew}/u.test(word);

/** The one-letter prefixes Hebrew attaches to a word: "the", "and", "in", "to", "from", "that", "as". */
const PREFIXES = 'הובלמשכ';

/** A form a Hebrew word may stand for, and how surely: 1 for the word as typed. */
interface HebrewForm {
  form: string;
  weight: number;
}

/**
 * What a Hebrew word may stand for in the index: itself, itself without an attached prefix
 * (the Hebrew for "the house" also matches "house"), and without a plural ending. The looser
 * forms count for less, and a form that is both is the least sure: "steps" read as "that" and
 * "hearts" is a heart.
 */
function hebrewForms(word: string): HebrewForm[] {
  const forms: HebrewForm[] = [{ form: word, weight: 1 }];
  if (word.length > 3 && PREFIXES.includes(word[0]!))
    forms.push({ form: word.slice(1), weight: 0.4 });
  // After normalising, the plural endings are the Hebrew suffixes "im" and "ot". A plural of
  // four letters can have a singular of two, as many common nouns do.
  for (const { form, weight } of [...forms]) {
    if (form.length >= 4 && (form.endsWith('ימ') || form.endsWith('ות'))) {
      forms.push({ form: form.slice(0, -2), weight: weight === 1 ? 0.6 : 0.25 });
    }
  }
  return forms;
}

/** The Hebrew of some English words: the terms whole, and the single words they are made of. */
export function hebrewOf(
  words: readonly string[],
  hebrew: HebrewTags,
): { terms: string[]; parts: string[] } {
  const terms = new Set<string>();
  const parts = new Set<string>();
  for (const word of words) {
    for (const term of hebrew[word] ?? []) {
      const single = wordsOf(term);
      terms.add(single.join(' '));
      // A term of two words is found by either, though less surely than by the term itself.
      for (const part of single) parts.add(part);
    }
  }
  return { terms: [...terms], parts: [...parts] };
}

function entry(
  set: IconSet,
  name: string,
  filled: boolean,
  tags: readonly (string | number)[],
  hebrew: HebrewTags,
): IconEntry {
  const nameWords = wordsOf(name.replaceAll('-', ' '));
  const known = new Set(nameWords);
  const tagWords = [...new Set(tags.flatMap((tag) => wordsOf(String(tag))))].filter(
    (word) => !known.has(word),
  );
  const named = hebrewOf(nameWords, hebrew);
  const tagged = hebrewOf(tagWords, hebrew);
  const inName = new Set([...named.terms, ...named.parts]);
  return {
    id: `${set}:${name}${filled ? '-filled' : ''}`,
    set,
    name: filled ? `${name}-filled` : name,
    filled,
    nameWords,
    tagWords,
    nameTerms: named.terms,
    nameHebrew: named.parts,
    tagTerms: tagged.terms.filter((term) => !inName.has(term)),
    tagHebrew: tagged.parts.filter((term) => !inName.has(term)),
  };
}

/** The words of `add` that `taken` does not have yet, in their order, after those of `words`. */
function joined(words: readonly string[], add: readonly string[], taken: Set<string>): string[] {
  const all = [...words];
  for (const word of add) {
    if (taken.has(word)) continue;
    taken.add(word);
    all.push(word);
  }
  return all;
}

/**
 * A thing's words with its tags added: the words of the English tags among its tag words, and
 * each Hebrew tag as a whole term and as the single words it is made of. A word its name has
 * already is not added again.
 */
export function withTags<T extends SearchWords>(words: T, tags: Tags | undefined): T {
  if (!tags) return words;
  const english = Object.entries(tags)
    .filter(([lang]) => lang !== 'he')
    .flatMap(([, own]) => (own ?? []).flatMap(wordsOf));
  const hebrew = (tags.he ?? []).map((tag) => wordsOf(tag)).filter((tag) => tag.length > 0);
  const named = [...words.nameTerms, ...words.nameHebrew];
  return {
    ...words,
    tagWords: joined(words.tagWords, english, new Set([...words.nameWords, ...words.tagWords])),
    tagTerms: joined(
      words.tagTerms,
      hebrew.map((tag) => tag.join(' ')),
      new Set([...named, ...words.tagTerms]),
    ),
    tagHebrew: joined(words.tagHebrew, hebrew.flat(), new Set([...named, ...words.tagHebrew])),
  };
}

/**
 * The index of the whole library: Lucide first, then Tabler's line icons, then its filled ones.
 * The library's tags of an icon (`lucide:cake`, `tabler:cake`) are those of both its styles.
 */
export function buildIndex(sources: IconSources, tagged: TagsOf = {}): IconEntry[] {
  const index: IconEntry[] = [];
  for (const [name, tags] of Object.entries(sources.lucide)) {
    index.push(
      withTags(entry('lucide', name, false, tags, sources.hebrew), tagged[`lucide:${name}`]),
    );
  }
  const filled: IconEntry[] = [];
  for (const [name, icon] of Object.entries(sources.tabler)) {
    const tags = icon.tags ?? [];
    const own = tagged[`tabler:${name}`];
    if (icon.styles?.outline) {
      index.push(withTags(entry('tabler', name, false, tags, sources.hebrew), own));
    }
    if (icon.styles?.filled) {
      filled.push(withTags(entry('tabler', name, true, tags, sources.hebrew), own));
    }
  }
  return [...index, ...filled];
}

/**
 * The dictionary the other way round: a Hebrew term, normalised, to the English word it stands
 * for. The dictionary lists the commonest words first, so a term that translates several words
 * goes to the commonest of them.
 */
export function hebrewToEnglish(hebrew: HebrewTags): Map<string, string> {
  const english = new Map<string, string>();
  for (const [word, terms] of Object.entries(hebrew)) {
    for (const term of terms) {
      const key = wordsOf(term).join(' ');
      if (key && !english.has(key)) english.set(key, word);
    }
  }
  return english;
}

/**
 * A query in English, for a photo library that only indexes English: every Hebrew word is
 * replaced by the English word the dictionary has for it. Returns null when the query has no
 * Hebrew in it, or has a Hebrew word the dictionary does not know: it is then sent as typed.
 */
export function englishQuery(query: string, english: ReadonlyMap<string, string>): string | null {
  const words = wordsOf(query);
  if (!words.some(isHebrew)) return null;
  // The whole phrase first: the two Hebrew words for "calendar" are one thing.
  const phrase = english.get(words.join(' '));
  if (phrase) return phrase;
  const translated: string[] = [];
  for (const word of words) {
    if (!isHebrew(word)) {
      translated.push(word);
      continue;
    }
    const found = hebrewForms(word)
      .map(({ form }) => english.get(form))
      .find((match) => match !== undefined);
    if (!found) return null;
    translated.push(found);
  }
  return translated.join(' ');
}

export interface IconSearchOptions {
  count: number;
  /** `line`: the outline icons, which share one style. `filled`: Tabler's filled ones. */
  style?: 'line' | 'filled';
}

/** How well one word of the query matches one icon; 0 when it does not. */
function score(icon: SearchWords, word: string): number {
  if (isHebrew(word)) {
    let best = 0;
    hebrewForms(word).forEach(({ form, weight }) => {
      // A whole term of the name (Hebrew for "house"), then a word of one (the same word in
      // Hebrew for "hospital"), then the same for the tags; then the beginning of a word.
      if (icon.nameTerms.includes(form)) best = Math.max(best, 80 * weight);
      else if (icon.nameHebrew.includes(form)) best = Math.max(best, 60 * weight);
      else if (icon.tagTerms.includes(form)) best = Math.max(best, 45 * weight);
      else if (icon.tagHebrew.includes(form)) best = Math.max(best, 30 * weight);
      else if (form.length >= 2 && icon.nameHebrew.some((term) => term.startsWith(form))) {
        best = Math.max(best, 40 * weight);
      } else if (form.length >= 2 && icon.tagHebrew.some((term) => term.startsWith(form))) {
        best = Math.max(best, 20 * weight);
      }
    });
    return best;
  }
  if (icon.nameWords.includes(word)) return 100;
  if (icon.tagWords.includes(word)) return 50;
  // These languages do not separate every word with spaces. A query can be inside a tag.
  if (
    word.length >= 2 &&
    /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(word)
  ) {
    if (icon.tagWords.some((tag) => tag.includes(word))) return 25;
  }
  if (word.length >= 2 && icon.nameWords.some((part) => part.startsWith(word))) return 60;
  if (word.length >= 3 && icon.tagWords.some((tag) => tag.startsWith(word))) return 25;
  return 0;
}

/**
 * The icons that match every word of the query, best first. Among equal matches the simpler
 * icon comes first (`heart` before `heart-handshake`), and an icon of the first set before its
 * twin in the second.
 */
export function searchIcons<T extends SearchWords = IconEntry>(
  index: readonly T[],
  query: string,
  options: IconSearchOptions,
): T[] {
  const words = wordsOf(query);
  if (words.length === 0) return [];
  // "rocket filled" asks for the filled style by name.
  const wantsFilled = options.style === 'filled';
  const matches: { icon: T; total: number; order: number }[] = [];
  index.forEach((icon, order) => {
    if (icon.filled !== wantsFilled) return;
    let total = 0;
    for (const word of words) {
      const points = score(icon, word);
      if (points === 0) return;
      total += points;
    }
    // The whole name, word for word, is the best match there is.
    if (words.length === icon.nameWords.length && words.every((w, i) => icon.nameWords[i] === w)) {
      total += 100;
    }
    matches.push({ icon, total, order });
  });
  matches.sort(
    (a, b) =>
      b.total - a.total || a.icon.nameWords.length - b.icon.nameWords.length || a.order - b.order,
  );
  return matches.slice(0, options.count).map((match) => match.icon);
}
