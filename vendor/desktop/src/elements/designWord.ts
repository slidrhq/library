/*
 * The word of a design in a language (ADR-109): what its picture made ahead was drawn from, of its
 * slide and its pictures. A picture is shown while the design has the word it was drawn from; once
 * the slide or a picture of it changes, the design is drawn live. Publishing writes the words
 * (`elements/designs/revs.json`, and `images/designs/thumbs/index.json` for the pictures), and the
 * app makes the word of each design it reads again, of its slide, so that a design that changed
 * puts out of date the picture of that design alone. Slidr Library writes them with this module
 * (its `vendor/`), so both make the same word of the same design.
 *
 * Nothing here reads: `designs.ts` and `designThumbs.ts` do.
 */

/**
 * How the renderer draws a design. A change to how it draws, or to a font, changes no word:
 * raising this puts every picture made ahead out of date.
 */
export const DESIGN_DRAWING = 1;

/** The pictures of a design, by their place in the library: its picture, and its backdrop. */
export const designPicturePaths = (id: string) =>
  [`images/designs/${id}.webp`, `images/designs/${id}-bg.webp`] as const;

/**
 * What the word of a design in a language is made of: the drawing, its slide in that language as
 * the catalog holds it, and the SHA-256 of each of its pictures (`designPicturePaths`; null for one
 * it does not have).
 */
export const designDrawing = (slide: unknown, pictures: readonly (string | null)[]) =>
  JSON.stringify([DESIGN_DRAWING, slide, pictures]);

/** The word of a drawing: the first 16 hexadecimal digits of its SHA-256. */
export async function designWord(drawing: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(drawing));
  return Array.from(new Uint8Array(digest, 0, 8), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
}
