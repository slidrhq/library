import {
  createElement,
  type Element,
  type Frame,
  type GroupElement,
  type ShapeElement,
  type Stroke,
  type Theme,
} from '@slidr/model';
import { ACCENT_SIZE, takesAccent } from './accent';
import { centredFrame } from './shapes';

/*
 * A card (ADR-073): a box and what lies on it, as one group. The model has no card type and wants
 * none: a card is that structure, whoever made it (the import, the agent, the Insert menu, or a
 * person who grouped a box with its text). Here is how a card is told from any other group, and
 * the card the shape library inserts. Pure, so it is tested without a DOM.
 */

/** How far the box may be from the group's own frame and still be the whole of it, in slide px. */
const COVERS = 1;

/**
 * The box of a card: the first child of a group, when it is a shape with sides (a rectangle, a
 * rounded one, an ellipse) that lies under everything else in the group and takes the group's
 * whole frame. Undefined for any other element, and for a group whose first child is only one of
 * its parts: there the group has no box to paint.
 */
export function cardBox(element: Element): ShapeElement | undefined {
  if (element.type !== 'group') return undefined;
  const box = element.children[0];
  if (box?.type !== 'shape' || !takesAccent(box) || box.rotation !== 0) return undefined;
  const near = (a: number, b: number) => Math.abs(a - b) <= COVERS;
  const { x, y, w, h } = box.frame;
  const covers = near(x, 0) && near(y, 0) && near(w, element.frame.w) && near(h, element.frame.h);
  return covers ? box : undefined;
}

/* ---------------------------------------------------------------- inserting */

interface Size {
  w: number;
  h: number;
}

/** The words a new card holds until its own are typed, in the language of the deck. */
export interface CardWords {
  heading: string;
  body: string;
}

const CARD_WIDTH = 560;
/** The room between the edge of the box and the text, the same on every side. */
const CARD_MARGIN = 40;
/** The room between the heading and the paragraph under it. */
const HEADING_GAP = 12;
/** A new card has room for this many lines of body text under its heading. */
const BODY_LINES = 2;
/** Thin, and in the colour of the text at a low alpha: it shows on a light surface and on a dark one. */
const OUTLINE: Stroke = { color: { token: 'text', alpha: 0.16 }, width: 2 };

/**
 * A new card in the theme's colours: a box in `surface` with the theme's corners, a thin outline
 * and an accent along its top in `primary`, and on it one text box with a heading and a paragraph
 * in the theme's text styles. Its height is what those lines take in this theme, with the same
 * margin all around the text; the accent is not part of the margin. The frames of the box and of
 * the text count from the corner of the group, whose frame is the box's.
 */
export function newCard(
  slide: Size,
  theme: Theme,
  words: CardWords,
  taken: readonly Frame[] = [],
): GroupElement {
  const { heading, body } = theme.textStyles;
  const text = Math.ceil(
    heading.size * heading.lineHeight + HEADING_GAP + BODY_LINES * body.size * body.lineHeight,
  );
  const size = { w: CARD_WIDTH, h: ACCENT_SIZE + 2 * CARD_MARGIN + text };
  return createElement.group({
    frame: centredFrame(size, slide, taken),
    children: [
      createElement.shape({
        frame: { x: 0, y: 0, ...size },
        geometry: { kind: 'preset', preset: 'rect' },
        fill: { kind: 'solid', color: { token: 'surface' } },
        stroke: OUTLINE,
        accent: {
          side: 'top',
          size: ACCENT_SIZE,
          fill: { kind: 'solid', color: { token: 'primary' } },
        },
        ...(theme.radius > 0 ? { effects: { radius: theme.radius } } : {}),
      }),
      createElement.text({
        frame: {
          x: CARD_MARGIN,
          y: ACCENT_SIZE + CARD_MARGIN,
          w: size.w - 2 * CARD_MARGIN,
          h: text,
        },
        content: {
          paragraphs: [
            {
              dir: 'auto',
              align: 'start',
              styleRef: 'heading',
              spaceAfter: HEADING_GAP,
              runs: [{ text: words.heading }],
            },
            { dir: 'auto', align: 'start', styleRef: 'body', runs: [{ text: words.body }] },
          ],
        },
      }),
    ],
  });
}

/**
 * A card drawn small for the library, in the 24 box of the shape glyphs: the box, the accent
 * along its top as a filled band, and two lines of text, the heading the shorter one. The lines
 * start on the left; the library mirrors them for a deck that reads from the right.
 */
export const CARD_GLYPH = {
  box: 'M5 5h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2z',
  accent: 'M5 5h14a2 2 0 0 1 2 2v1.5H3V7a2 2 0 0 1 2-2z',
  lines: 'M6.5 12h6M6.5 15.5h11',
} as const;
