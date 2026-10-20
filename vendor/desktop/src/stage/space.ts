import {
  plainText,
  rotateVector,
  unionBounds,
  type Element,
  type Frame,
  type GroupElement,
  type Point,
} from '@slidr/model';
import { cardBox } from '../objects/card';

/**
 * Coordinate spaces on the slide (WG5, ARR-01). A child of a group has its frame in the group's
 * own coordinates; the group may be rotated and mirrored, and groups nest. A `Matrix` takes the
 * coordinates an element is written in to slide pixels, so the Stage can select, move, resize and
 * draw handles for an element at any depth with the same geometry it uses at the top level.
 */

/** A 2D affine map as CSS writes it, `matrix(a, b, c, d, e, f)`: x' = ax + cy + e, y' = bx + dy + f. */
export interface Matrix {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
}

export const IDENTITY: Matrix = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };

/** `m` after `n`: the point goes through `n` first. */
export function multiply(m: Matrix, n: Matrix): Matrix {
  return {
    a: m.a * n.a + m.c * n.b,
    b: m.b * n.a + m.d * n.b,
    c: m.a * n.c + m.c * n.d,
    d: m.b * n.c + m.d * n.d,
    e: m.a * n.e + m.c * n.f + m.e,
    f: m.b * n.e + m.d * n.f + m.f,
  };
}

export function invert(m: Matrix): Matrix {
  const det = m.a * m.d - m.b * m.c;
  const a = m.d / det;
  const b = -m.b / det;
  const c = -m.c / det;
  const d = m.a / det;
  return { a, b, c, d, e: -(a * m.e + c * m.f), f: -(b * m.e + d * m.f) };
}

export function apply(m: Matrix, p: Point): Point {
  return { x: m.a * p.x + m.c * p.y + m.e, y: m.b * p.x + m.d * p.y + m.f };
}

/** A direction or a distance through the map: the translation is left out. */
export function applyVector(m: Matrix, v: Point): Point {
  return { x: m.a * v.x + m.c * v.y, y: m.b * v.x + m.d * v.y };
}

/** True when the map only moves things: no rotation, no mirroring. */
export function isTranslation(m: Matrix): boolean {
  const near = (v: number, to: number) => Math.abs(v - to) < 1e-9;
  return near(m.a, 1) && near(m.b, 0) && near(m.c, 0) && near(m.d, 1);
}

type Box = Pick<Element, 'frame' | 'rotation' | 'flipH' | 'flipV'>;

/**
 * From a box's own coordinates (origin at the corner of its frame) to the coordinates the frame
 * is written in: mirrored inside the box, then rotated around its centre (ADR-007). Leave the
 * flips out for what is drawn on the box rather than in it, such as the selection outline.
 */
export function boxMatrix(box: Box, flips = true): Matrix {
  const { x, y, w, h } = box.frame;
  const sx = flips && box.flipH ? -1 : 1;
  const sy = flips && box.flipV ? -1 : 1;
  const col1 = rotateVector({ x: sx, y: 0 }, box.rotation);
  const col2 = rotateVector({ x: 0, y: sy }, box.rotation);
  const cx = w / 2;
  const cy = h / 2;
  return {
    a: col1.x,
    b: col1.y,
    c: col2.x,
    d: col2.y,
    e: x + cx - (col1.x * cx + col2.x * cy),
    f: y + cy - (col1.y * cx + col2.y * cy),
  };
}

/** An element together with where it sits in the slide's tree. */
export interface Located {
  element: Element;
  /** The groups that contain it, outermost first. */
  path: GroupElement[];
  /** Paint order on the slide: a larger number is nearer the viewer. */
  order: number;
  /** From the coordinates its frame is written in (its parent's) to slide pixels. */
  space: Matrix;
  /** Itself or a group around it is hidden / locked. */
  hidden: boolean;
  locked: boolean;
}

/** Every element of a slide by id, nested ones included. */
export function indexElements(elements: readonly Element[]): Map<string, Located> {
  const out = new Map<string, Located>();
  let order = 0;
  const walk = (
    list: readonly Element[],
    path: GroupElement[],
    space: Matrix,
    hidden: boolean,
    locked: boolean,
  ) => {
    for (const element of list) {
      const located: Located = {
        element,
        path,
        order: order++,
        space,
        hidden: hidden || Boolean(element.hidden),
        locked: locked || Boolean(element.locked),
      };
      out.set(element.id, located);
      if (element.type === 'group') {
        walk(
          element.children,
          [...path, element],
          multiply(space, boxMatrix(element)),
          located.hidden,
          located.locked,
        );
      }
    }
  };
  walk(elements, [], IDENTITY, false, false);
  return out;
}

/** Ids of the groups around an element, outermost first. */
export function pathIds(located: Located): string[] {
  return located.path.map((g) => g.id);
}

/** From an element's own box to slide pixels. */
export function elementMatrix(located: Located, flips = false): Matrix {
  return multiply(located.space, boxMatrix(located.element, flips));
}

/** The four corners of a box of the given size through a map, clockwise from the top-left one. */
export function corners(m: Matrix, w: number, h: number): Point[] {
  return [
    apply(m, { x: 0, y: 0 }),
    apply(m, { x: w, y: 0 }),
    apply(m, { x: w, y: h }),
    apply(m, { x: 0, y: h }),
  ];
}

export function boundsOf(points: readonly Point[]): Frame {
  return unionBounds(points.map((p) => ({ x: p.x, y: p.y, w: 0, h: 0 })));
}

/** The axis-aligned box on the slide that contains an element, whatever it is nested in. */
export function slideBounds(located: Located, frame: Frame = located.element.frame): Frame {
  const m = multiply(located.space, boxMatrix({ ...located.element, frame }, false));
  return boundsOf(corners(m, frame.w, frame.h));
}

/**
 * The boxes snapping compares against while elements move (STG-04): what stays put next to them.
 * That is their siblings and the siblings of the groups around them, not the groups themselves
 * (which follow their children) and not the inside of other groups.
 */
export function snapCandidates(
  index: ReadonlyMap<string, Located>,
  moving: ReadonlySet<string>,
): Frame[] {
  const around = new Set<string>();
  for (const id of moving) for (const group of index.get(id)?.path ?? []) around.add(group.id);
  const out: Frame[] = [];
  for (const located of index.values()) {
    const { id } = located.element;
    if (located.hidden || moving.has(id) || around.has(id)) continue;
    if (!located.path.every((group) => around.has(group.id))) continue;
    out.push(slideBounds(located));
  }
  return out;
}

/**
 * Which element a click means, given the group the user has entered (ARR-01). `chain` is the
 * element under the pointer with the groups around it, outermost first; `scope` the entered groups,
 * outermost first. A click picks the element one level inside the innermost entered group that is
 * around the pointer, and leaves the entered groups that are not.
 */
export function resolveHit(
  chain: readonly string[],
  scope: readonly string[],
): { scope: string[]; id: string | undefined } {
  let depth = 0;
  while (depth < scope.length && depth < chain.length && chain[depth] === scope[depth]) depth++;
  return { scope: scope.slice(0, depth), id: chain[depth] };
}

/** Where a press that stays a click goes, beyond selecting the element the press itself took. */
export interface Inside {
  /** The entered groups once the click has gone in, outermost first. */
  scope: string[];
  id: string;
  /** A text the click starts editing, or an object the click selects. */
  edit: boolean;
}

/** What a press at a point means: what `resolveHit` says, and where a click goes in from there. */
export interface Press {
  scope: string[];
  id: string | undefined;
  inside?: Inside;
}

/**
 * A text box and a shape are their text only where the text is (`onText`), as in PowerPoint: the
 * empty part of the box, beside a short line or under the last one, is the box itself.
 */
function holdsText(located: Located, onText: (shape: Located) => boolean): boolean {
  const { element } = located;
  if (element.type === 'text') return onText(located);
  if (element.type !== 'shape' || !element.content) return false;
  return plainText(element.content).trim() !== '' && onText(located);
}

/**
 * The lines of a text, from the boxes its letters are drawn in: one box per stretch of letters on
 * a line, in the element's own space. Boxes at the same height are one line, from where its first
 * letter starts to where its last one ends, whatever the size of each run. Top to bottom.
 */
export function textLines(boxes: readonly Frame[]): Frame[] {
  const lines: Frame[] = [];
  for (const box of [...boxes].sort((a, b) => a.y - b.y)) {
    const middle = box.y + box.h / 2;
    const at = lines.findIndex(
      (line) =>
        (middle >= line.y && middle <= line.y + line.h) ||
        (line.y + line.h / 2 >= box.y && line.y + line.h / 2 <= box.y + box.h),
    );
    if (at < 0) lines.push(box);
    else lines[at] = unionBounds([lines[at] as Frame, box]);
  }
  return lines.sort((a, b) => a.y - b.y);
}

/**
 * The point is on one of the lines (`textLines`), or within `slack` of it. A line reaches halfway
 * to the next one, so the pointer stays on the text between its lines and its paragraphs.
 */
export function onTextLines(lines: readonly Frame[], p: Point, slack: number): boolean {
  return lines.some((line, i) => {
    const before = lines[i - 1];
    const after = lines[i + 1];
    const bottom = line.y + line.h;
    const top = before ? Math.min(line.y, (before.y + before.h + line.y) / 2) : line.y - slack;
    const end = after ? Math.max(bottom, (bottom + after.y) / 2) : bottom + slack;
    return p.y >= top && p.y <= end && p.x >= line.x - slack && p.x <= line.x + line.w + slack;
  });
}

/**
 * What a press reaches (ARR-01). `resolveHit` picks an object for selection or moving; `inside`
 * identifies editable text or a child reached directly. Text boxes open on press; other children
 * are entered on release when the press did not become a drag:
 *
 * - On the text of a text box or of a shape, straight into editing it.
 *   It is where the text is that counts. The text is the element `chain` ends in, the topmost
 *   one under the pointer, unless that one is locked or hidden. The empty part of a big shape,
 *   or of a text box, is no text: a press there takes the element, to select and move it.
 * - On an object lying on a card, straight to that object. The card's background stays the card.
 * - On a group that was the whole selection before the press, to the child under the pointer, one
 *   level in: a second click on a group does what a double-click on it does.
 *
 * `selected` is the selection before the press; `onText` says whether the pointer is on the text
 * of a text box or a shape, which only the drawing knows.
 */
export function resolvePress(
  chain: readonly string[],
  scope: readonly string[],
  index: ReadonlyMap<string, Located>,
  selected: readonly string[],
  onText: (shape: Located) => boolean,
): Press {
  const hit = resolveHit(chain, scope);
  const target = hit.id ? index.get(hit.id) : undefined;
  // A locked element is not taken by a press at all.
  if (!target || target.locked) return hit;
  const top = index.get(chain[chain.length - 1] ?? '');
  if (top && !top.locked && !top.hidden && holdsText(top, onText)) {
    return { ...hit, inside: { scope: pathIds(top), id: top.element.id, edit: true } };
  }
  // The foreground objects of a card have the same direct hover and click as its text. The
  // press still takes the group at the current depth, so dragging one moves the group.
  const card = top?.path.findLast((group) => cardBox(group));
  if (top && card && top.element.id !== cardBox(card)?.id && !top.locked && !top.hidden) {
    return { ...hit, inside: { scope: pathIds(top), id: top.element.id, edit: false } };
  }
  // Outside a card, a second click on a selected group still enters one level at a time.
  if (target.element.type !== 'group') return hit;
  const depth = hit.scope.length + 1;
  const child = index.get(chain[depth] ?? '');
  const alone = selected.length === 1 && selected[0] === target.element.id;
  if (alone && child && !child.locked) {
    return { ...hit, inside: { scope: chain.slice(0, depth), id: child.element.id, edit: false } };
  }
  return hit;
}

/** The longest start of `scope` that is still a chain of nested groups on the slide. */
export function validScope(
  scope: readonly string[],
  index: ReadonlyMap<string, Located>,
): string[] {
  const out: string[] = [];
  for (const id of scope) {
    const located = index.get(id);
    if (!located || located.element.type !== 'group') break;
    if (pathIds(located).join('/') !== out.join('/')) break;
    out.push(id);
  }
  return out;
}

/** The CSS transform that puts a box drawn at the Stage's corner where the map says, at a zoom. */
export function screenTransform(m: Matrix, origin: Point, scale: number): string {
  const n = (v: number) => Math.round(v * 1e6) / 1e6;
  return `matrix(${n(m.a)}, ${n(m.b)}, ${n(m.c)}, ${n(m.d)}, ${n(origin.x + m.e * scale)}, ${n(origin.y + m.f * scale)})`;
}

/** Rounds away floating-point noise without moving anything a user could see. */
export function tidy(value: number): number {
  // Adding 0 turns -0 into 0.
  return Math.round(value * 1000) / 1000 + 0;
}

export function tidyFrame(frame: Frame): Frame {
  return { x: tidy(frame.x), y: tidy(frame.y), w: tidy(frame.w), h: tidy(frame.h) };
}
