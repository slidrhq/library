import type { AmbientMotion, ColorToken, Deck, Frame, Localized, ShapeElement } from '@slidr/model';
import { centredFrame, newShape } from '../objects/shapes';

/*
 * The animated shapes of Elements (ADR-128): a shape of the library that repeats a motion of its
 * own, a turning hexagon, a beating heart, a floating circle. Unlike the animations of ADR-127,
 * which are pictures, each is a plain shape: its fill, its outline, its size and its text are
 * edited as any shape's, and its motion (`ambient`) is edited in row B, as anything's can be.
 * The media library names them, beside the animations (`animationCatalog`, ADR-138); here is how
 * one becomes a shape of a slide.
 */

/** How a shape is painted: filled, or drawn as an outline, whole or in dashes. */
export const MOTION_SHAPE_LOOKS = ['fill', 'outline', 'dashed'] as const;
export type MotionShapeLook = (typeof MOTION_SHAPE_LOOKS)[number];

/** The colours of the theme an animated shape is painted in. */
export const MOTION_SHAPE_INKS = ['primary', 'secondary', 'accent'] as const;

export interface MotionShape {
  id: string;
  /** Its name in each language the library writes it in, Hebrew and English at least. */
  name: Localized<string>;
  /** The shape of the library it is. One that `reads` points toward the end of a line. */
  preset: string;
  /** Its longest side on the slide, in slide pixels. */
  side: number;
  /** Proportions of its own, in place of those the library gives the shape. */
  aspect?: number;
  look: MotionShapeLook;
  ink: Extract<ColorToken, (typeof MOTION_SHAPE_INKS)[number]>;
  ambient: AmbientMotion;
  /**
   * Whether it points the way a line runs, as an arrow does: to the right in a deck that reads
   * from the left, to the left in one that reads from the right.
   */
  reads?: boolean;
}

/** The outline of an outlined shape: thick enough to turn visibly, in whole pixels. */
const OUTLINE = 16;

/** The preset a shape is drawn with in a deck that reads `dir`. */
export function motionShapePreset(shape: MotionShape, dir: 'ltr' | 'rtl'): string {
  return shape.reads && dir === 'rtl' ? shape.preset.replace('Right', 'Left') : shape.preset;
}

/**
 * An animated shape as a new element, in the theme's colours, in the middle of the slide beside
 * whatever already stands there. It has the proportions the library gives its shape.
 */
export function motionShapeElement(
  shape: MotionShape,
  deck: Deck,
  taken: readonly Frame[] = [],
): ShapeElement {
  const preset = motionShapePreset(shape, deck.meta.dir);
  const base = newShape(preset, deck.size);
  const [w, h] = shape.aspect ? [shape.aspect, 1] : [base.frame.w, base.frame.h];
  const scale = shape.side / Math.max(w, h);
  const size = { w: Math.round(w * scale), h: Math.round(h * scale) };
  const color = { token: shape.ink } as const;
  const paint: Pick<ShapeElement, 'fill' | 'stroke'> =
    shape.look === 'fill'
      ? { fill: { kind: 'solid', color } }
      : {
          fill: { kind: 'none' },
          stroke: {
            color,
            width: OUTLINE,
            join: 'round',
            ...(shape.look === 'dashed' ? { dash: 'dashed', cap: 'round' } : {}),
          },
        };
  // A closed shape of the library comes without an outline: the look decides it.
  return {
    ...base,
    ...paint,
    frame: centredFrame(size, deck.size, taken),
    ambient: { ...shape.ambient },
  };
}
