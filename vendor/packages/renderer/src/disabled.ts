import { DISABLED_LOOK } from '@slidr/model';

/**
 * An element shown as out of use (`disabled`, SPEC 5.2) is drawn grey and faded: a filter at the
 * end of its box's own, so its shadow fades with it, and a group with everything in it. The
 * runtime takes an element there and back in a show (the `disable` and `enable` emphasis
 * animations); it finds what the renderer drew by the attribute, and takes the filter off the end
 * of the box's. `packages/runtime/src/disabled.ts` repeats both, and a test in
 * `@slidr/html-export` holds the two together.
 */
export const DISABLED_FILTER = `grayscale(${DISABLED_LOOK.grayscale}) opacity(${DISABLED_LOOK.opacity})`;

/** On the box of an element that is drawn as out of use. */
export const DISABLED_ATTRIBUTE = 'data-slidr-disabled';
