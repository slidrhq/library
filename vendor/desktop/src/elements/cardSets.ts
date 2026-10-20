import { readMediaJson } from '@slidr/media-library';
import {
  cloneElement,
  createDeck,
  createElement,
  createSlide,
  languageDir,
  newId,
  plainText,
  walkElements,
  type Deck,
  type Direction,
  type Element,
  type Frame,
  type GroupElement,
  type Slide,
  type Theme,
} from '@slidr/model';
import { resizeGroup } from '../stage/groups';

interface Size {
  w: number;
  h: number;
}
export interface Reading {
  he: boolean;
  rtl: boolean;
}
export const readingOf = (meta: { lang: string; dir: Direction }): Reading => ({
  he: meta.lang.toLowerCase().startsWith('he'),
  rtl: meta.dir === 'rtl',
});
/** The reading of a new set in a language: its words, and its cards from the side it reads from. */
export const readingIn = (lang: string): Reading => readingOf({ lang, dir: languageDir(lang) });

interface CardSetDesign {
  starts: number;
  kinds: number;
  perRow: number;
  most: number;
  gap: number;
  height: number;
  card: (kind: number, size: Size, reading: Reading) => Element[];
}
interface MediaDesign extends Omit<CardSetDesign, 'card'> {
  variants: Record<string, Record<string, Element[][]>>;
}
/**
 * The authored cards: the catalog of the media library (`elements/cards/catalog.json`). Without
 * it there are no card sets to add, and a set already on a slide is a plain group.
 */
const read = await readMediaJson<{ order?: unknown; designs?: Record<string, MediaDesign> }>(
  'elements/cards/catalog.json',
);
const catalog = {
  order: Array.isArray(read?.order) ? read.order : [],
  designs: read?.designs ?? {},
};
export type CardSetId = 'pop' | 'steps' | 'stats' | 'plans' | 'voices';
export const CARD_SETS: readonly CardSetId[] = catalog.order.filter(
  (id): id is CardSetId => typeof id === 'string' && id in catalog.designs,
);
/**
 * The sets an interface in `lang` offers. The words of every set are Hebrew and English (the
 * `he-` and `en-` variants), so an interface in another language offers none.
 */
export const cardSetsIn = (lang: string): readonly CardSetId[] =>
  ['he', 'en'].includes(lang.toLowerCase().split('-')[0]!) ? CARD_SETS : [];

const whole = ({ w, h }: Size): Frame => ({ x: 0, y: 0, w, h });
const widthFor = (count: number, design: MediaDesign): number => {
  const rows = Math.ceil(count / design.perRow);
  const columns = Math.ceil(count / rows);
  return (1728 - (columns - 1) * design.gap) / columns;
};
function scaleFrames(element: Element, width: number, height: number): Element {
  const frame = {
    x: element.frame.x * width,
    y: element.frame.y * height,
    w: element.frame.w * width,
    h: element.frame.h * height,
  };
  return element.type === 'group'
    ? {
        ...element,
        frame,
        children: element.children.map((child) => scaleFrames(child, width, height)),
      }
    : { ...element, frame };
}
const DESIGNS = Object.fromEntries(
  Object.entries(catalog.designs).map(([id, design]) => [
    id,
    {
      starts: design.starts,
      kinds: design.kinds,
      perRow: design.perRow,
      most: design.most,
      gap: design.gap,
      height: design.height,
      card: (kind: number, size: Size, reading: Reading): Element[] => {
        const key = (reading.he ? 'he' : 'en') + '-' + (reading.rtl ? 'rtl' : 'ltr');
        const count = Array.from({ length: design.most }, (_, i) => i + 1).sort(
          (a, b) => Math.abs(widthFor(a, design) - size.w) - Math.abs(widthFor(b, design) - size.w),
        )[0]!;
        const authored = design.variants[key]?.[count]?.[kind];
        if (!authored)
          throw new Error('Missing card in media: ' + id + '/' + key + '/' + count + '/' + kind);
        const x = size.w / widthFor(count, design);
        const y = size.h / design.height;
        return authored.map((element) =>
          scaleFrames(
            cloneElement(element, () => newId('e')),
            x,
            y,
          ),
        );
      },
    },
  ]),
) as Record<CardSetId, CardSetDesign>;

/* ---------------------------------------------------------------- the layout of a set */

/** The width of a new set: the slide between its side margins. */
const SET_WIDTH = 1728;
/** The room a set leaves above and below it on the slide, and under what lies above it. */
const MARGIN_Y = 80;
const CLEAR = 24;

/** The part of the slide a set may take as it grows: from `top` down to `bottom`. */
export interface Room {
  top: number;
  bottom: number;
}

/**
 * The room a set has on its slide: down to the bottom margin, and up to the top margin or to
 * what lies above the set now, a title for one. Undefined for a set inside another group, whose
 * frame is not written in the pixels of the slide: such a set stays where it is.
 */
export function roomOn(slide: Slide, set: GroupElement, size: Size): Room | undefined {
  if (!slide.elements.some((element) => element.id === set.id)) return undefined;
  const above = slide.elements
    .filter((element) => !element.hidden && element.frame.y + element.frame.h <= set.frame.y)
    .map((element) => element.frame.y + element.frame.h + CLEAR);
  return { top: Math.max(MARGIN_Y, ...above), bottom: size.h - MARGIN_Y };
}

/** How many cards each row holds: as few rows as the design allows, as even as they come. */
export function rowsOf(count: number, perRow: number): number[] {
  const rows = Math.max(1, Math.ceil(count / perRow));
  const least = Math.floor(count / rows);
  return Array.from({ length: rows }, (_, row) => least + (row < count % rows ? 1 : 0));
}

/** To a thousandth of a pixel; adding 0 turns -0 into 0. */
const round = (value: number) => Math.round(value * 1000) / 1000 + 0;

/**
 * Where the cards of a set go, in reading order, in a set `width` wide: every card as wide as
 * the fullest row leaves it, and a row that is not full in the middle.
 */
function slots(
  count: number,
  { perRow, gap }: CardSetDesign,
  width: number,
  height: number,
  rtl: boolean,
): { frames: Frame[]; total: Size } {
  const rows = rowsOf(count, perRow);
  const columns = Math.max(...rows);
  const w = (width - (columns - 1) * gap) / columns;
  const frames = rows.flatMap((cards, row) => {
    const indent = (width - cards * w - (cards - 1) * gap) / 2;
    return Array.from({ length: cards }, (_, column) => {
      const along = indent + column * (w + gap);
      return {
        x: round(rtl ? width - along - w : along),
        y: row * (height + gap),
        w: round(w),
        h: height,
      };
    });
  });
  return { frames, total: { w: width, h: rows.length * height + (rows.length - 1) * gap } };
}

/** One card of a design, at the corner of whatever holds it. */
function drawCard(id: CardSetId, kind: number, size: Size, reading: Reading): GroupElement {
  return createElement.group({
    frame: whole(size),
    children: DESIGNS[id].card(kind, size, reading),
  });
}

const NAME = 'cards:';

/** The design of a card set on a slide; undefined for any other element. */
export function cardSetOf(element: Element | undefined): CardSetId | undefined {
  if (element?.type !== 'group' || !element.name?.startsWith(NAME)) return undefined;
  const id = element.name.slice(NAME.length);
  return (CARD_SETS as readonly string[]).includes(id) ? (id as CardSetId) : undefined;
}

/** The cards of a set, in reading order: the groups in it. */
export const cardsOf = (set: GroupElement): GroupElement[] =>
  set.children.filter((child): child is GroupElement => child.type === 'group');

const HEBREW = /\p{Script=Hebrew}/u;

/**
 * The reading a set on a slide was made in, which need not be the deck's: a set goes on in the
 * UI language. Its words are Hebrew when a word of it is, and its cards start on the right when
 * its first card is right of its second. What a set cannot tell, a set with no words or with one
 * card a row, is taken from `fallback`.
 */
export function readingOfSet(set: GroupElement, fallback: Reading): Reading {
  const words = [...walkElements(set.children)]
    .map((element) =>
      (element.type === 'text' || element.type === 'shape') && element.content
        ? plainText(element.content)
        : '',
    )
    .join('');
  const [first, second] = cardsOf(set);
  const inRow = first && second && Math.abs(first.frame.y - second.frame.y) < 0.5;
  return {
    he: words.trim() ? HEBREW.test(words) : fallback.he,
    rtl: inRow ? first.frame.x > second.frame.x : fallback.rtl,
  };
}

/** How many different cards a design has, and the most a set of it holds. */
export const cardKinds = (id: CardSetId): number => DESIGNS[id].kinds;
export const mostCards = (id: CardSetId): number => DESIGNS[id].most;

/** A new set as it goes onto a slide, its corner at the corner of the slide. */
export function newCardSet(id: CardSetId, reading: Reading): GroupElement {
  const design = DESIGNS[id];
  const { frames, total } = slots(design.starts, design, SET_WIDTH, design.height, reading.rtl);
  return createElement.group({
    frame: whole(total),
    name: `${NAME}${id}`,
    children: frames.map((frame, kind) => ({ ...drawCard(id, kind, frame, reading), frame })),
  });
}

/** One card of a design alone, at the size it has in a new set: for the picture of a kind. */
export function sampleCard(id: CardSetId, kind: number, reading: Reading): GroupElement {
  const design = DESIGNS[id];
  const { frames } = slots(design.starts, design, SET_WIDTH, design.height, reading.rtl);
  return drawCard(id, kind, frames[0]!, reading);
}

const near = (a: number, b: number) => Math.abs(a - b) < 0.5;

/** An element with the patches of a stretch, at any depth. */
function patched(element: Element, patches: ReadonlyMap<string, object>): Element {
  const next = { ...element, ...patches.get(element.id) };
  return next.type === 'group'
    ? { ...next, children: next.children.map((child) => patched(child, patches)) }
    : next;
}

/**
 * A card in the place a set gives it. A card that still has the parts its design drew takes the
 * frames the design gives those parts at the new size, and keeps everything else: its words, its
 * colours. Any other card is stretched as a handle would stretch it.
 */
function seated(card: GroupElement, slot: Frame, id: CardSetId, reading: Reading): GroupElement {
  if (near(card.frame.w, slot.w) && near(card.frame.h, slot.h)) return { ...card, frame: slot };
  const design = DESIGNS[id];
  for (let kind = 0; kind < design.kinds; kind++) {
    const parts = design.card(kind, slot, reading);
    const same =
      parts.length === card.children.length &&
      parts.every((part, index) => part.type === card.children[index]?.type);
    if (!same) continue;
    return {
      ...card,
      frame: slot,
      children: card.children.map((child, index) => ({ ...child, frame: parts[index]!.frame })),
    };
  }
  const stretched = patched(card, resizeGroup(card, { ...card.frame, w: slot.w, h: slot.h }));
  return { ...(stretched as GroupElement), frame: slot };
}

/** Where `count` cards go in a set on a slide: in the width it has, as tall as its cards are. */
function slotsIn(set: GroupElement, id: CardSetId, count: number, reading: Reading) {
  const design = DESIGNS[id];
  const height = cardsOf(set)[0]?.frame.h ?? design.height;
  return slots(count, design, set.frame.w, height, reading.rtl);
}

/**
 * A set with the given cards, laid out in the width the set has. It keeps its top where it is
 * while it fits in its room on the slide, and moves up when it does not, as far as the room
 * goes: never over what lies above it. What else the user put in the group stays, under the
 * cards.
 */
function arranged(
  set: GroupElement,
  id: CardSetId,
  cards: readonly GroupElement[],
  reading: Reading,
  room: Room | undefined,
): GroupElement {
  const { frames, total } = slotsIn(set, id, cards.length, reading);
  const { y: top } = set.frame;
  const y = room ? Math.max(Math.min(top, room.bottom - total.h), Math.min(top, room.top)) : top;
  return {
    ...set,
    frame: { x: set.frame.x, y, ...total },
    children: [
      ...set.children.filter((child) => child.type !== 'group'),
      ...cards.map((card, index) => seated(card, frames[index]!, id, reading)),
    ],
  };
}

/**
 * The set with one more card of the given kind, after its last one; undefined for an element
 * that is no card set, and for a set that is full.
 */
export function withCard(
  set: Element,
  kind: number,
  reading: Reading,
  room?: Room,
): GroupElement | undefined {
  const id = cardSetOf(set);
  if (!id || set.type !== 'group') return undefined;
  const cards = cardsOf(set);
  const design = DESIGNS[id];
  if (cards.length >= design.most || kind < 0 || kind >= design.kinds) return undefined;
  // Drawn at the size its place in the set gives it.
  const place = slotsIn(set, id, cards.length + 1, reading).frames.at(-1)!;
  const card = { ...drawCard(id, kind, place, reading), frame: place };
  return arranged(set, id, [...cards, card], reading, room);
}

/**
 * The set without one of its cards, the others closed up; undefined when the card is not one of
 * the set's, and for the last card of a set, which goes with the set.
 */
export function withoutCard(
  set: Element,
  cardId: string,
  reading: Reading,
  room?: Room,
): GroupElement | undefined {
  const id = cardSetOf(set);
  if (!id || set.type !== 'group') return undefined;
  const cards = cardsOf(set);
  if (cards.length < 2 || !cards.some((card) => card.id === cardId)) return undefined;
  const kept = cards.filter((card) => card.id !== cardId);
  const rest = { ...set, children: set.children.filter((child) => child.id !== cardId) };
  return arranged(rest, id, kept, reading, room);
}

/* ---------------------------------------------------------------- in the panel */

/**
 * An element alone on a slide with no ground, `pad` from its corner so that its shadow has room:
 * for a picture of it that the renderer draws.
 */
export function cardPicture(
  element: GroupElement,
  meta: { lang: string; dir: Direction },
  theme: Theme,
  pad: number,
): { deck: Deck; slide: Slide; size: Size } {
  const { w, h } = element.frame;
  const slide = createSlide({
    elements: [{ ...element, frame: { x: pad, y: pad, w, h } }],
    background: { fill: { kind: 'none' } },
  });
  return {
    deck: createDeck({ lang: meta.lang, dir: meta.dir, theme, slides: [slide] }),
    slide,
    size: { w: w + 2 * pad, h: h + 2 * pad },
  };
}
