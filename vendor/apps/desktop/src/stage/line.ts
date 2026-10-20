import type { Frame, LineElement, Point } from '@slidr/model';
import { apply, boundsOf, boxMatrix, invert, tidy, tidyFrame } from './space';

/**
 * Editing lines on the Stage (WG5-T05, SHP-05). A line's `points` are relative to its frame, and
 * the frame is the box around them; the line is mirrored and rotated around the centre of that box
 * like every element. Moving one point therefore changes all of them and the frame, while the other
 * points stay where they are on the slide. These functions do that, and tell how far a pointer is
 * from the stroke.
 */

type LineBox = Pick<LineElement, 'frame' | 'rotation' | 'flipH' | 'flipV' | 'points'>;

/** The line's points in the coordinates its frame is written in (the slide, or its group). */
export function linePoints(line: LineBox): Point[] {
  const m = boxMatrix(line);
  return line.points.map((p) => apply(m, p));
}

/**
 * The frame and the points that put a line through the given positions, keeping its rotation and
 * mirroring. The frame is the box around the points in the line's own axes.
 */
export function fitLine(
  line: Pick<LineElement, 'rotation' | 'flipH' | 'flipV'>,
  positions: readonly Point[],
): { frame: Frame; points: Point[] } {
  // Undo the rotation and the mirroring around the origin; the box then says where the centre is.
  const turn = boxMatrix({ ...line, frame: { x: 0, y: 0, w: 0, h: 0 } });
  const back = invert(turn);
  const own = positions.map((p) => apply(back, p));
  const box = boundsOf(own);
  const center = apply(turn, { x: box.x + box.w / 2, y: box.y + box.h / 2 });
  return {
    frame: tidyFrame({ x: center.x - box.w / 2, y: center.y - box.h / 2, w: box.w, h: box.h }),
    points: own.map((p) => ({ x: tidy(p.x - box.x), y: tidy(p.y - box.y) })),
  };
}

/** A line after one of its points went to `to` (in the frame's coordinates); the others stay. */
export function moveLinePoint(
  line: LineBox,
  index: number,
  to: Point,
): { frame: Frame; points: Point[] } {
  const positions = linePoints(line);
  positions[index] = to;
  return fitLine(line, positions);
}

/**
 * The point on the ray from `anchor` nearest to `p`, among rays at multiples of `step` degrees:
 * Shift while dragging a line's end (SHP-05).
 */
export function constrainAngle(anchor: Point, p: Point, step = 15): Point {
  const dx = p.x - anchor.x;
  const dy = p.y - anchor.y;
  if (dx === 0 && dy === 0) return p;
  const unit = (step * Math.PI) / 180;
  const angle = Math.round(Math.atan2(dy, dx) / unit) * unit;
  const snap = (v: number) => (Math.abs(v) < 1e-12 ? 0 : v);
  const ux = snap(Math.cos(angle));
  const uy = snap(Math.sin(angle));
  const along = dx * ux + dy * uy;
  return { x: anchor.x + ux * along, y: anchor.y + uy * along };
}

/** The point a dragged one is measured from when Shift constrains the angle: its neighbour. */
export function neighbourIndex(count: number, index: number): number {
  return index === 0 ? 1 : index === count - 1 ? count - 2 : index - 1;
}

const CURVE_STEPS = 16;

function cubic(p0: Point, c1: Point, c2: Point, p1: Point, into: Point[]): void {
  for (let i = 1; i <= CURVE_STEPS; i++) {
    const t = i / CURVE_STEPS;
    const u = 1 - t;
    const a = u * u * u;
    const b = 3 * u * u * t;
    const c = 3 * u * t * t;
    const d = t * t * t;
    into.push({
      x: a * p0.x + b * c1.x + c * c2.x + d * p1.x,
      y: a * p0.y + b * c1.y + c * c2.y + d * p1.y,
    });
  }
}

/**
 * The path of a line as the renderer draws it (`linePath`), flattened to straight pieces, one
 * list per stretch between two of its points. Curves are sampled.
 */
export function lineStretches(points: readonly Point[], curve: LineElement['curve']): Point[][] {
  const out: Point[][] = [];
  const first = points[0] as Point;
  const last = points[points.length - 1] as Point;
  if (curve === 'elbow') {
    if (points.length === 2) {
      const mx = (first.x + last.x) / 2;
      return [[first, { x: mx, y: first.y }, { x: mx, y: last.y }, last]];
    }
    for (let i = 0; i + 1 < points.length; i++) {
      const p = points[i] as Point;
      const q = points[i + 1] as Point;
      out.push([p, { x: q.x, y: p.y }, q]);
    }
    return out;
  }
  if (curve === 'curved') {
    if (points.length === 2) {
      const mx = (first.x + last.x) / 2;
      const stretch = [first];
      cubic(first, { x: mx, y: first.y }, { x: mx, y: last.y }, last, stretch);
      return [stretch];
    }
    for (let i = 0; i + 1 < points.length; i++) {
      const p0 = (points[i - 1] ?? points[i]) as Point;
      const p1 = points[i] as Point;
      const p2 = points[i + 1] as Point;
      const p3 = points[i + 2] ?? p2;
      const stretch = [p1];
      cubic(
        p1,
        { x: p1.x + (p2.x - p0.x) / 6, y: p1.y + (p2.y - p0.y) / 6 },
        { x: p2.x - (p3.x - p1.x) / 6, y: p2.y - (p3.y - p1.y) / 6 },
        p2,
        stretch,
      );
      out.push(stretch);
    }
    return out;
  }
  for (let i = 0; i + 1 < points.length; i++) {
    out.push([points[i] as Point, points[i + 1] as Point]);
  }
  return out;
}

function nearestOnSegment(p: Point, a: Point, b: Point): Point {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = dx * dx + dy * dy;
  const t = len === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len));
  return { x: a.x + dx * t, y: a.y + dy * t };
}

/** The point of the line's path nearest to `p` (both in the line's own coordinates). */
export function nearestOnLine(
  points: readonly Point[],
  curve: LineElement['curve'],
  p: Point,
): { distance: number; point: Point; stretch: number } {
  let best = { distance: Infinity, point: points[0] as Point, stretch: 0 };
  lineStretches(points, curve).forEach((stretch, index) => {
    for (let i = 0; i + 1 < stretch.length; i++) {
      const q = nearestOnSegment(p, stretch[i] as Point, stretch[i + 1] as Point);
      const distance = Math.hypot(p.x - q.x, p.y - q.y);
      if (distance < best.distance) best = { distance, point: q, stretch: index };
    }
  });
  return best;
}

/**
 * How far a position (in the frame's coordinates) is from the line's stroke, measured from the
 * edge of the stroke: 0 on the stroke itself. Hit-testing a line goes by this, not by its frame.
 */
export function distanceToLine(
  line: LineBox & Pick<LineElement, 'curve' | 'stroke'>,
  position: Point,
): number {
  const own = apply(invert(boxMatrix(line)), position);
  const { distance } = nearestOnLine(line.points, line.curve, own);
  return Math.max(0, distance - line.stroke.width / 2);
}

/**
 * A line with one more point, on its path next to `position` (in the frame's coordinates): a
 * bend for a straight line, a corner for an elbow, a point the curve goes through. Returns the
 * index of the new point too.
 */
export function insertLinePoint(
  line: LineBox & Pick<LineElement, 'curve'>,
  position: Point,
): { frame: Frame; points: Point[]; index: number } {
  const m = boxMatrix(line);
  const own = apply(invert(m), position);
  const near = nearestOnLine(line.points, line.curve, own);
  const index = near.stretch + 1;
  const positions = line.points.map((p) => apply(m, p));
  // On a whole pixel of the line's own axes, like the points a drag leaves.
  positions.splice(
    index,
    0,
    apply(m, { x: Math.round(near.point.x), y: Math.round(near.point.y) }),
  );
  return { ...fitLine(line, positions), index };
}

/** The point halfway along a path of straight pieces, by its length. */
function halfway(path: readonly Point[]): Point {
  const lengths = path.slice(1).map((p, i) => {
    const from = path[i] as Point;
    return Math.hypot(p.x - from.x, p.y - from.y);
  });
  let left = lengths.reduce((sum, length) => sum + length, 0) / 2;
  for (let i = 0; i < lengths.length; i++) {
    const length = lengths[i] as number;
    if (left <= length && length > 0) {
      const from = path[i] as Point;
      const to = path[i + 1] as Point;
      const t = left / length;
      return { x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t };
    }
    left -= length;
  }
  return path[path.length - 1] as Point;
}

/**
 * A line with one more point, halfway along the stretch that follows point `after` as the line is
 * drawn; after the last point, halfway along the stretch that leads to it. This is how a point is
 * added from the keyboard, where there is no pointer to say where (UI-06). Returns the index of
 * the new point too.
 */
export function addLinePoint(
  line: LineBox & Pick<LineElement, 'curve'>,
  after: number,
): { frame: Frame; points: Point[]; index: number } {
  const stretches = lineStretches(line.points, line.curve);
  // A line of two points is one stretch whatever its curve; otherwise there is one per pair.
  const stretch = Math.max(0, Math.min(after, stretches.length - 1));
  const middle = halfway(stretches[stretch] ?? line.points);
  const index = stretches.length === 1 ? 1 : stretch + 1;
  const m = boxMatrix(line);
  const positions = line.points.map((p) => apply(m, p));
  // On a whole pixel of the line's own axes, like the points a drag leaves.
  positions.splice(index, 0, apply(m, { x: Math.round(middle.x), y: Math.round(middle.y) }));
  return { ...fitLine(line, positions), index };
}

/** A line without one of its points, or undefined when only its two ends are left. */
export function removeLinePoint(
  line: LineBox,
  index: number,
): { frame: Frame; points: Point[] } | undefined {
  if (line.points.length <= 2) return undefined;
  const positions = linePoints(line);
  positions.splice(index, 1);
  return fitLine(line, positions);
}
