import type { Point, ShapeElement } from '@slidr/model';
import type { AdjustHandle } from './adjustHandles';
import { flattenPath, isBoxPreset, presetPath, scalePath, type ShapePath } from './geometry';

/**
 * The outline handle of a shape (ADR-137): a yellow diamond on the inner edge of its outline,
 * which sets how thick the outline is, as the handle of a ring sets how thick the ring is.
 *
 * It stands at the height of the shape's middle, where its edge crosses that height furthest to
 * the right, and runs in from there, to the left. The outline of a shape is drawn inside its edge
 * (`PathStroke` and `BoxStroke` in `elements.tsx`): an outline `w` thick ends where a point inside
 * the shape is `w` from its edge. A box (rectangle, rounded rectangle, ellipse) is bordered as a
 * page borders one, so its outline ends `w` in from its right side.
 *
 * The right side keeps it apart from the handles of the presets' own values (ADR-133): none of
 * them stands there, and the handle of a ring, which it would be most like, is on the left.
 *
 * Positions are in the shape's own pixels before it is mirrored, as `presetPath` draws it.
 */

type Geometry = ShapeElement['geometry'];

/** The way the handle runs: in from the right side. */
const ALONG: Point = { x: -1, y: 0 };

/** Points along the way in that are measured to find where it is deepest. */
const SAMPLES = 96;

/** The way in from the right side of a shape, at the height of its middle. */
interface Way {
  /** Where the edge is crossed. */
  from: Point;
  /** How far from the edge the point `t` in from `from` is. */
  depth(t: number): number;
  /** As far in as a point gets deeper: an outline as deep as that fills the shape there. */
  reach: number;
  /** How far in an outline so thick ends, where that is known without a search. */
  edge?(width: number): number;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** The path of a shape as the renderer draws it (`shapePath` in `elements.tsx`). */
function pathOf(geometry: Geometry, w: number, h: number): ShapePath {
  if (geometry.kind === 'path')
    return {
      d: scalePath(geometry.d, w / geometry.viewBox.w, h / geometry.viewBox.h),
      closed: /z\s*$/i.test(geometry.d.trim()),
    };
  return (
    presetPath(geometry.preset, w, h, geometry.adjust) ?? (presetPath('rect', w, h) as ShapePath)
  );
}

/** How far a point is from a piece of the edge. */
function distance(px: number, py: number, a: readonly number[], b: readonly number[]): number {
  const [ax, ay] = a as [number, number];
  const [bx, by] = b as [number, number];
  const dx = bx - ax;
  const dy = by - ay;
  const length = dx * dx + dy * dy;
  const t = length > 0 ? clamp(((px - ax) * dx + (py - ay) * dy) / length, 0, 1) : 0;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function wayIn(geometry: Geometry, w: number, h: number): Way | undefined {
  if (!(w > 0) || !(h > 0)) return undefined;
  const middle = h / 2;
  if (geometry.kind === 'preset' && isBoxPreset(geometry.preset))
    return {
      from: { x: w, y: middle },
      depth: (t) => t,
      reach: Math.min(w, h) / 2,
      edge: (width) => width,
    };
  const path = pathOf(geometry, w, h);
  // An open outline (a bracket) is drawn on its line, and has no inside to go into.
  if (!path.closed) return undefined;
  const runs = flattenPath(path.d);
  const crossings: number[] = [];
  for (const run of runs) {
    for (let i = 1; i < run.length; i++) {
      const [ax, ay] = run[i - 1]!;
      const [bx, by] = run[i]!;
      if (ay === by || (ay - middle) * (by - middle) > 0) continue;
      crossings.push(ax + ((middle - ay) * (bx - ax)) / (by - ay));
    }
  }
  crossings.sort((a, b) => b - a);
  const right = crossings[0];
  // Where the way leaves the inside again: the next crossing, past one that only touches a corner.
  const left = right === undefined ? undefined : crossings.find((x) => x < right - 0.5);
  if (right === undefined || left === undefined) return undefined;
  const depth = (t: number) => {
    const px = right - t;
    let least = Infinity;
    for (const run of runs)
      for (let i = 1; i < run.length; i++)
        least = Math.min(least, distance(px, middle, run[i - 1]!, run[i]!));
    return least;
  };
  // The first point where it gets no deeper, found along a row of points and then narrowed down.
  const span = right - left;
  const step = span / SAMPLES;
  let i = 1;
  let before = depth(0);
  for (; i <= SAMPLES; i++) {
    const d = depth(i * step);
    if (d < before - 1e-9) break;
    before = d;
  }
  let from = Math.max(0, (i - 2) * step);
  let until = Math.min(span, i * step);
  for (let k = 0; k < 40; k++) {
    const m1 = from + (until - from) / 3;
    const m2 = until - (until - from) / 3;
    if (depth(m1) >= depth(m2)) until = m2;
    else from = m1;
  }
  return { from: { x: right, y: middle }, depth, reach: (from + until) / 2 };
}

/** How far in an outline `width` thick ends. */
function innerEdge(way: Way, width: number): number {
  if (width <= 0) return 0;
  if (way.edge) return Math.min(way.edge(width), way.reach);
  if (width >= way.depth(way.reach)) return way.reach;
  let from = 0;
  let until = way.reach;
  for (let k = 0; k < 40; k++) {
    const m = (from + until) / 2;
    if (way.depth(m) < width) from = m;
    else until = m;
  }
  return (from + until) / 2;
}

/**
 * The outline handle of a shape at a size, its outline `width` thick; none for a shape it cannot
 * stand on: an open outline, such as a bracket, or a shape whose middle height misses it.
 */
export function outlineHandle(
  geometry: Geometry,
  w: number,
  h: number,
  width: number,
): AdjustHandle | undefined {
  const way = wayIn(geometry, w, h);
  if (!way) return undefined;
  const t = innerEdge(way, Math.max(0, width));
  return { at: { x: way.from.x - t, y: way.from.y }, along: ALONG };
}

/**
 * How thick the outline is that brings the outline handle as near `p` (in the shape's own pixels)
 * as it goes: in whole pixels, at least one. Undefined for a shape without the handle.
 */
export function outlineWidthTo(
  geometry: Geometry,
  w: number,
  h: number,
  p: Point,
): number | undefined {
  const way = wayIn(geometry, w, h);
  if (!way) return undefined;
  const t = clamp(way.from.x - p.x, 0, way.reach);
  return Math.max(1, Math.round(way.depth(t)));
}
