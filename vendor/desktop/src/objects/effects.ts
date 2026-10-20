import type {
  Element,
  ElementPatch,
  ImageElement,
  LineElement,
  Shadow,
  ShapeElement,
} from '@slidr/model';
import { isBoxPreset, presetPath } from '@slidr/renderer';

/*
 * What the renderer honours for each element (ADR-009), so row B never offers a control that does
 * nothing, and the patches the controls write. Pure, so it is tested without a DOM.
 */

type Effects = NonNullable<Element['effects']>;

/**
 * `effects` with some of its fields changed. `element.update` replaces a field whole, so the
 * other effects are carried along; null removes one, and when none is left the field itself goes.
 */
export function effectsPatch(
  element: Element,
  change: { [K in keyof Effects]?: Effects[K] | null },
): ElementPatch {
  const next: Record<string, unknown> = { ...element.effects };
  for (const [key, value] of Object.entries(change)) {
    if (value === null) delete next[key];
    else if (value !== undefined) next[key] = value;
  }
  return { effects: Object.keys(next).length > 0 ? next : null };
}

export function shadowPatch(element: Element, shadow: Shadow | null): ElementPatch {
  return effectsPatch(element, { shadow });
}

/**
 * A shadow with spread is drawn as the `box-shadow` of the element's box (ADR-009), so spread is
 * offered only where the box is the picture: a rectangle, an unmasked image, video, HTML, a
 * chart, a table. On any other shape it would draw a rectangle around it.
 */
export function supportsSpread(element: Element): boolean {
  switch (element.type) {
    case 'image':
      return !element.mask;
    case 'shape':
      return element.geometry.kind === 'preset' && element.geometry.preset === 'rect';
    case 'video':
    case 'html':
    case 'chart':
    case 'table':
      return true;
    default:
      return false;
  }
}

export interface RadiusControl {
  /**
   * `px`: slide pixels, in `effects.radius`. `%`: how round a rounded rectangle is, from square
   * corners to a pill; its geometry keeps the corner as a share of the shorter side.
   */
  unit: 'px' | '%';
  value: number;
  max: number;
  patch: (value: number) => ElementPatch;
}

/** The default corner of `roundRect`, and the largest: `adjust[0]`, a share of the shorter side. */
const ROUND_RECT_DEFAULT = 0.1667;
const ROUND_RECT_MAX = 0.5;

/**
 * The corner control of an element, or undefined where corners cannot be rounded. `effects.radius`
 * rounds a rectangle, an unmasked image, a video and HTML; `roundRect` has its own `adjust`.
 */
export function radiusControl(element: Element): RadiusControl | undefined {
  const pixels = (): RadiusControl => ({
    unit: 'px',
    value: Math.round(element.effects?.radius ?? 0),
    max: Math.max(1, Math.floor(Math.min(element.frame.w, element.frame.h) / 2)),
    patch: (value) => effectsPatch(element, { radius: value > 0 ? value : null }),
  });
  switch (element.type) {
    case 'image':
      return element.mask ? undefined : pixels();
    case 'video':
    case 'html':
      return pixels();
    case 'shape': {
      const geometry = element.geometry;
      if (geometry.kind !== 'preset') return undefined;
      if (geometry.preset === 'rect') return pixels();
      if (geometry.preset !== 'roundRect') return undefined;
      const [corner = ROUND_RECT_DEFAULT, ...rest] = geometry.adjust ?? [];
      const share = Math.min(Math.max(corner, 0), ROUND_RECT_MAX) / ROUND_RECT_MAX;
      return {
        unit: '%',
        value: Math.round(share * 100),
        max: 100,
        patch: (value) => ({
          geometry: {
            ...geometry,
            adjust: [Math.round((value / 100) * ROUND_RECT_MAX * 10000) / 10000, ...rest],
          },
        }),
      };
    }
    default:
      return undefined;
  }
}

/** Whether a shape has an inside to fill: brackets, braces and open paths do not. */
export function shapeHasFill(element: ShapeElement): boolean {
  const geometry = element.geometry;
  if (geometry.kind === 'path') return /z\s*$/i.test(geometry.d.trim());
  return presetPath(geometry.preset, 100, 100)?.closed !== false;
}

/**
 * Line ends and joins show only on a drawn path: lines, and shapes that are not CSS boxes. The
 * outline of a rectangle, a rounded rectangle, an ellipse or an image is a border, which has neither.
 */
export function strokeHasCapAndJoin(element: ShapeElement | LineElement | ImageElement): boolean {
  if (element.type === 'line') return true;
  if (element.type === 'image') return element.mask?.kind === 'shape';
  const geometry = element.geometry;
  return geometry.kind === 'path' || !isBoxPreset(geometry.preset);
}
