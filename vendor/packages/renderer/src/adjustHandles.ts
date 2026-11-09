import type { Point } from '@slidr/model';

/**
 * The adjustment handles of the presets (ADR-133): points on a shape that set its `adjust`
 * values when they are dragged, as the yellow handles of other editors do. Each stands on the
 * part of the shape its value sizes (the inner edge of a ring, the end of a rounded corner, the
 * base of an arrow's head, the tip of a speech bubble's tail) and follows the pointer as far as
 * that value can go.
 *
 * Positions are in the shape's own pixels before it is mirrored, as `presetPath` draws it. The
 * values are the fractions `geometry.ts` documents for each preset.
 */

/**
 * What a preset is drawn with where it has no value of its own: the fallbacks of `geometry.ts`,
 * which a test holds these to.
 */
const DEFAULTS: Readonly<Record<string, readonly number[]>> = {
  roundRect: [0.1667],
  triangle: [0.5],
  parallelogram: [0.25],
  trapezoid: [0.25],
  star4: [0.38],
  star5: [0.45],
  star6: [0.55],
  star8: [0.7],
  star12: [0.75],
  plus: [0.3],
  arrowRight: [0.5, 0.5],
  arrowLeft: [0.5, 0.5],
  arrowDown: [0.5, 0.5],
  arrowUp: [0.5, 0.5],
  arrowLeftRight: [0.5, 0.5],
  chevron: [0.5],
  homePlate: [0.5],
  wedgeRectCallout: [0.2, 1.25],
  wedgeRoundRectCallout: [0.2, 1.25],
  donut: [0.25],
  frame: [0.12],
  leftBracket: [1],
  rightBracket: [1],
};

/** A handle of a shape, where it stands now. */
export interface AdjustHandle {
  /** In the shape's own pixels, before it is mirrored. */
  at: Point;
  /** The way it runs from there, a unit vector; none for a handle that goes every way. */
  along?: Point;
}

interface HandleSpec {
  at(w: number, h: number, adj: readonly number[]): Point;
  along?(w: number, h: number, adj: readonly number[]): Point | undefined;
  /** The values that bring the handle nearest `p`, the others kept. */
  to(w: number, h: number, adj: readonly number[], p: Point): number[];
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
/** Four places, as the corner control of a rounded rectangle writes its value. */
const round = (v: number) => Math.round(v * 10000) / 10000;

type Place = (v: number, w: number, h: number, adj: readonly number[]) => Point;
type Bound = number | ((w: number, h: number) => number);

/**
 * A handle that one value moves along a path, from `lo` to `hi`. A drag takes the value whose
 * point is nearest the pointer: the handle slides along its path however the pointer wanders off
 * it, and stops at either end.
 */
function slider(index: number, lo: Bound, hi: Bound, place: Place): HandleSpec {
  const range = (w: number, h: number): [number, number] => {
    const a = typeof lo === 'number' ? lo : lo(w, h);
    const b = typeof hi === 'number' ? hi : hi(w, h);
    return [a, Math.max(a, b)];
  };
  const value = (w: number, h: number, adj: readonly number[]) => {
    const [a, b] = range(w, h);
    return clamp(adj[index] ?? a, a, b);
  };
  return {
    at: (w, h, adj) => place(value(w, h, adj), w, h, adj),
    along: (w, h, adj) => {
      const [a, b] = range(w, h);
      const v = value(w, h, adj);
      const step = (b - a) / 100;
      const p = place(Math.max(a, v - step), w, h, adj);
      const q = place(Math.min(b, v + step), w, h, adj);
      const length = Math.hypot(q.x - p.x, q.y - p.y);
      return length > 1e-9 ? { x: (q.x - p.x) / length, y: (q.y - p.y) / length } : undefined;
    },
    to: (w, h, adj, p) => {
      const [a, b] = range(w, h);
      const off = (v: number) => {
        const q = place(v, w, h, adj);
        return Math.hypot(q.x - p.x, q.y - p.y);
      };
      // The nearest of a coarse row of values, then narrowed down around it. Every path here is
      // straight, so the distance has one low point and the narrowing finds it.
      const n = 64;
      let best = a;
      let least = off(a);
      for (let i = 1; i <= n; i++) {
        const v = a + ((b - a) * i) / n;
        const d = off(v);
        if (d < least - 1e-9) {
          best = v;
          least = d;
        }
      }
      let from = Math.max(a, best - (b - a) / n);
      let until = Math.min(b, best + (b - a) / n);
      for (let k = 0; k < 40; k++) {
        const m1 = from + (until - from) / 3;
        const m2 = until - (until - from) / 3;
        if (off(m1) <= off(m2)) until = m2;
        else from = m1;
      }
      const out = [...adj];
      out[index] = round((from + until) / 2);
      return out;
    },
  };
}

/** The tip of a speech bubble's tail, which goes anywhere: two values, across and down. */
const tip: HandleSpec = {
  at: (w, h, adj) => ({ x: (adj[0] ?? 0) * w, y: (adj[1] ?? 0) * h }),
  to: (w, h, adj, p) => {
    const out = [...adj];
    out[0] = round(p.x / w);
    out[1] = round(p.y / h);
    return out;
  },
};

/**
 * The inner radius of a star, on the upright line through its centre: the star as `star` in
 * `geometry.ts` draws it, its points on a circle and the box around them stretched to the frame.
 */
function starInner(points: number): HandleSpec {
  return slider(0, 0, 1, (v, w, h) => {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (let i = 0; i < points * 2; i++) {
      const a = -Math.PI / 2 + (i * Math.PI) / points;
      const r = i % 2 ? v : 1;
      const x = r * Math.cos(a);
      const y = r * Math.sin(a);
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
    const sx = w / (maxX - minX || 1);
    const sy = h / (maxY - minY || 1);
    return { x: -minX * sx, y: (-v - minY) * sy };
  });
}

/** An arrow's box as the right-pointing arrow it is drawn from, and the way back to the shape. */
type Pointing = (w: number, h: number) => { w: number; h: number; map: (p: Point) => Point };

const pointing: Record<'right' | 'left' | 'down' | 'up', Pointing> = {
  right: (w, h) => ({ w, h, map: (p) => p }),
  left: (w, h) => ({ w, h, map: (p) => ({ x: w - p.x, y: p.y }) }),
  down: (w, h) => ({ w: h, h: w, map: (p) => ({ x: p.y, y: p.x }) }),
  up: (w, h) => ({ w: h, h: w, map: (p) => ({ x: p.y, y: h - p.x }) }),
};

/** The thickness of an arrow's shaft, where it meets the head, and the length of the head. */
function arrow(way: Pointing): HandleSpec[] {
  return [
    slider(0, 0, 1, (v, w, h, adj) => {
      const o = way(w, h);
      const head = clamp(adj[1] ?? 0.5, 0, 1) * Math.min(o.w, o.h);
      return o.map({ x: o.w - head, y: o.h / 2 - (v * o.h) / 2 });
    }),
    slider(1, 0, 1, (v, w, h) => {
      const o = way(w, h);
      return o.map({ x: o.w - v * Math.min(o.w, o.h), y: 0 });
    }),
  ];
}

/** On the top edge, as far in as the value says, of the width or of the shorter side. */
const alongTop = (max: number, of: 'width' | 'shorter'): HandleSpec =>
  slider(0, 0, max, (v, w, h) => ({ x: v * (of === 'width' ? w : Math.min(w, h)), y: 0 }));

/** On the inner edge of a ring or a frame, at the height of its middle. */
const innerEdge = slider(0, 0, 0.5, (v, w, h) => ({ x: v * Math.min(w, h), y: h / 2 }));

/** Where a bracket's corner ends, as deep as half its height. */
const bracket = (side: 'left' | 'right'): HandleSpec =>
  slider(
    0,
    0,
    (w, h) => Math.min(1, h / 2 / Math.max(w, 1e-6)),
    (v, w) => ({ x: side === 'left' ? 0 : w, y: v * w }),
  );

const HANDLES: Readonly<Record<string, readonly HandleSpec[]>> = {
  roundRect: [alongTop(0.5, 'shorter')],
  triangle: [alongTop(1, 'width')],
  parallelogram: [alongTop(1, 'width')],
  trapezoid: [alongTop(0.5, 'width')],
  star4: [starInner(4)],
  star5: [starInner(5)],
  star6: [starInner(6)],
  star8: [starInner(8)],
  star12: [starInner(12)],
  // The inner corner of the top arm and the left one.
  plus: [
    slider(0, 0, 1, (v, w, h) => {
      const t = (v * Math.min(w, h)) / 2;
      return { x: w / 2 - t, y: h / 2 - t };
    }),
  ],
  arrowRight: arrow(pointing.right),
  arrowLeft: arrow(pointing.left),
  arrowDown: arrow(pointing.down),
  arrowUp: arrow(pointing.up),
  // The head on the right; the left one is its mirror.
  arrowLeftRight: [
    slider(0, 0, 1, (v, w, h, adj) => ({
      x: w - clamp(adj[1] ?? 0.5, 0, 1) * Math.min(w / 2, h),
      y: h / 2 - (v * h) / 2,
    })),
    slider(1, 0, 1, (v, w, h) => ({ x: w - v * Math.min(w / 2, h), y: 0 })),
  ],
  // The corner where the point begins.
  chevron: [slider(0, 0, 1, (v, w, h) => ({ x: w - v * Math.min(w, h) * 0.5, y: 0 }))],
  homePlate: [slider(0, 0, 1, (v, w, h) => ({ x: w - v * Math.min(w, h) * 0.5, y: 0 }))],
  wedgeRectCallout: [tip],
  wedgeRoundRectCallout: [tip],
  donut: [innerEdge],
  frame: [innerEdge],
  leftBracket: [bracket('left')],
  rightBracket: [bracket('right')],
};

/** The values a preset is drawn with when it has none, or undefined for one that takes none. */
export function adjustDefaults(preset: string): readonly number[] | undefined {
  return DEFAULTS[preset];
}

/** The values of a preset, each one it lacks filled in as it is drawn. */
function filled(preset: string, adjust: readonly number[]): number[] {
  const defaults = DEFAULTS[preset] ?? [];
  return defaults.map((d, i) => adjust[i] ?? d);
}

/** The handles of a preset at a size, with the values it has; none for a preset without values. */
export function adjustHandles(
  preset: string,
  w: number,
  h: number,
  adjust: readonly number[] = [],
): AdjustHandle[] {
  const specs = HANDLES[preset];
  if (!specs || !(w > 0) || !(h > 0)) return [];
  const adj = filled(preset, adjust);
  return specs.map((spec) => {
    const along = spec.along?.(w, h, adj);
    return along ? { at: spec.at(w, h, adj), along } : { at: spec.at(w, h, adj) };
  });
}

/**
 * The values of a preset with its handle `index` brought as near to `p` (in the shape's own
 * pixels) as it goes: the whole list, the values of its other handles kept. Undefined for a
 * handle the preset does not have.
 */
export function adjustTo(
  preset: string,
  index: number,
  w: number,
  h: number,
  adjust: readonly number[],
  p: Point,
): number[] | undefined {
  const spec = HANDLES[preset]?.[index];
  if (!spec || !(w > 0) || !(h > 0)) return undefined;
  return spec.to(w, h, filled(preset, adjust), p);
}
