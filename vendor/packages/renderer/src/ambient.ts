import { AMBIENT_DEFAULTS, walkElements, type AmbientMotion, type Element } from '@slidr/model';
import type { CSSProperties } from 'react';
import { num } from './css';
import { FLOW_KEYFRAMES } from './flow';

/*
 * The ambient motion of an element (ADR-128): a CSS animation that never ends, on a box inside
 * the element's own, so it moves what the element draws under its rotation and its mirroring and
 * beside whatever a show's step does to the element. A turn stays clockwise in a mirrored
 * element: the box that turns is outside the mirror.
 *
 * The keyframes are named for the whole document, so a slide that has such an element writes
 * them once (`AMBIENT_KEYFRAMES`); an exported file carries them with the slide. How far a motion
 * goes is a custom property of its box, which the keyframes read.
 */

/** The custom property a motion's keyframes read how far it goes from. */
const AMOUNT = '--slidr-ambient';

/** Marks the box that moves, so a host can find it (and hold it while text in it is edited). */
export const AMBIENT_ATTRIBUTE = 'data-slidr-ambient';

const at = (transform: string) => `{transform:${transform}}`;
const A = `var(${AMOUNT})`;

/**
 * Every motion twice: as it goes the whole round, and as it moves in the first half and rests
 * in the second (`pause`). A swing goes from one side to the other and back; at rest it hangs
 * straight.
 */
export const AMBIENT_KEYFRAMES = [
  `@keyframes slidr-spin{to${at('rotate(1turn)')}}`,
  `@keyframes slidr-spin-pause{50%,to${at('rotate(1turn)')}}`,
  `@keyframes slidr-pulse{50%${at(`scale(${A})`)}}`,
  `@keyframes slidr-pulse-pause{25%${at(`scale(${A})`)}50%,to${at('none')}}`,
  `@keyframes slidr-float{50%${at(`translateY(${A})`)}}`,
  `@keyframes slidr-float-pause{25%${at(`translateY(${A})`)}50%,to${at('none')}}`,
  `@keyframes slidr-swing{0%,to${at(`rotate(${A})`)}50%${at(`rotate(calc(${A} * -1))`)}}`,
  `@keyframes slidr-swing-pause{12.5%${at(`rotate(${A})`)}37.5%${at(`rotate(calc(${A} * -1))`)}50%,to${at('none')}}`,
  `@keyframes slidr-blink{50%{opacity:${A}}}`,
  `@keyframes slidr-blink-pause{25%{opacity:${A}}50%,to{opacity:1}}`,
  // What runs along a line (ADR-131): its dashes, and the riders on it.
  FLOW_KEYFRAMES,
].join('');

/** How far a motion goes, as the value its keyframes read. */
function amountCss(motion: AmbientMotion): string | undefined {
  const amount = motion.amount ?? AMBIENT_DEFAULTS[motion.kind].amount;
  switch (motion.kind) {
    case 'spin':
      return undefined;
    case 'pulse':
      return String(num(1 + amount));
    case 'float':
      return `${num(-amount)}px`;
    case 'swing':
      return `${num(amount)}deg`;
    case 'blink':
      return String(num(Math.max(0, 1 - Math.min(1, amount))));
  }
}

/**
 * The animation of a motion, for whatever moves by it: the box of an element, or a picture of
 * one in a list. Its keyframes are `AMBIENT_KEYFRAMES`, which the document must have.
 */
export function ambientAnimation(motion: AmbientMotion): CSSProperties {
  const rhythm = motion.rhythm ?? AMBIENT_DEFAULTS[motion.kind].rhythm;
  const name = rhythm === 'pause' ? `slidr-${motion.kind}-pause` : `slidr-${motion.kind}`;
  const timing = rhythm === 'steady' ? 'linear' : 'ease-in-out';
  const reverse = motion.reverse && (motion.kind === 'spin' || motion.kind === 'swing');
  const amount = amountCss(motion);
  return {
    transformOrigin: '50% 50%',
    animation: `${name} ${num(Math.max(1, motion.duration))}ms ${timing} infinite${reverse ? ' reverse' : ''}`,
    ...(amount === undefined ? {} : ({ [AMOUNT]: amount } as CSSProperties)),
  };
}

/** The style of the box that moves. */
export function ambientStyle(motion: AmbientMotion): CSSProperties {
  return {
    // As large as the element's box, and in its flow: a text that grows with its words still
    // grows, and what fills the box fills this one.
    position: 'relative',
    width: '100%',
    height: '100%',
    ...ambientAnimation(motion),
  };
}

/**
 * Whether any of these elements, or anything inside them, moves by itself: a motion it repeats,
 * or a line that something runs along (ADR-131).
 */
export function hasAmbient(elements: readonly Element[] | undefined): boolean {
  if (!elements) return false;
  for (const element of walkElements(elements)) {
    if (element.hidden) continue;
    if (element.ambient || (element.type === 'line' && element.flow)) return true;
  }
  return false;
}
