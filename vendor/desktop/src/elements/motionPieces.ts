import { mediaCatalog, readMediaJson } from '@slidr/media-library';
import {
  AmbientMotion,
  BASE_LANGUAGES,
  CONTENT_LANGUAGES,
  inLanguage,
  LineElement,
  LineFlow,
  type Localized,
} from '@slidr/model';
import { withRootAttribute } from './motionKit';
import { MOTION_SHAPE_INKS, MOTION_SHAPE_LOOKS, type MotionShape } from './motionShapes';

/*
 * The animations of Elements (ADR-127): drawings that move by themselves, each put on a slide as
 * an object of its own that moves, resizes and turns as any other. Some are a shape that moves
 * (a dot on a path, a line, a polygon, a circle), some are not one shape (waves, particles, a
 * network). Most are pictures. Those that are a line with something running along it (ADR-131),
 * the boxes on a path and the flowing connector, are lines of the deck: their ends and bends are
 * dragged as any line's, with no box around them, and the flow follows the line wherever it goes.
 * Beside them are the animated shapes (ADR-128), plain shapes that repeat a motion
 * (`motionShapes.ts`).
 *
 * They are the media library's, not the app's (ADR-138): `elements/animations/catalog.json`,
 * read when they are first wanted, or while the app is idle. Until it has come, and without it,
 * there are no animations to add; one already on a slide is an element of its own, drawn as it is.
 */

export const MOTION_GROUPS = ['path', 'spin', 'scale', 'lines', 'particles'] as const;
export type MotionGroup = (typeof MOTION_GROUPS)[number];

interface PieceBase {
  id: string;
  /** Its name in each language the library writes it in, Hebrew and English at least. */
  name: Localized<string>;
  group: MotionGroup;
  /** The units of the drawing, and the size it lands on a slide at, in slide pixels. */
  size: { w: number; h: number };
  /**
   * Whether it runs from one side to the other, as an arrow does: drawn from left to right, and
   * mirrored in a deck that reads from the right, as a new line is.
   */
  reads: boolean;
}

/** A picture that moves by itself: an `svg` element (ADR-127). */
export interface PicturePiece extends PieceBase {
  kind: 'picture';
  /** The picture, its root naming the animation it is (`PIECE_ATTRIBUTE`). */
  markup: string;
}

/** What a line of the deck is drawn with, and what runs along it (ADR-131). */
export type LineShape = Pick<
  LineElement,
  'points' | 'stroke' | 'startHead' | 'endHead' | 'curve'
> & { flow: LineFlow };

/** A line that something runs along: a `line` element with a flow (ADR-131). */
export interface LinePiece extends PieceBase {
  kind: 'line';
  /** Its points in the units of `size`, from left to right. */
  line: LineShape;
}

export type MotionPiece = PicturePiece | LinePiece;

/**
 * The attribute of a picture's root that names the animation it is (ADR-128): row B finds it by
 * it, to draw it again at another speed. The app gives it to the picture as it reads the library.
 */
export const PIECE_ATTRIBUTE = 'data-slidr-motion';

/** Where the library keeps the animations and the animated shapes. */
export const ANIMATIONS_CATALOG = 'elements/animations/catalog.json';

export interface AnimationCatalog {
  /** The animations, in the order the collection shows them. */
  pieces: readonly MotionPiece[];
  /** The animated shapes, in the order the collections show them. */
  shapes: readonly MotionShape[];
}

/* ---------------------------------------------------------------- reading the catalog */

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * The names of an item of the library, by language: those of the languages of the app that are
 * written, and none without Hebrew and English.
 */
export function localizedName(value: unknown): Localized<string> | undefined {
  if (!isRecord(value)) return undefined;
  const names: Record<string, string> = {};
  for (const lang of CONTENT_LANGUAGES) {
    const name = value[lang];
    if (typeof name === 'string' && name.trim()) names[lang] = name;
  }
  return BASE_LANGUAGES.every((lang) => names[lang]) ? (names as Localized<string>) : undefined;
}

/** What an item of Elements is called in a language: its own name there, else its English one. */
export const motionName = (item: { name: Localized<string> }, lang: string): string =>
  inLanguage(item.name, lang);

const isPositive = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0;

const LINE = LineElement.pick({
  points: true,
  stroke: true,
  startHead: true,
  endHead: true,
  curve: true,
}).extend({ flow: LineFlow });

function pieceOf(item: Record<string, unknown>): MotionPiece | undefined {
  const { id, group, size, reads, markup } = item;
  const name = localizedName(item.name);
  if (
    typeof id !== 'string' ||
    !id ||
    !name ||
    !MOTION_GROUPS.includes(group as MotionGroup) ||
    !isRecord(size) ||
    !isPositive(size.w) ||
    !isPositive(size.h) ||
    typeof reads !== 'boolean'
  ) {
    return undefined;
  }
  const base = { id, name, group: group as MotionGroup, size: { w: size.w, h: size.h }, reads };
  if (typeof markup === 'string' && markup.startsWith('<svg')) {
    return { ...base, kind: 'picture', markup: withRootAttribute(markup, PIECE_ATTRIBUTE, id) };
  }
  const line = LINE.safeParse(item.line);
  return line.success ? { ...base, kind: 'line', line: line.data } : undefined;
}

function shapeOf(item: Record<string, unknown>): MotionShape | undefined {
  const { id, preset, side, aspect, look, ink, reads } = item;
  const name = localizedName(item.name);
  const ambient = AmbientMotion.safeParse(item.ambient);
  if (
    typeof id !== 'string' ||
    !id ||
    !name ||
    typeof preset !== 'string' ||
    !preset ||
    !isPositive(side) ||
    (aspect !== undefined && !isPositive(aspect)) ||
    !MOTION_SHAPE_LOOKS.includes(look as MotionShape['look']) ||
    !MOTION_SHAPE_INKS.includes(ink as MotionShape['ink']) ||
    (reads !== undefined && typeof reads !== 'boolean') ||
    !ambient.success
  ) {
    return undefined;
  }
  return {
    id,
    name,
    preset,
    side,
    ...(aspect === undefined ? {} : { aspect }),
    look: look as MotionShape['look'],
    ink: ink as MotionShape['ink'],
    ambient: ambient.data,
    ...(reads ? { reads } : {}),
  };
}

/** The items of a list that `read` takes, each id once, in the list's order. */
function itemsOf<T extends { id: string }>(
  list: unknown,
  read: (item: Record<string, unknown>) => T | undefined,
): T[] {
  const seen = new Set<string>();
  return (Array.isArray(list) ? list : []).flatMap((item: unknown) => {
    const one = isRecord(item) ? read(item) : undefined;
    if (!one || seen.has(one.id)) return [];
    seen.add(one.id);
    return [one];
  });
}

/**
 * The animations and the animated shapes of a catalog, in its order. An item this app cannot
 * draw is left out, so a catalog written by a later library still gives the rest.
 */
export function animationsOf(file: unknown): AnimationCatalog {
  const read = isRecord(file) ? file : {};
  return { pieces: itemsOf(read.animations, pieceOf), shapes: itemsOf(read.shapes, shapeOf) };
}

/** The animations and the animated shapes of the library. */
export const animationCatalog = mediaCatalog<AnimationCatalog>(
  async () => animationsOf(await readMediaJson(ANIMATIONS_CATALOG)),
  { pieces: [], shapes: [] },
);

/**
 * Every animation the library has, as far as it has been read: none until the catalog has come.
 * What draws them draws again when it comes (`useMediaCatalog(animationCatalog)`).
 */
export function motionPieces(): readonly MotionPiece[] {
  return animationCatalog.get().pieces;
}

/** The animations that are pictures (ADR-127), without the lines (ADR-131). */
export function motionPictures(): readonly PicturePiece[] {
  return motionPieces().filter((piece): piece is PicturePiece => piece.kind === 'picture');
}

/** Every animated shape the library has (ADR-128), as far as it has been read. */
export function motionShapes(): readonly MotionShape[] {
  return animationCatalog.get().shapes;
}
