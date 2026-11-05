import { z } from 'zod';
import { Element } from './elements';
import { Alpha, Fill } from './primitives';

/**
 * What a slide shows behind everything (SLD-03): the fill, for photos a blur and a dimming veil,
 * the overlay, and a drawing over them (ADR-125). The theme has one and the variants a slide can
 * pick; a layout and a slide may have their own.
 *
 * It lives apart from the primitives because its drawing is made of elements.
 */
export const Background = z.strictObject({
  fill: Fill,
  /** Drawn over the fill, usually to keep text readable on a photo. */
  overlay: Fill.optional(),
  /** For image fills: blur radius in slide pixels. */
  blur: z.number().nonnegative().optional(),
  /** For image fills: 0 = untouched, 1 = black. */
  dim: Alpha.optional(),
  /**
   * A drawing that is part of the background (ADR-125): elements at their places on the slide,
   * bottom to top, over the fill and the overlay and under everything the layout and the slide
   * draw. Nothing selects them. They go with the background: a slide that takes another one
   * leaves them, and a slide that goes back to its layout's background gets them again.
   */
  elements: z.array(Element).optional(),
});
export type Background = z.infer<typeof Background>;
