import type { Accent, Direction, ElementPatch, Fill, ShapeElement } from '@slidr/model';
import { isBoxPreset } from '@slidr/renderer';
import { radiusControl } from './effects';

/*
 * The accent of a box (ADR-073): one side of it drawn in a colour of its own, the coloured edge of
 * a card. What row B offers for it, what a new one starts from, and the patches its controls
 * write. Pure, so it is tested without a DOM.
 */

/** Only the presets the renderer draws as a box have sides: a star or a path has none. */
export function takesAccent(shape: ShapeElement): boolean {
  return shape.geometry.kind === 'preset' && isBoxPreset(shape.geometry.preset);
}

/**
 * What the side control offers. The two sides across the lines of text are chosen as the deck
 * reads: `start` is the side its lines begin on, the right one in a right-to-left deck. The model
 * keeps the side of the box itself, so an accent stays where it was put.
 */
export type AccentChoice = 'none' | 'top' | 'bottom' | 'start' | 'end';

type Side = Accent['side'];

/** The side of the box a choice is, in a deck of the given direction. */
export function sideOf(choice: Exclude<AccentChoice, 'none'>, dir: Direction): Side {
  if (choice === 'top' || choice === 'bottom') return choice;
  return (choice === 'start') === (dir === 'rtl') ? 'right' : 'left';
}

/** The choice that an accent, or none, is in a deck of the given direction. */
export function choiceOf(accent: Accent | undefined, dir: Direction): AccentChoice {
  if (!accent) return 'none';
  const { side } = accent;
  if (side === 'top' || side === 'bottom') return side;
  return (side === 'right') === (dir === 'rtl') ? 'start' : 'end';
}

/**
 * The choices in the order the control lays them out. The control follows the direction of the
 * UI, and each of the two sides is drawn as the side of the box it is: they are ordered so that
 * the right side is on the right, also when the deck reads the other way than the UI does.
 */
export function accentChoices(deck: Direction, ui: Direction): AccentChoice[] {
  return [
    'none',
    'top',
    'bottom',
    ...(deck === ui ? (['start', 'end'] as const) : (['end', 'start'] as const)),
  ];
}

/** Thickness of a new accent, in slide pixels: the edge of a card on a 1920 slide. */
export const ACCENT_SIZE = 8;
/** The thickest accent the controls offer, in slide pixels. */
export const MAX_ACCENT_SIZE = 120;

/**
 * A new accent: in the theme's primary colour, so it follows the theme. On a box that is itself
 * filled with that colour, as a new shape is, it would not show: there it takes the theme's
 * accent colour.
 */
export function newAccent(side: Side, shape: ShapeElement): Accent {
  const { fill } = shape;
  const onPrimary =
    fill.kind === 'solid' && 'token' in fill.color && fill.color.token === 'primary';
  return {
    side,
    size: ACCENT_SIZE,
    fill: { kind: 'solid', color: { token: onPrimary ? 'accent' : 'primary' } },
  };
}

/**
 * The patch of a choice of side. `none` takes the accent away; a side moves the accent the shape
 * has there, with its colour and thickness. A shape without one gets `last`, the accent that was
 * taken away a moment ago, or a new one.
 */
export function sidePatch(
  shape: ShapeElement,
  choice: AccentChoice,
  dir: Direction,
  last?: Accent,
): ElementPatch {
  if (choice === 'none') return { accent: null };
  const side = sideOf(choice, dir);
  return { accent: { ...(shape.accent ?? last ?? newAccent(side, shape)), side } };
}

export function sizePatch(accent: Accent, size: number): ElementPatch {
  return { accent: { ...accent, size: Math.min(MAX_ACCENT_SIZE, Math.max(1, size)) } };
}

/** An accent that the corners cut, which is what one that says nothing is. */
function cut(accent: Accent): Accent {
  const { corners: _corners, ...rest } = accent;
  return rest;
}

/** Only an accent of one colour can go around the corners: the renderer draws it as a border. */
export function canFollowCorners(accent: Accent): boolean {
  return accent.fill.kind === 'solid';
}

/** Whether the accent goes around the corners as it is drawn, not only as it is stored. */
export function followsCorners(accent: Accent): boolean {
  return accent.corners === 'follow' && canFollowCorners(accent);
}

/**
 * The patch of a new fill. A fill that is not one colour is always cut by the corners, so an
 * accent that went around them is stored as what it now is.
 */
export function fillPatch(accent: Accent, fill: Fill): ElementPatch {
  const next = { ...accent, fill };
  return { accent: canFollowCorners(next) ? next : cut(next) };
}

/** Around the corners, or cut by them. Cut is the default, and is stored as no word at all. */
export function cornersPatch(accent: Accent, follow: boolean): ElementPatch {
  return {
    accent: follow && canFollowCorners(accent) ? { ...accent, corners: 'follow' } : cut(accent),
  };
}

/**
 * Whether the box has rounded corners for an accent to go around or to be cut by. A box with
 * square corners has none to go around, and the choice is not offered for it.
 */
export function hasRoundCorners(shape: ShapeElement): boolean {
  if (!takesAccent(shape)) return false;
  const geometry = shape.geometry;
  if (geometry.kind === 'preset' && geometry.preset === 'ellipse') return true;
  return (radiusControl(shape)?.value ?? 0) > 0;
}
