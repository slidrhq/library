import type { Color, ColorToken } from '@slidr/model';

/*
 * What the app does with the pictures of the animations and the backgrounds of Elements, which
 * the media library draws (ADR-138). Each of them is an `svg` element whose markup moves by
 * itself: CSS `@keyframes` in its own stylesheet for what turns, grows or flows, and SMIL
 * (`animateMotion`, `animate`) for what travels along a path or changes its shape. A picture
 * keeps both (`picture.ts` of the renderer), so it moves wherever it is drawn: on the stage, in a
 * show and in an exported file, and it moves, resizes and turns as any other element does.
 * Nothing of the deck's schema is new.
 */

/**
 * The colours the markup is drawn in, each standing for a colour of the theme: what a picture of
 * the library paints with, written as presentation attributes (`fill="#6c4cf1"`), never in its
 * stylesheet. An element maps them to the theme's tokens (`colorOverrides`), so the drawing
 * follows the template and row B can recolour it. Without that it looks as the reference deck
 * does, whose colours these are.
 */
export const INK = {
  primary: '#6c4cf1',
  secondary: '#2f6bff',
  accent: '#f29a00',
  text: '#15213f',
  surface: '#ffffff',
  /** The ground: a ring that sets a dot apart from what it crosses. */
  bg: '#fbf6ec',
} as const satisfies Partial<Record<ColorToken, string>>;

export type Ink = keyof typeof INK;

/**
 * Light on something round: white in every theme, as light is. The one colour of a drawing that
 * stands for none of the theme's; row B can still change it.
 */
export const GLINT = '#fffffe';

/** The theme colours an element of this markup is drawn in: only those its markup uses. */
export function inkOverrides(markup: string): Record<string, Color> {
  const overrides: Record<string, Color> = {};
  for (const [token, hex] of Object.entries(INK) as [Ink, string][]) {
    if (markup.includes(`"${hex}"`)) overrides[hex] = { token };
  }
  return overrides;
}

/** A number as the markup writes it: at most `digits` decimals, and no `-0`. */
export function num(value: number, digits = 1): string {
  const factor = 10 ** digits;
  const rounded = Math.round(value * factor) / factor;
  return Object.is(rounded, -0) ? '0' : String(rounded);
}

/**
 * A time as the markup writes one: seconds, signed or not, standing alone (not the end of a
 * name). Read only where times are written, since in a path's data `s` is a command.
 */
const TIME = /(?<![\w.-])(-?(?:\d+(?:\.\d+)?|\.\d+))s(?![\w-])/g;

/**
 * The markup with its motion `speed` times as fast (ADR-128): every time written in it divided
 * by `speed`: SMIL's `dur` and `begin`, and the durations and delays of its stylesheet and of
 * its `style` attributes. A part that starts partway into its round starts as far into it.
 */
export function atSpeed(markup: string, speed: number): string {
  if (!(speed > 0) || speed === 1) return markup;
  const scale = (text: string) =>
    text.replace(TIME, (_all, value: string) => `${num(Number(value) / speed, 3)}s`);
  return markup
    .replace(
      /(\s(?:dur|begin)=")([^"]*)"/g,
      (_all, name: string, value: string) => `${name}${scale(value)}"`,
    )
    .replace(
      /(\sstyle=")([^"]*)"/g,
      (_all, name: string, value: string) => `${name}${scale(value)}"`,
    )
    .replace(/<style>([\s\S]*?)<\/style>/g, (_all, css: string) => `<style>${scale(css)}</style>`);
}

/** The markup with an attribute added to its root, after the ones it has. */
export function withRootAttribute(markup: string, name: string, value: string): string {
  const end = markup.indexOf('>');
  if (!markup.startsWith('<svg') || end < 0) return markup;
  const at = markup[end - 1] === '/' ? end - 1 : end;
  return `${markup.slice(0, at)} ${name}="${value}"${markup.slice(at)}`;
}
