/*
 * A slide drawn as a thumbnail (`thumbnail` mode) holds still whatever moves by itself
 * (ADR-134): the pictures of Elements, whose markup moves (ADR-127), the motion an element
 * repeats (ADR-128) and what runs along a line (ADR-131). Every thumbnail of the filmstrip and of
 * a panel drew its motion on every frame: twenty slides with a moving background took a page in
 * Edge down to five frames a second. The stage, a show and an exported file still move.
 *
 * A host that plays a thumbnail on purpose, as a tile of Elements does under the pointer, plays
 * its animations itself: `Animation.play()` and `SVGSVGElement.unpauseAnimations()` take
 * precedence over what holds them here.
 */

/** How far into its motion a thumbnail holds a picture, in seconds: where it shows what it is. */
export const STILL_AT = 4;

/** On the root of a slide drawn as a thumbnail, whose motion is held (`STILL_CSS`). */
export const STILL_ATTRIBUTE = 'data-slidr-still';

/**
 * Holds the CSS animations of a thumbnail's own elements at their start, at rest: a turn not
 * begun, a float in its place, the dashes of a line where they are drawn.
 */
export const STILL_CSS = `.slidr-slide[${STILL_ATTRIBUTE}] *{animation-play-state:paused!important}`;

/**
 * Holds a picture in a shadow root at `STILL_AT`: its SMIL timeline and its CSS animations both.
 * Called again whenever the picture is shown again, since CSS animations start over in a picture
 * that was hidden.
 */
export function holdPicture(root: ShadowRoot): void {
  const picture = root.querySelector('svg');
  if (picture instanceof SVGSVGElement) {
    picture.pauseAnimations();
    picture.setCurrentTime(STILL_AT);
  }
  // Only a stylesheet animates by CSS; asking a root without one would restyle it for nothing.
  if (!root.querySelector('style')) return;
  for (const animation of root.getAnimations()) {
    animation.pause();
    animation.currentTime = STILL_AT * 1000;
  }
}
