import { lazyMediaJson } from '@slidr/media-library';
import {
  contentLanguageOf,
  createDeck,
  createElement,
  createSlide,
  frameLayout,
  LANGUAGE_SCRIPT,
  locateElement,
  normalizeAngle,
  plainText,
  richText,
  updateElement,
  type AssetMeta,
  type Color,
  type Command,
  type Deck,
  type Element,
  type ElementPatch,
  type Frame,
  type GroupElement,
  type ImageElement,
  type RichText,
  type Shadow,
  type Slide,
  type SmartImageFrame,
  type SvgElement,
  type SvgStretch,
  type TextElement,
  type Theme,
} from '@slidr/model';
import { presetPath } from '@slidr/renderer';
import { searchTags } from '../media/icons/library';
import {
  searchIcons,
  withTags,
  wordsOf,
  type SearchWords,
  type TagsOf,
} from '../media/icons/search';

/*
 * The photo frames of the Elements panel. A frame is a picture that waits for its photograph:
 * it goes onto a slide as an `image` element with no file yet, and whatever photograph it is
 * given is cut to the frame's outline. A decorated frame also draws artwork around the
 * photograph (an instant photo, a phone, a picture frame), which the element carries with it,
 * so a deck shows it wherever it is opened. The magnet of an event comes with stickers, captions
 * and labels beside its picture: on a slide it is a group, the picture and those around it.
 *
 * The catalogue says what is offered, group by group; `scripts/generate-frames-catalog.mjs`
 * writes it. It is read as text and parsed the first time the frames are shown.
 */

/** The groups of frames, in the order the panel shows them. */
export const FRAME_GROUPS = [
  'basic',
  'photo',
  'framed',
  'magnets',
  'devices',
  'arches',
  'organic',
  'brush',
  'composed',
  'hebrew',
  'latin',
  'digits',
  'nature',
  'bubbles',
  'labels',
] as const;
export type FrameGroup = (typeof FRAME_GROUPS)[number];

/**
 * The sets of the magnets, in the order the panel shows them: what the event is, or that the
 * magnet is a style with no event (`MAGNET_SETS` in `scripts/frames-magnets.mjs`).
 */
export const MAGNET_SETS = [
  'family',
  'birthdays',
  'kids',
  'school',
  'work',
  'leisure',
  'holidays',
  'styles',
] as const;
export type MagnetSet = (typeof MAGNET_SETS)[number];

export type FrameMask = NonNullable<ImageElement['mask']>;

interface Size {
  w: number;
  h: number;
}

/**
 * The artwork of a decorated frame, in the frame's own box. The photograph shows through
 * `opening`. `clip` cuts it there, as path data in the opening's box, and `round` rounds its
 * corners; artwork that lies over the photograph's corners needs neither.
 *
 * `drawing` is the artwork itself: an SVG that lays itself out in a box of any size
 * (`scripts/frames-art.mjs`). A frame that is made larger keeps its artwork as it is, and its
 * opening takes up the change.
 */
export interface FrameArt {
  opening: Frame;
  clip?: string;
  round?: number;
  drawing: string;
}

/** Where something sits beside the picture of a frame, in the frame's box. */
interface Placed {
  x: number;
  y: number;
  w: number;
  h: number;
  /** Degrees, clockwise. */
  rotation?: number;
  /** It lies under the picture, and shows where the card leaves the box of the frame bare. */
  under?: boolean;
}

/** How a caption is set in one language. Without a font it is in the deck's own. */
export interface CaptionWords {
  text: string;
  size: number;
  font?: string;
  weight?: number;
  spacing?: number;
  italic?: boolean;
}

/** A drawing of the catalogue's `stickers`, by its name there. */
type StickerExtra = Placed & { kind: 'sticker'; art: string; flip?: boolean };

/**
 * A line of words, in the middle of its box unless `align` sets it to one side, the same side
 * in both languages. `colors` paints its letters one after the other, in turn.
 */
type CaptionExtra = Placed & {
  kind: 'caption';
  he: CaptionWords;
  en: CaptionWords;
  color: Color;
  colors?: readonly string[];
  align?: 'left' | 'right';
};

/**
 * A plate with words on it: a ribbon, a badge, a tag. The plate is a drawing of the catalogue's
 * `stickers`, and the boxes of its `lines` are written from the corner of the plate.
 */
type LabelExtra = Placed & {
  kind: 'label';
  art: string;
  flip?: boolean;
  lines: readonly CaptionExtra[];
  /** Flexible strips of the plate; its ends and any ornament between strips keep their size. */
  stretch?: Pick<SvgStretch, 'x' | 'y'>;
};

/**
 * What a frame puts on the slide beside its picture. Each is an element of its own, so a
 * caption is typed over, and a sticker that hides a face is moved or deleted. A label is a
 * group of its own, the plate and its words: it is moved as one.
 */
export type FrameExtra =
  (StickerExtra & { markup: string }) | CaptionExtra | (LabelExtra & { markup: string });

/** A frame as the catalogue has it: `d` cuts the photograph to an outline in a box of w by h. */
interface CatalogFrame extends Size {
  id: string;
  en: string;
  he: string;
  mask?: FrameMask;
  d?: string;
  art?: FrameArt;
  extras?: readonly (StickerExtra | CaptionExtra | LabelExtra)[];
  shadow?: Shadow;
  /** The set of the magnets it is shown in. */
  set?: string;
  /** More words it is found by. */
  tags?: { en?: string; he?: string };
}

export interface FramesCatalog {
  /** The frames shown first, by id. */
  featured: readonly string[];
  /** The stickers of the frames, by name: a whole SVG each. */
  stickers?: Readonly<Record<string, string>>;
  groups: readonly { id: string; frames: readonly CatalogFrame[] }[];
}

export interface PhotoFrame extends SearchWords {
  /** `frame:instant`: the name of the element it becomes. */
  id: string;
  group: FrameGroup;
  /** What it is called, by the language of the interface. */
  label: { en: string; he: string };
  /** Its box on a slide when it is added, in slide pixels. The artwork is drawn in this box. */
  size: Size;
  /** What cuts the photograph, at that size. A plain box and a decorated frame may have none. */
  mask?: FrameMask;
  art?: FrameArt;
  /** What it puts beside its picture: with any, it is a group on the slide. */
  extras?: readonly FrameExtra[];
  /** The shadow the frame casts, the photograph and all: none of it falls on the photograph. */
  shadow?: Shadow;
  /** Its place among the frames shown first, when it is one of them. */
  featured?: number;
  /** The set it is shown in, when it is a magnet. */
  set?: MagnetSet;
}

/**
 * Every frame of the catalogue, group by group. Its words are its names, the words the catalogue
 * gives it, and the library's tags for it (`tags/frames.json`, by its id there).
 */
export function framesOf(catalog: FramesCatalog, tagged: TagsOf = {}): PhotoFrame[] {
  return catalog.groups.flatMap(({ id: group, frames }) =>
    frames.map(({ id, en, he, w, h, mask, d, art, extras, shadow, set, tags }): PhotoFrame => {
      const nameWords = wordsOf(en);
      const nameHebrew = wordsOf(he);
      const cut = d ? ({ kind: 'path', d, viewBox: { w, h } } as const) : mask;
      const featured = catalog.featured.indexOf(id);
      const beside = (extras ?? []).flatMap((extra): FrameExtra[] => {
        if (extra.kind === 'caption') return [extra];
        const markup = catalog.stickers?.[extra.art];
        return markup ? [{ ...extra, markup }] : [];
      });
      const frame: PhotoFrame = {
        id: `frame:${id}`,
        group: group as FrameGroup,
        label: { en, he },
        size: { w, h },
        ...(cut ? { mask: cut } : {}),
        ...(art ? { art } : {}),
        ...(beside.length > 0 ? { extras: beside } : {}),
        ...(shadow ? { shadow } : {}),
        ...(featured < 0 ? {} : { featured }),
        ...(MAGNET_SETS.includes(set as MagnetSet) ? { set: set as MagnetSet } : {}),
        filled: false,
        nameWords,
        tagWords: wordsOf(tags?.en ?? '').filter((word) => !nameWords.includes(word)),
        nameTerms: [nameHebrew.join(' ')],
        nameHebrew,
        tagTerms: [],
        tagHebrew: wordsOf(tags?.he ?? '').filter((word) => !nameHebrew.includes(word)),
      };
      return withTags(frame, tagged[id]);
    }),
  );
}

const catalog = lazyMediaJson<FramesCatalog>('elements/catalogs/frames-catalog.json');

let frames: Promise<PhotoFrame[]> | undefined;
let atHand: readonly PhotoFrame[] | undefined;

export function loadFrames(): Promise<PhotoFrame[]> {
  frames ??= Promise.all([catalog(), searchTags('frames')])
    .then(([read, tags]) => framesOf(read, tags))
    .then((all) => (atHand = all))
    .catch((error: unknown) => {
      frames = undefined;
      throw error;
    });
  return frames;
}

/**
 * The frames, when they were loaded already: for what cannot wait for them, a drag of a handle.
 * Not there yet, they are asked for, and are there for the next move of the drag.
 */
export function framesAtHand(): readonly PhotoFrame[] | undefined {
  if (!atHand) void loadFrames().catch(() => undefined);
  return atHand;
}

/** The frames shown first, in the order the catalogue names them. */
export function featuredFrames(all: readonly PhotoFrame[]): PhotoFrame[] {
  return all
    .filter((frame) => frame.featured !== undefined)
    .sort((a, b) => (a.featured ?? 0) - (b.featured ?? 0));
}

/** The scripts of the fonts' tags (`LANGUAGE_SCRIPT`) that are written in the Latin alphabet. */
const LATIN = ['latin', 'vietnamese'];

/**
 * Whether an interface in `lang` offers a frame. The letters of an alphabet are offered in the
 * languages written in it: the `hebrew` frames in Hebrew, the `latin` ones in the languages of
 * the Latin alphabet, Vietnamese among them. A frame with words beside its picture, a magnet's
 * captions and labels, is offered in Hebrew and English, the languages it is written in. Any
 * other frame has no language and is offered in all of them.
 */
export function frameIn(frame: PhotoFrame, lang: string): boolean {
  const own = contentLanguageOf(lang);
  if (frame.group === 'hebrew') return own === 'he';
  if (frame.group === 'latin') return own !== undefined && LATIN.includes(LANGUAGE_SCRIPT[own]);
  const worded = frame.extras?.some((extra) => extra.kind !== 'sticker');
  return !worded || own === 'he' || own === 'en';
}

/** The frames an interface in `lang` offers (`frameIn`), in their order. */
export const framesIn = (all: readonly PhotoFrame[], lang: string): PhotoFrame[] =>
  all.filter((frame) => frameIn(frame, lang));

/** The frames that match every word of a query in Hebrew or English, best first. */
export function searchFrames(all: readonly PhotoFrame[], query: string, count: number) {
  return searchIcons(all, query, { count });
}

/* ---------------------------------------------------------------- on a slide */

/** How much larger than the frame was drawn a box of its proportions is. */
const scaleIn = (frame: PhotoFrame, box: Size): number =>
  Math.round(Math.min(box.w / frame.size.w, box.h / frame.size.h) * 1e4) / 1e4;

/**
 * What a frame makes of the picture it holds, in a box of the given size: the cut of the
 * photograph and the artwork around it. Null takes away what another frame left there.
 *
 * The artwork is drawn as large as the box is to the frame's own, and keeps that size from then
 * on: a picture that is made larger has the same artwork around a larger photograph.
 */
export function frameLook(
  frame: PhotoFrame,
  box: Size,
): { mask: FrameMask | null; smartFrame: SmartImageFrame | null } {
  const { size, art } = frame;
  if (art) {
    const { opening } = art;
    return {
      mask: art.clip
        ? { kind: 'path', d: art.clip, viewBox: { w: opening.w, h: opening.h } }
        : art.round
          ? { kind: 'rounded', radius: art.round }
          : null,
      smartFrame: {
        viewBox: { ...size },
        opening: { ...opening },
        scale: scaleIn(frame, box),
        decorations: [createElement.svg({ frame: { x: 0, y: 0, ...size }, markup: art.drawing })],
      },
    };
  }
  const { mask } = frame;
  if (mask?.kind !== 'rounded') return { mask: mask ?? null, smartFrame: null };
  // Round corners are in slide pixels: in a box of another size they keep their proportion.
  const scale = Math.min(box.w / size.w, box.h / size.h);
  return { mask: { kind: 'rounded', radius: Math.round(mask.radius * scale) }, smartFrame: null };
}

/**
 * A frame as a new element: a picture with no photograph yet, in the given box. `alone`, it
 * casts the frame's shadow itself; with stickers and a caption beside it, their group does.
 */
export function frameElement(frame: PhotoFrame, box: Frame, alone = true): ImageElement {
  const { mask, smartFrame } = frameLook(frame, box);
  return createElement.image({
    frame: box,
    name: frame.id,
    ...(mask ? { mask } : {}),
    ...(smartFrame ? { smartFrame } : {}),
    ...(alone && frame.shadow ? { effects: { shadow: frame.shadow } } : {}),
  });
}

/**
 * The height of a caption's line, as a multiple of its size. A caption is one line of display
 * type: the catalogue gives it a box that holds the line as it is, so nothing has to shrink.
 */
const CAPTION_LEADING = 1.15;

/** A caption with its letters painted one after the other, in turn; a space takes no colour. */
function painted(content: RichText, colors: readonly string[]): RichText {
  const letters = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  let at = 0;
  return {
    paragraphs: content.paragraphs.map((paragraph) => ({
      ...paragraph,
      runs: paragraph.runs.flatMap((run) =>
        Array.from(letters.segment(run.text), ({ segment }) => {
          const value = segment.trim() ? colors[at++ % colors.length] : undefined;
          return { text: segment, marks: { ...run.marks, ...(value ? { color: { value } } : {}) } };
        }),
      ),
    })),
  };
}

/** What a frame puts beside its picture, those that lie under the picture first. */
const inOrder = (extras: readonly FrameExtra[] = []): FrameExtra[] => [
  ...extras.filter((extra) => extra.under),
  ...extras.filter((extra) => !extra.under),
];

/** The lines of words a frame comes with, in the order its group holds them. */
const linesOf = (extras?: readonly FrameExtra[]): CaptionExtra[] =>
  inOrder(extras).flatMap((extra) =>
    extra.kind === 'caption' ? [extra] : extra.kind === 'label' ? extra.lines : [],
  );

/** The name of the group a label is on a slide: the plate and its words. */
const labelName = (frame: PhotoFrame, label: { art: string }) => `${frame.id}:label:${label.art}`;

/** Also understood for a catalogue from before the flexible strips were recorded. */
function labelStretch(extra: LabelExtra, scale: number): SvgStretch {
  const end = Math.min(extra.w / 4, extra.h);
  return {
    viewBox: { w: extra.w, h: extra.h },
    scale,
    ...(extra.stretch ?? { x: [[end, extra.w - end]], y: [[extra.h / 3, (2 * extra.h) / 3]] }),
  };
}

/**
 * What a frame puts beside its picture, as new elements in a box of the given size, placed from
 * the corner of the box: the stickers, the captions in the language of the deck, and the labels,
 * each a group of its plate and its words. `words` are said in place of the lines' own, one
 * after the other. What lies under the picture is apart from what lies over it.
 */
export function frameExtras(
  frame: PhotoFrame,
  box: Size,
  lang: string,
  words: readonly (string | undefined)[] = [],
): { under: Element[]; over: Element[] } {
  const hebrew = lang.startsWith('he');
  const scale = Math.min(box.w / frame.size.w, box.h / frame.size.h);
  const placed = (extra: Placed) => ({
    frame: {
      x: Math.round(extra.x * scale),
      y: Math.round(extra.y * scale),
      w: Math.max(1, Math.round(extra.w * scale)),
      h: Math.max(1, Math.round(extra.h * scale)),
    },
    ...(extra.rotation ? { rotation: extra.rotation } : {}),
  });
  const drawing = (extra: (StickerExtra | LabelExtra) & { markup: string }, at = placed(extra)) =>
    createElement.svg({
      ...at,
      name: `${frame.id}:${extra.art}`,
      markup: extra.markup,
      ...(extra.flip ? { flipH: true } : {}),
    });
  let said = 0;
  const line = (extra: CaptionExtra) => {
    const set = hebrew ? extra.he : extra.en;
    const says = words[said++] ?? set.text;
    // Words with no Hebrew letter (an age, a time, a code) read from the left in a Hebrew deck
    // too: a line that begins with a digit would otherwise have its parts in the wrong order.
    const rtl = hebrew && /\p{Script=Hebrew}/u.test(says);
    // A side is the same side in both languages: a magnet is not mirrored for Hebrew.
    const align = !extra.align ? 'center' : (extra.align === 'right') === rtl ? 'start' : 'end';
    const written = richText(says, {
      dir: rtl ? 'rtl' : 'ltr',
      align,
      marks: {
        size: Math.max(1, Math.round(set.size * scale)),
        weight: set.weight ?? 400,
        color: extra.color,
        ...(set.font ? { font: set.font } : {}),
        ...(set.spacing ? { letterSpacing: Math.round(set.spacing * scale * 10) / 10 } : {}),
        ...(set.italic ? { italic: true } : {}),
      },
    });
    const content = {
      paragraphs: written.paragraphs.map((paragraph) => ({
        ...paragraph,
        lineHeight: CAPTION_LEADING,
      })),
    };
    return createElement.text({
      ...placed(extra),
      name: `${frame.id}:caption`,
      autoFit: 'shrink',
      vAlign: 'middle',
      wrap: false,
      content: extra.colors ? painted(content, extra.colors) : content,
    });
  };
  const made = inOrder(frame.extras).map((extra) => {
    if (extra.kind === 'sticker') return { extra, element: drawing(extra) };
    if (extra.kind === 'caption') return { extra, element: line(extra) };
    // The plate takes the whole of the label's group, and the words lie on it.
    const at = placed(extra);
    const plate = drawing(extra, { frame: { x: 0, y: 0, w: at.frame.w, h: at.frame.h } });
    plate.stretch = labelStretch(extra, Math.min(at.frame.w / extra.w, at.frame.h / extra.h));
    const element = createElement.group({
      ...at,
      name: labelName(frame, extra),
      children: [plate, ...extra.lines.map(line)],
    });
    return { extra, element };
  });
  return {
    under: made.filter(({ extra }) => extra.under).map(({ element }) => element),
    over: made.filter(({ extra }) => !extra.under).map(({ element }) => element),
  };
}

/** The slide's safe margins (SPEC 9.1): at the sides, and above and below. */
const MARGIN = { x: 96, y: 80 };

/**
 * The size a frame has when it is added to a slide of the given size: its own, or for a frame
 * with a caption, as large as fits inside the slide's safe margins. Such a frame is the subject
 * of its slide; and when a group is made larger by hand its text keeps its size, so the frame
 * comes large and is made smaller, which its captions follow.
 */
export function frameSizeOn(frame: PhotoFrame, slide: Size): Size {
  const { size } = frame;
  if (!frame.extras?.length) return size;
  const scale = Math.min((slide.w - 2 * MARGIN.x) / size.w, (slide.h - 2 * MARGIN.y) / size.h);
  return { w: Math.round(size.w * scale), h: Math.round(size.h * scale) };
}

/*
 * A magnet's card and its photograph are two elements (ADR-095). The card's drawing has a window
 * for the photograph, cut by its mask `border`: the card in white, the window in black
 * (`frames-magnets/kit.mjs`). On a slide the card lies under the photograph with its window
 * filled, so the photograph can be moved and sized on it like any picture. The photograph is cut
 * by the card as it was drawn, window and all: it shows wherever that card does not paint, as it
 * did when the card lay over it, and the window goes where the photograph goes.
 */

/** The mask of a magnet's card that cuts its window. */
const BORDER = /<mask id="border"[^>]*>[\s\S]*?<\/mask>/;

const decimal = (value: number) => String(Math.round(value * 100) / 100);

/**
 * The card of a magnet as it lies under its photograph: its drawing with the window filled. The
 * filling is the opening, tied to the box as the opening is, so it fills the window at any size.
 */
function cardDrawing({ drawing, opening: o }: FrameArt, size: Size): string {
  const filled =
    `<rect fill="white" style="x:${decimal(o.x)}px;y:${decimal(o.y)}px;` +
    `width:calc(100% - ${decimal(size.w - o.w)}px);height:calc(100% - ${decimal(size.h - o.h)}px)"/>`;
  return drawing.replace(BORDER, (mask) => mask.replace(/<\/mask>$/, `${filled}</mask>`));
}

/**
 * A magnet's card and its photograph, in the given box: the card under the photograph, drawn as
 * large as the box is to the frame's own and keeping that size, and the photograph in its
 * opening, cut by its window. `undefined` for artwork that has no window of a card.
 */
function magnetParts(frame: PhotoFrame, box: Frame): [SvgElement, ImageElement] | undefined {
  const { art, size } = frame;
  if (!art || !BORDER.test(art.drawing)) return undefined;
  const scale = scaleIn(frame, box);
  const laid = frameLayout({ viewBox: size, opening: art.opening, scale, decorations: [] }, box);
  const o = laid.opening;
  const card = createElement.svg({
    frame: { ...box },
    name: `${frame.id}:card`,
    markup: cardDrawing(art, size),
    layout: { viewBox: { ...size }, scale },
  });
  const photo = createElement.image({
    frame: {
      x: box.x + o.x * laid.scale.x,
      y: box.y + o.y * laid.scale.y,
      w: o.w * laid.scale.x,
      h: o.h * laid.scale.y,
    },
    name: frame.id,
    mask: {
      kind: 'window',
      markup: art.drawing,
      viewBox: { ...size },
      opening: { ...art.opening },
      scale,
    },
  });
  return [card, photo];
}

/** The card of a magnet's group (`magnetParts`), when it has one. */
export function magnetCard(group: GroupElement): SvgElement | undefined {
  return group.children.find(
    (child): child is SvgElement =>
      child.type === 'svg' && child.layout !== undefined && child.name === `${group.name}:card`,
  );
}

/**
 * A frame as it goes onto a slide, in the given box: the picture alone, or with what the frame
 * puts beside it, as a group that is moved and sized as one. In a magnet the card and the
 * photograph are elements of their own.
 */
export function framedElement(
  frame: PhotoFrame,
  box: Frame,
  lang: string,
): ImageElement | GroupElement {
  if (!frame.extras?.length) return frameElement(frame, box);
  const { under, over } = frameExtras(frame, box, lang);
  const inner = { x: 0, y: 0, w: box.w, h: box.h };
  return createElement.group({
    frame: box,
    name: frame.id,
    ...(frame.shadow ? { effects: { shadow: frame.shadow } } : {}),
    children: [
      ...under,
      ...(magnetParts(frame, inner) ?? [frameElement(frame, inner, false)]),
      ...over,
    ],
  });
}

/**
 * The picture of a frame on a slide: the element itself when it is a picture, or the one
 * picture of a group that a frame made (`framedElement`).
 */
export function framedPicture(element: Element): ImageElement | undefined {
  if (element.type === 'image') return element;
  if (element.type !== 'group' || !element.name?.startsWith('frame:')) return undefined;
  const pictures = element.children.filter((child) => child.type === 'image');
  return pictures.length === 1 ? pictures[0] : undefined;
}

/**
 * A label already on a slide gains flexible strips on its first resize. Only a known,
 * unchanged plate is upgraded; its identity, text, position and all user formatting stay.
 * The patch is part of that resize, so undo restores the exact saved object.
 */
export function freshTextBackground(
  element: Element,
  all?: readonly PhotoFrame[],
): Map<string, ElementPatch> | undefined {
  const plates: Element[] = [];
  const visit = (one: Element) => {
    if (one.type === 'group') one.children.forEach(visit);
    else if (one.type === 'svg' && !one.stretch && one.name?.startsWith('frame:')) plates.push(one);
  };
  visit(element);
  if (!plates.length) return undefined;
  const out = new Map<string, ElementPatch>();
  for (const frame of all ?? framesAtHand() ?? []) {
    for (const extra of frame.extras ?? []) {
      if (extra.kind !== 'label') continue;
      for (const plate of plates) {
        if (
          plate.type !== 'svg' ||
          plate.name !== `${frame.id}:${extra.art}` ||
          plate.markup !== extra.markup
        )
          continue;
        out.set(plate.id, {
          stretch: labelStretch(extra, Math.min(plate.frame.w / extra.w, plate.frame.h / extra.h)),
        });
      }
    }
  }
  return out.size ? out : undefined;
}

const sameBox = (a: Frame, b: Frame) => a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;

/**
 * The frame a picture is in, among the frames given: the one the picture, or the group a frame
 * made around it, is named after. A picture that was put into a frame keeps its own name; its
 * frame is then the one whose artwork has that box and that opening, when only one has.
 */
function frameAround(
  picture: ImageElement,
  host: GroupElement | undefined,
  all: readonly PhotoFrame[],
): PhotoFrame | undefined {
  const named = all.find((one) => one.id === (host ?? picture).name);
  if (named || !picture.smartFrame) return named;
  const { viewBox, opening } = picture.smartFrame;
  const alike = all.filter(
    ({ size, art }) =>
      art && size.w === viewBox.w && size.h === viewBox.h && sameBox(art.opening, opening),
  );
  return alike.length === 1 ? alike[0] : undefined;
}

/**
 * The changes that give a picture in artwork of an earlier catalogue the artwork its frame has
 * now, by element. That artwork was a picture of one size, stretched with the element; the
 * catalogue's lays itself out, and is drawn here as large as fits the box the picture has. In
 * a group that a frame made, the stickers of that frame are again as large as the frame draws
 * them, where they stand: a stretch of the group had stretched them too.
 *
 * Undefined when the element is no such picture or group, when its artwork is the catalogue's
 * already, or when its frame is not known (`all`: the frames that are at hand). A frame that
 * has since taken a part of its card off it, onto a label, is another design than the picture
 * was put in: without that label beside it, the picture keeps the artwork it has, whole.
 */
export function freshFrame(
  element: Element,
  all?: readonly PhotoFrame[],
): Map<string, ElementPatch> | undefined {
  const picture = framedPicture(element);
  if (!picture?.smartFrame || picture.smartFrame.scale !== undefined) return undefined;
  const host = element.type === 'group' ? element : undefined;
  const frame = frameAround(picture, host, all ?? framesAtHand() ?? []);
  if (!frame?.art) return undefined;
  const lacks = (frame.extras ?? []).some(
    (extra) =>
      extra.kind === 'label' &&
      !host?.children.some((child) => child.name === labelName(frame, extra)),
  );
  if (lacks) return undefined;
  const out = new Map<string, ElementPatch>([
    [
      picture.id,
      {
        ...frameLook(frame, picture.frame),
        effects: framedEffects(picture, frame.shadow, Boolean(host)),
      },
    ],
  ]);
  const scale = scaleIn(frame, picture.frame);
  for (const child of host?.children ?? []) {
    const drawn = frame.extras?.find(
      (extra) => extra.kind === 'sticker' && child.name === `${frame.id}:${extra.art}`,
    );
    if (!drawn || child.type !== 'svg') continue;
    const [w, h] = [Math.round(drawn.w * scale), Math.round(drawn.h * scale)];
    const { frame: at } = child;
    out.set(child.id, {
      frame: { x: at.x + (at.w - w) / 2, y: at.y + (at.h - h) / 2, w, h },
    });
  }
  return out;
}

/** A box of the proportions of `size`, as large as fits inside another, around its centre. */
function fitted(size: Size, into: Frame): Frame {
  const scale = Math.min(into.w / size.w, into.h / size.h);
  const w = Math.max(1, Math.round(size.w * scale));
  const h = Math.max(1, Math.round(size.h * scale));
  return {
    x: Math.round(into.x + (into.w - w) / 2),
    y: Math.round(into.y + (into.h - h) / 2),
    w,
    h,
  };
}

/**
 * The effects of a picture that goes into a frame: its own, with the shadow the frame casts.
 * The shadow of the frame it was in goes with that frame; one the user gave a bare picture
 * stays unless the new frame casts its own. In a group that a frame made (`grouped`) the group
 * casts the shadow, and the picture none. Null when nothing is left.
 */
function framedEffects(
  picture: ImageElement,
  shadow: Shadow | undefined,
  grouped = false,
): ImageElement['effects'] | null {
  const { shadow: had, ...rest } = picture.effects ?? {};
  const cast = grouped ? undefined : (shadow ?? (picture.smartFrame ? undefined : had));
  const effects = { ...rest, ...(cast ? { shadow: cast } : {}) };
  return Object.keys(effects).length > 0 ? effects : null;
}

/**
 * The change that puts a picture in a frame. The picture keeps its photograph, its crop and
 * its adjustments; its box takes the proportions of the frame, as large as fits inside the box
 * it had and around the same centre, and the photograph fills the frame.
 */
export function framePatch(frame: PhotoFrame, picture: ImageElement): ElementPatch {
  const box = fitted(frame.size, picture.frame);
  return {
    frame: box,
    fit: 'cover',
    ...frameLook(frame, box),
    effects: framedEffects(picture, frame.shadow),
  };
}

/** The lines of words a frame's group holds, in their order: its captions, and those on its labels. */
const captionsOf = (group: GroupElement): TextElement[] =>
  group.children
    .flatMap((child) =>
      child.type === 'group' && child.name?.startsWith(`${group.name}:label:`)
        ? child.children
        : [child],
    )
    .filter(
      (child): child is TextElement =>
        child.type === 'text' && child.name === `${group.name}:caption`,
    );

/**
 * The command that puts a picture of a slide in a frame, and the element to select after it.
 * Between two plain frames it is `framePatch`. With a frame that has stickers and a caption on
 * either side of the change, the picture, or the group the earlier frame made around it, is
 * replaced in its place: by a group of the new frame, or by the picture alone. What the earlier
 * frame put beside the picture goes; a caption that was typed over keeps its words in the new
 * frame (`all` are the frames, to know the words a caption came with).
 */
export function reframe(
  slide: Slide,
  picture: ImageElement,
  frame: PhotoFrame,
  lang: string,
  all: readonly PhotoFrame[] = [],
): { command: Command; select: string } {
  const parent = locateElement(slide.elements, picture.id)?.parent;
  const host = parent && framedPicture(parent)?.id === picture.id ? parent : undefined;
  if (!host && !frame.extras?.length) {
    return {
      command: updateElement(slide.id, picture.id, framePatch(frame, picture)),
      select: picture.id,
    };
  }
  const outer = host ?? picture;
  const box = fitted(frame.size, outer.frame);
  const { mask, smartFrame } = frameLook(frame, box);
  // What the user put into the group stays in it; what the earlier frame put there goes.
  const own = host?.children.filter(
    (child) => child.id !== picture.id && !child.name?.startsWith(`${host.name}:`),
  );
  const grouped = Boolean(frame.extras?.length || own?.length);
  const effects = framedEffects(picture, frame.shadow, grouped);
  const { mask: _mask, smartFrame: _smartFrame, effects: _effects, ...kept } = picture;
  // A magnet has a card of its own under the photograph, which takes the card's window.
  const parts = frame.extras?.length
    ? magnetParts(frame, { x: 0, y: 0, w: box.w, h: box.h })
    : undefined;
  const inside: ImageElement = parts
    ? {
        ...kept,
        frame: parts[1].frame,
        fit: 'cover',
        mask: parts[1].mask!,
        ...(effects ? { effects } : {}),
      }
    : {
        ...kept,
        frame: { x: 0, y: 0, w: box.w, h: box.h },
        fit: 'cover',
        ...(mask ? { mask } : {}),
        ...(smartFrame ? { smartFrame } : {}),
        ...(effects ? { effects } : {}),
      };
  const earlier = host && all.find((one) => one.id === host.name);
  const came = linesOf(earlier?.extras).map((line) => [line.he.text, line.en.text]);
  const words = (host ? captionsOf(host) : []).map((caption, i) => {
    const said = plainText(caption.content);
    return said.trim() && !came[i]?.includes(said) ? said : undefined;
  });
  const replaced = (element: Element) => ({
    command: {
      type: 'element.replace',
      slideId: slide.id,
      elementId: outer.id,
      elements: [element],
    } satisfies Command,
    select: element.id,
  });
  if (!grouped) {
    // Out of its group, the picture takes the place and the turn the group had.
    return replaced({
      ...inside,
      frame: box,
      rotation: normalizeAngle(outer.rotation + (host ? picture.rotation : 0)),
    });
  }
  const group =
    host ??
    createElement.group({
      frame: box,
      rotation: picture.rotation,
      ...(frame.shadow ? { effects: { shadow: frame.shadow } } : {}),
      children: [],
    });
  const { under, over } = frameExtras(frame, box, lang, words);
  return replaced({
    ...group,
    frame: box,
    name: frame.id,
    children: [
      ...under,
      ...(parts ? [parts[0]] : []),
      { ...inside, rotation: host ? picture.rotation : 0 },
      ...(own ?? []),
      ...over,
    ],
  });
}

/* ---------------------------------------------------------------- in the panel */

/**
 * The photograph of a thumbnail the renderer draws, as the preview's deck knows it. It is a
 * stand-in: the panel says which picture it is (`FRAME_PHOTO_URL`).
 */
export const SAMPLE_PHOTO: AssetMeta = {
  id: 'frame-preview-photo',
  file: 'frame-preview-photo.svg',
  mime: 'image/svg+xml',
  kind: 'image',
  origin: 'import',
  bytes: 0,
};

/** Whether the thumbnail of a frame is drawn by the renderer, as the slide draws the frame. */
export const drawnWhole = (frame: PhotoFrame): boolean =>
  Boolean(frame.extras?.length || frame.art);

/**
 * A frame alone on a slide, for a thumbnail that the renderer draws: the frame as it goes onto
 * a slide, at the corner of the slide and at its own size, in the colours of the given theme,
 * around a stand-in photograph. The slide has no ground: the thumbnail shows the frame's box.
 */
export function framePreview(
  frame: PhotoFrame,
  lang: string,
  theme: Theme,
): { deck: Deck; slide: Slide } {
  const element = framedElement(frame, { x: 0, y: 0, ...frame.size }, lang);
  const filled = (child: Element): Element =>
    child.type === 'image' ? { ...child, assetId: SAMPLE_PHOTO.id } : child;
  const slide = createSlide({
    elements: [
      element.type === 'group'
        ? { ...element, children: element.children.map(filled) }
        : filled(element),
    ],
    background: { fill: { kind: 'none' } },
  });
  const deck: Deck = {
    ...createDeck({ lang, theme, slides: [slide] }),
    assets: { [SAMPLE_PHOTO.id]: SAMPLE_PHOTO },
  };
  return { deck, slide };
}

/**
 * Whether a frame is drawn in the colours or the type of the deck: a part of its artwork or of
 * what stands beside its picture in a colour of the theme, or a line of words in the deck's own
 * font. Such a frame looks different from deck to deck.
 */
export function followsTheme(frame: PhotoFrame): boolean {
  const themed = (markup: string) => markup.includes('var(--');
  return (
    themed(frame.art?.drawing ?? '') ||
    (frame.extras ?? []).some((extra) => extra.kind !== 'caption' && themed(extra.markup)) ||
    linesOf(frame.extras).some((line) => !('value' in line.color) || !line.he.font || !line.en.font)
  );
}

/**
 * Whether the panel shows a frame from a small picture that was made ahead
 * (`scripts/generate-frames-thumbs.mjs`), not from a drawing of the renderer: a whole design,
 * with its stickers and its words, that looks the same in every deck. A hundred of those drawn
 * live are tens of thousands of nodes, and megabytes of pictures to clean, each time they are
 * shown.
 */
export const picturedAhead = (frame: PhotoFrame): boolean =>
  Boolean(frame.extras?.length) && !followsTheme(frame);

/** Raised when frames are drawn another way: the pictures made ahead are then of none of them. */
const THUMB_DRAWING = 1;

const revs = new WeakMap<PhotoFrame, string>();

/**
 * A short word for what a frame draws: its box, its cut, its artwork, what stands beside its
 * picture and its shadow. A picture that was made of a frame ahead carries the word, so the
 * panel knows it is of the frame as the catalogue has it now.
 */
export function frameRev(frame: PhotoFrame): string {
  let rev = revs.get(frame);
  if (rev === undefined) {
    const { size, mask, art, extras, shadow } = frame;
    const drawn = [THUMB_DRAWING, size, mask ?? null, art ?? null, extras ?? null, shadow ?? null];
    rev = hashed(JSON.stringify(drawn));
    revs.set(frame, rev);
  }
  return rev;
}

/** A text as a word of about ten letters: the same for the same text, another for another. */
function hashed(text: string): string {
  let a = 0xdeadbeef;
  let b = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    a = Math.imul(a ^ code, 2654435761);
    b = Math.imul(b ^ code, 1597334677);
  }
  a = Math.imul(a ^ (a >>> 16), 2246822507) ^ Math.imul(b ^ (b >>> 13), 3266489909);
  b = Math.imul(b ^ (b >>> 16), 2246822507) ^ Math.imul(a ^ (a >>> 13), 3266489909);
  return (b >>> 0).toString(36) + (a >>> 0).toString(36);
}

/** The outline a frame cuts its photograph to, as path data in the frame's own box. */
export function frameOutline({ mask, size: { w, h } }: PhotoFrame): string {
  if (mask?.kind === 'path') return mask.d;
  const path =
    mask?.kind === 'ellipse'
      ? presetPath('ellipse', w, h)
      : mask?.kind === 'rounded'
        ? presetPath('roundRect', w, h, [mask.radius / Math.min(w, h)])
        : mask?.kind === 'shape'
          ? presetPath(mask.preset, w, h)
          : undefined;
  return (path ?? presetPath('rect', w, h))?.d ?? '';
}
