import {
  createElement,
  createSlide,
  findSlide,
  type Background,
  type Command,
  type Deck,
  type Frame,
  type LineElement,
  type Slide,
  type SvgElement,
} from '@slidr/model';
import { centredFrame } from '../objects/shapes';
import type { MotionBackground } from './motionBackgrounds';
import { atSpeed, inkOverrides, withRootAttribute } from './motionKit';
import {
  motionPictures,
  type LinePiece,
  type MotionPiece,
  type PicturePiece,
} from './motionPieces';
import { motionShapeElement, type MotionShape } from './motionShapes';

/*
 * What the animations and the backgrounds of Elements put on a slide (ADR-127). Pure, so it is
 * tested without a DOM: the panel and the insert functions call it, and so does the page of
 * Slidr Library, which draws their tiles as the panel does (ADR-138).
 */

/**
 * An animation as a new element, in the theme's colours, in the middle of the slide (beside
 * whatever already stands there): an `svg` element whose picture moves by itself, or a line that
 * something runs along (ADR-131). One that runs from side to side runs in the deck's reading
 * direction: a picture mirrored, a line drawn from its right end, as a new line is.
 */
export function motionElement(
  piece: PicturePiece,
  deck: Deck,
  taken?: readonly Frame[],
): SvgElement;
export function motionElement(piece: LinePiece, deck: Deck, taken?: readonly Frame[]): LineElement;
export function motionElement(
  piece: MotionPiece,
  deck: Deck,
  taken?: readonly Frame[],
): SvgElement | LineElement;
export function motionElement(
  piece: MotionPiece,
  deck: Deck,
  taken: readonly Frame[] = [],
): SvgElement | LineElement {
  const frame = centredFrame(piece.size, deck.size, taken);
  const rtl = piece.reads && deck.meta.dir === 'rtl';
  const name = `animation-${piece.id}`;
  if (piece.kind === 'line') {
    const { points, stroke, flow, ...line } = piece.line;
    return createElement.line({
      frame,
      name,
      ...line,
      points: points.map((p) => ({ x: rtl ? piece.size.w - p.x : p.x, y: p.y })),
      stroke: { ...stroke },
      flow: { ...flow },
    });
  }
  return createElement.svg({
    frame,
    markup: piece.markup,
    name,
    colorOverrides: inkOverrides(piece.markup),
    ...(rtl ? { flipH: true } : {}),
  });
}

/** The attribute of a picture's root that says how fast it moves, when not at its own pace. */
export const SPEED_ATTRIBUTE = 'data-slidr-speed';

/** The name and the speed a picture's root gives itself (`PIECE_ATTRIBUTE`, `SPEED_ATTRIBUTE`). */
const PIECE_NAME = /^<svg\b[^>]*\sdata-slidr-motion="([\w-]+)"/;
const SPEED = /^<svg\b[^>]*\sdata-slidr-speed="([\d.]+)"/;

/** The slowest and the fastest an animation of Elements goes, as a share of its own pace. */
export const PIECE_SPEEDS = { min: 0.25, max: 4 } as const;

/**
 * The animation of Elements an `svg` element is, if it is one: by the name its picture gives
 * itself, or else by the element's name, which an element put on a slide before its picture
 * named itself has (ADR-127).
 */
export function pieceOf(element: SvgElement): PicturePiece | undefined {
  if (!element.markup) return undefined;
  const named = PIECE_NAME.exec(element.markup)?.[1];
  const id = named ?? (element.name?.startsWith('animation-') ? element.name.slice(10) : undefined);
  // A picture of an animation that is now a line (ADR-131) still draws, at its own pace.
  return id ? motionPictures().find((piece) => piece.id === id) : undefined;
}

/** How fast the picture of an animation of Elements moves, as a share of its own pace. */
export function pieceSpeed(markup: string): number {
  const value = SPEED.exec(markup)?.[1];
  const speed = value ? Number(value) : 1;
  return Number.isFinite(speed) && speed > 0 ? speed : 1;
}

/**
 * The picture of an animation at a speed: drawn again from the animation, every time in it
 * divided by the speed (`atSpeed`), and saying its speed. Its colours are where they were, so
 * the element's replacements of them still hold.
 */
export function pieceMarkup(piece: PicturePiece, speed: number): string {
  return markupAtSpeed(piece.markup, speed);
}

/**
 * Markup of Elements drawn at its own pace (an animation's, a background's), at a speed: every
 * time in it divided by the speed, within `PIECE_SPEEDS`, and its root saying the speed
 * (`SPEED_ATTRIBUTE`), which `pieceSpeed` reads back.
 */
export function markupAtSpeed(markup: string, speed: number): string {
  const clamped = Math.min(PIECE_SPEEDS.max, Math.max(PIECE_SPEEDS.min, speed));
  if (clamped === 1) return markup;
  return withRootAttribute(
    atSpeed(markup, clamped),
    SPEED_ATTRIBUTE,
    String(Math.round(clamped * 100) / 100),
  );
}

/**
 * The drawing of a background as an element of it: the whole slide, in the theme's colours. A
 * drawing that stands on one side is drawn for a deck that reads from the right, and mirrored
 * for one that reads from the left.
 */
export function backgroundDrawing(background: MotionBackground, deck: Deck): SvgElement {
  return createElement.svg({
    frame: { x: 0, y: 0, w: deck.size.w, h: deck.size.h },
    markup: background.markup,
    name: `background-${background.id}`,
    colorOverrides: inkOverrides(background.markup),
    ...(background.sided && deck.meta.dir === 'ltr' ? { flipH: true } : {}),
  });
}

/** What a slide shows without a background of its own: its layout's, else the theme's. */
function shownBackground(deck: Deck, slide: Slide): Background {
  const layout = slide.layoutId ? deck.layouts.find((l) => l.id === slide.layoutId) : undefined;
  return slide.background ?? layout?.background ?? deck.theme.background;
}

/**
 * The background a slide takes with a drawing of Elements: the ground it shows, its colour or
 * gradient and the veil over it, under the drawing, which takes the place of any drawing it had.
 * A photograph gives way to the theme's ground, which the drawing's colours are made to be seen
 * on, and so does the text of every template.
 */
export function backgroundWith(shown: Background, drawing: SvgElement): Background {
  if (shown.fill.kind === 'image') {
    return { fill: { kind: 'solid', color: { token: 'bg' } }, elements: [drawing] };
  }
  return {
    fill: shown.fill,
    ...(shown.overlay ? { overlay: shown.overlay } : {}),
    elements: [drawing],
  };
}

/**
 * The commands that give slides a background of Elements, one for each: the current slide, and
 * with it the others selected in the filmstrip. Each slide gets a drawing of its own.
 */
export function backgroundCommands(
  deck: Deck,
  slideIds: readonly string[],
  background: MotionBackground,
): Command[] {
  return slideIds.flatMap((slideId): Command[] => {
    const slide = findSlide(deck, slideId);
    if (!slide) return [];
    const next = backgroundWith(shownBackground(deck, slide), backgroundDrawing(background, deck));
    return [{ type: 'slide.update', slideId, patch: { background: next } }];
  });
}

/** Which background of Elements a slide shows, if it shows one. */
export function shownMotionBackground(deck: Deck, slide: Slide): string | undefined {
  const name = shownBackground(deck, slide).elements?.[0]?.name;
  return name?.startsWith('background-') ? name.slice('background-'.length) : undefined;
}

/* ---------------------------------------------------------------- tiles */

/** The longest side of an animation on its tile's slide, as a share of the slide's height. */
const PIECE_HEIGHT = 0.84;

/** The longest side of an animated shape on its tile's slide, as a share of the slide's height. */
const SHAPE_HEIGHT = 0.6;

/**
 * A line of an animation (ADR-131) drawn `scale` times as large: its points, its width and the
 * pace of what runs along it, so that it looks and moves on its tile as on a slide of its size.
 */
function scaledLine(line: LineElement, scale: number): LineElement {
  const { flow } = line;
  return {
    ...line,
    points: line.points.map((p) => ({ x: p.x * scale, y: p.y * scale })),
    stroke: { ...line.stroke, width: line.stroke.width * scale },
    ...(flow
      ? {
          flow: {
            ...flow,
            speed: flow.speed * scale,
            ...(flow.size === undefined ? {} : { size: flow.size * scale }),
          },
        }
      : {}),
  };
}

/** The slide an animation's tile draws: the piece, large, in the middle of the theme's ground. */
export function pieceSlide(piece: MotionPiece, deck: Deck): Slide {
  const element = motionElement(piece, deck);
  const scale = (deck.size.h * PIECE_HEIGHT) / Math.max(piece.size.h, piece.size.w * 0.56);
  const [w, h] = [piece.size.w * scale, piece.size.h * scale];
  const frame = { x: (deck.size.w - w) / 2, y: (deck.size.h - h) / 2, w, h };
  const id = `motion_${piece.id}`;
  return createSlide({
    id: `s_motion_${piece.id}`,
    background: { fill: { kind: 'solid', color: { token: 'bg' } } },
    elements: [
      element.type === 'line'
        ? { ...scaledLine(element, scale), id, frame }
        : { ...element, id, frame },
    ],
  });
}

/** The slide an animated shape's tile draws: the shape, large, in the middle of the theme's ground. */
export function shapeSlide(shape: MotionShape, deck: Deck): Slide {
  const element = motionShapeElement(shape, deck);
  const { w: ew, h: eh } = element.frame;
  // Room around it for what it does: a float rises, a beat grows, a swing leans.
  const scale = (deck.size.h * SHAPE_HEIGHT) / Math.max(eh, ew * 0.56);
  const [w, h] = [ew * scale, eh * scale];
  const ambient =
    shape.ambient.kind === 'float'
      ? { ...shape.ambient, amount: (shape.ambient.amount ?? 16) * scale }
      : shape.ambient;
  return createSlide({
    id: `s_motion_shape_${shape.id}`,
    background: { fill: { kind: 'solid', color: { token: 'bg' } } },
    elements: [
      {
        ...element,
        id: `motion_shape_${shape.id}`,
        frame: { x: (deck.size.w - w) / 2, y: (deck.size.h - h) / 2, w, h },
        ambient,
        // Its outline as thick on the tile as on a slide of its own size.
        ...(element.stroke
          ? { stroke: { ...element.stroke, width: element.stroke.width * scale } }
          : {}),
      },
    ],
  });
}

/**
 * The slide a background's tile draws: the ground it is put on (the slide's, in the panel; the
 * theme's, in the library's page) under the background's drawing, as a click would leave it.
 */
export function backgroundSlide(
  background: MotionBackground,
  deck: Deck,
  ground: Background,
): Slide {
  return createSlide({
    id: `s_background_${background.id}`,
    background: backgroundWith(ground, {
      ...backgroundDrawing(background, deck),
      id: `background_${background.id}`,
    }),
  });
}
