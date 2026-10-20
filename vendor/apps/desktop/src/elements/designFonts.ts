import {
  LANGUAGE_SCRIPT,
  type ContentLanguage,
  type Element,
  type FontFamilyEntry,
  type RichText,
  type Slide,
  type TextElement,
} from '@slidr/model';

/*
 * The fonts of a design in a language other than Hebrew and English. A design is drawn in Hebrew
 * and English, and its other languages are written from one of them: the left-to-right ones from
 * the English slide, Arabic from the Hebrew one it mirrors. Each text keeps the character of the
 * family its source sets it in. Where that family has the language's letters, the text stays in
 * it; where not, it takes the family the font catalog names as the family's counterpart in the
 * language's letters (`fonts/catalog.json`, written by
 * `scripts/gen-builtin-fonts.mjs`): a serif for a serif, a rounded face for a rounded one. So no
 * language is set in one family because it is the one with the letters, and none is left to the
 * fonts of the system. `scripts/design-fonts.mjs` applies it to the designs of the library.
 */

/** The library's fonts as the conversion needs them: each family, and the weights it has. */
export interface FontShelf {
  families: ReadonlyMap<string, FontFamilyEntry>;
  /** The weights of a family's upright faces: every hundred of a variable range. */
  weights: ReadonlyMap<string, readonly number[]>;
}

/** The shelf of a font catalog. */
export function fontShelf(catalog: {
  families: readonly FontFamilyEntry[];
  faces: readonly { family: string; style: string; weight: string }[];
}): FontShelf {
  const weights = new Map<string, Set<number>>();
  for (const face of catalog.faces) {
    if (face.style !== 'normal') continue;
    const [from = 400, to = from] = face.weight.split(/\s+/).map(Number);
    const set = weights.get(face.family) ?? new Set<number>();
    for (let w = Math.ceil(from / 100) * 100; w <= to; w += 100) set.add(w);
    weights.set(face.family, set);
  }
  return {
    families: new Map(catalog.families.map((entry) => [entry.family, entry])),
    weights: new Map([...weights].map(([family, set]) => [family, [...set].sort((a, b) => a - b)])),
  };
}

/** The letters of each script, as a text shows them. */
const LETTERS: Record<string, RegExp> = {
  he: /[\u0590-\u05ff]/,
  arabic: /[\u0600-\u06ff\u0750-\u077f\u08a0-\u08ff\ufb50-\ufdff\ufe70-\ufeff]/,
  devanagari: /[\u0900-\u097f]/,
  japanese: /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uff66-\uff9f]/,
  korean: /[\u1100-\u11ff\u3130-\u318f\uac00-\ud7af]/,
  chinese: /[\u3400-\u4dbf\u4e00-\u9fff]/,
};

/**
 * The family a text in `lang` is set in where its source sets it in `family`: the family itself
 * when it has the language's letters (the figures of an English design in Frank Ruhl Libre stay
 * in it in German), else its counterpart in the language's letters. A text with none of the
 * letters of a script unlike Latin (a year, a word in English) keeps a family made for Latin
 * letters, as the Hebrew design kept its Latin figures. Undefined for a family the catalog does
 * not know, or one with no counterpart.
 */
export function familyIn(
  shelf: FontShelf,
  family: string,
  lang: ContentLanguage,
  text: string,
): string | undefined {
  const entry = shelf.families.get(family);
  if (!entry) return undefined;
  const script = LANGUAGE_SCRIPT[lang];
  if (entry.scripts.includes(script)) return family;
  const letters = LETTERS[script];
  const made = entry.for ?? entry.scripts.slice(0, 1);
  if (letters && !letters.test(text) && made.includes('latin')) return family;
  return entry.counterparts?.[script];
}

/**
 * The weight of `family` nearest to `weight`: the same where it has it. Between two as near, the
 * heavier for a weight of 500 or more and the lighter below, as a browser chooses a face.
 */
export function nearestWeight(shelf: FontShelf, family: string, weight: number): number {
  const has = shelf.weights.get(family) ?? [];
  const nearer = (a: number, b: number) => {
    const by = Math.abs(a - weight) - Math.abs(b - weight);
    return by < 0 || (by === 0 && (weight >= 500 ? a > b : a < b));
  };
  return has.reduce((best, w) => (nearer(w, best) ? w : best), has[0] ?? weight);
}

/** A text of a slide, and the text box it is the content of, if it is one. */
interface Held {
  text: RichText;
  box?: TextElement;
}

/** The texts of an element in the order they are read: a group's children's, a table's cells'. */
function textsOf(element: Element): Held[] {
  if (element.type === 'group') return element.children.flatMap(textsOf);
  if (element.type === 'table') return element.cells.flat().map((cell) => ({ text: cell.content }));
  if (element.type === 'text') return [{ text: element.content, box: element }];
  const content = (element as { content?: unknown }).content;
  return content && typeof content === 'object' && 'paragraphs' in content
    ? [{ text: content as RichText }]
    : [];
}

/** Every text of a slide, each with the id of the element it is in and its place there. */
function texts(slide: Slide): (Held & { key: string })[] {
  return slide.elements.flatMap((element) =>
    textsOf(element).map((held, at) => ({ ...held, key: `${element.id}#${at}` })),
  );
}

/** A change a conversion made, for its report. */
export interface FontChange {
  from: string;
  to: string;
}

/**
 * `slide`, a design written in `lang` from `source` (its English slide, or the Hebrew one for a
 * right-to-left language), with each run set in the family of the language for the family the
 * source sets the same run in (`familyIn`), at the nearest weight that family has (bold for a
 * family of one face that looks bold, `looks`). The texts of the two are paired by element, else in
 * order when they have as many; a run without a partner takes its own family's. A slide whose
 * texts cannot be paired is set from its own families. A text box whose family changed and that
 * did not fit its text to its frame now shrinks it to fit (`autoFit: 'shrink'`): the text was
 * written to the measure of the family it had, and the new one may run wider and take more lines.
 * The fit is of the height: a box that keeps its text on one line (`wrap: false`) and a shape are
 * left to the review of the rendered slide (AGENTS.md).
 */
export function setInLanguage(
  slide: Slide,
  source: Slide,
  lang: ContentLanguage,
  shelf: FontShelf,
): { slide: Slide; changes: FontChange[] } {
  const copy = structuredClone(slide);
  const mine = texts(copy);
  const theirs = texts(source);
  const byKey = new Map(theirs.map((entry) => [entry.key, entry.text]));
  const byKeyAll = mine.every((entry) => byKey.has(entry.key));
  const inOrder = !byKeyAll && mine.length === theirs.length;
  const changes: FontChange[] = [];
  mine.forEach(({ key, text, box }, at) => {
    const partner = byKeyAll ? byKey.get(key) : inOrder ? theirs[at]?.text : undefined;
    const before = changes.length;
    text.paragraphs.forEach((paragraph, p) => {
      const along = partner?.paragraphs[Math.min(p, partner.paragraphs.length - 1)];
      paragraph.runs.forEach((run, r) => {
        const own = run.marks?.font;
        if (!own) return;
        const from = along?.runs[Math.min(r, along.runs.length - 1)]?.marks?.font ?? own;
        const to = familyIn(shelf, from, lang, run.text) ?? familyIn(shelf, own, lang, run.text);
        if (!to) return;
        const weight = run.marks?.weight;
        // A family of one face that looks bold (DM Serif Display) is set bold in its counterpart.
        const looks = to === from ? undefined : shelf.families.get(from)?.looks;
        const asked = looks === undefined ? weight : Math.max(weight ?? 400, looks);
        const nearest = asked === undefined ? undefined : nearestWeight(shelf, to, asked);
        if (to === own && nearest === weight) return;
        run.marks = {
          ...run.marks,
          font: to,
          ...(nearest === undefined ? {} : { weight: nearest }),
        };
        changes.push({ from: own, to });
      });
    });
    if (box?.autoFit === 'none' && changes.length > before) box.autoFit = 'shrink';
  });
  return { slide: copy, changes };
}
