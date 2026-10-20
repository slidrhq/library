import {
  artworkLayout,
  frameLayout,
  normalizeAngle,
  placedAround,
  refitAll,
  rotatedBounds,
  rotateVector,
  svgStretchLayout,
  textBackground,
  type Artwork,
  type Element,
  type Frame,
  type GroupElement,
  type PlacementPatch,
  type Point,
} from '@slidr/model';
import { framedPicture, freshFrame, freshTextBackground, magnetCard } from '../elements/frames';
import { fitLine, linePoints } from './line';
import { tidy, tidyFrame } from './space';

/*
 * What a gesture of the Stage does to several elements at once: stretching a group with what is
 * in it, stretching several elements together, turning them together. Keeping a group's frame
 * around its children (ARR-01) is the model's (`@slidr/model`, `compose/refit.ts`), where every
 * other way of changing an element can reach it too; it is passed on from here for the Stage.
 */
export { refitAll, refitGroups, refitPatches, type Placement } from '@slidr/model';

/** What `element.update` takes; `frame` and `rotation` are what a refit reads and writes. */
export type Patch = PlacementPatch;

/** An element with a patch of `element.update` applied: `null` takes a field away. */
function patched<T extends Element>(element: T, patch: Patch | undefined): T {
  if (!patch) return element;
  const next: Record<string, unknown> = { ...element };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete next[key];
    else next[key] = value;
  }
  return next as T;
}

/**
 * An element as it is when it is resized. A picture in artwork of an earlier catalogue of
 * frames, or the group such a frame made, first takes the artwork its frame has now
 * (`freshFrame`): the old was stretched with the picture, and this keeps its size. What that
 * changes goes out with the patches of the resize, as one step with it.
 */
function current<T extends Element>(element: T, out: Map<string, Patch>): T {
  const fresh = new Map<string, Patch>();
  for (const changes of [freshFrame(element), freshTextBackground(element)]) {
    for (const [id, patch] of changes ?? []) fresh.set(id, { ...fresh.get(id), ...patch });
  }
  if (!fresh.size) return element;
  for (const [id, patch] of fresh) out.set(id, { ...out.get(id), ...patch });
  const tree = <E extends Element>(one: E): E => {
    const next = patched(one, fresh.get(one.id));
    return next.type === 'group' ? { ...next, children: next.children.map(tree) } : next;
  };
  return tree(element);
}

/**
 * An element stretched with the group it is in, by `kx` and `ky` along the group's axes. A line
 * takes it point by point, which is exact. A box that is turned inside the group cannot shear, so
 * it is sized by how far each of its own axes stretches. Text keeps its size: only its box changes.
 */
function scaleElement(
  was: Element,
  kx: number,
  ky: number,
  out: Map<string, Patch>,
  artworkRatio = 1,
): Element {
  const element = current(was, out);
  if (element.type === 'line') {
    const fitted = fitLine(
      element,
      linePoints(element).map((p) => ({ x: p.x * kx, y: p.y * ky })),
    );
    out.set(element.id, fitted);
    return { ...element, ...fitted };
  }
  const { frame } = element;
  const along = rotateVector({ x: 1, y: 0 }, element.rotation);
  const w = frame.w * Math.hypot(kx * along.x, ky * along.y);
  const h = frame.h * Math.hypot(kx * along.y, ky * along.x);
  const next = tidyFrame({
    x: (frame.x + frame.w / 2) * kx - w / 2,
    y: (frame.y + frame.h / 2) * ky - h / 2,
    w,
    h,
  });
  const artwork =
    element.type === 'svg' && element.stretch && artworkRatio !== 1
      ? { stretch: { ...element.stretch, scale: element.stretch.scale * artworkRatio } }
      : {};
  out.set(element.id, { ...out.get(element.id), frame: next, ...artwork });
  if (element.type !== 'group') return { ...element, frame: next, ...artwork };
  const ix = frame.w > 0 ? w / frame.w : 1;
  const iy = frame.h > 0 ? h / frame.h : 1;
  return { ...element, frame: next, children: scaleChildren(element, ix, iy, out, artworkRatio) };
}

/** The plate grows along its strips. Text follows the same geometry and retains its font. */
function scaleLabel(
  group: GroupElement,
  kx: number,
  ky: number,
  out: Map<string, Patch>,
  artworkRatio: number,
): Element[] {
  const plate = textBackground(group)!;
  const grown = scaleElement(plate, kx, ky, out, artworkRatio);
  if (grown.type !== 'svg' || !grown.stretch) return group.children;
  const before = svgStretchLayout(plate.stretch, plate.frame);
  const after = svgStretchLayout(grown.stretch, grown.frame);
  const axis = (value: number, key: 'x' | 'y') => {
    const side = key === 'x' ? 'w' : 'h';
    const flip = key === 'x' ? plate.flipH : plate.flipV;
    const relative = value - plate.frame[key];
    const mapped = after[key].map(
      before[key].unmap(flip ? plate.frame[side] - relative : relative),
    );
    return grown.frame[key] + (flip ? grown.frame[side] - mapped : mapped);
  };
  return group.children.map((child) => {
    if (child.id === plate.id) return grown;
    if (child.type !== 'text') return scaleElement(child, kx, ky, out, artworkRatio);
    const { frame } = child;
    const next = tidyFrame({
      x: axis(frame.x, 'x'),
      y: axis(frame.y, 'y'),
      w: Math.max(1, axis(frame.x + frame.w, 'x') - axis(frame.x, 'x')),
      h: Math.max(1, axis(frame.y + frame.h, 'y') - axis(frame.y, 'y')),
    });
    out.set(child.id, { ...out.get(child.id), frame: next });
    return { ...child, frame: next };
  });
}

/**
 * Where a place beside a framed picture goes when the picture changes from one stretch of an
 * axis to another (`[start, length]`), and its artwork is drawn `ratio` times as large as it
 * was. In the first third of the picture a place keeps its distance from the picture's start,
 * in the last third from its end, and in between its place between the two: a sticker on a
 * corner stays on that corner, and what is in the middle stays in the middle.
 */
function besideAt(
  at: number,
  [from, length]: [number, number],
  [start, grown]: [number, number],
  ratio: number,
): number {
  const u = at - from;
  const third = length / 3;
  const near = start + third * ratio;
  const far = Math.max(near, start + grown - third * ratio);
  if (u <= third) return start + u * ratio;
  if (u >= 2 * third) return start + grown - (length - u) * ratio;
  return near + ((u - third) / third) * (far - near);
}

/** An element moved by a distance, with what is in it: a line by its points. */
function shifted(element: Element, dx: number, dy: number, out: Map<string, Patch>): Element {
  if (element.type === 'line') {
    const fitted = fitLine(
      element,
      linePoints(element).map((p) => ({ x: p.x + dx, y: p.y + dy })),
    );
    out.set(element.id, fitted);
    return { ...element, ...fitted };
  }
  const frame = tidyFrame({ ...element.frame, x: element.frame.x + dx, y: element.frame.y + dy });
  out.set(element.id, { ...out.get(element.id), frame });
  return { ...element, frame };
}

/**
 * Words with their type `ratio` times as large, alone or on a label: what a frame wrote beside
 * its picture, where the artwork of the frame is drawn that much smaller or larger. Their boxes
 * are sized by the same ratio, so the words stay as large on their plate as they were.
 */
function typeSized(element: Element, ratio: number, out: Map<string, Patch>): Element {
  if (element.type === 'group') {
    return { ...element, children: element.children.map((child) => typeSized(child, ratio, out)) };
  }
  if (element.type !== 'text') return element;
  const sized = (value: number) => Math.round(value * ratio * 100) / 100;
  // Type that takes its size from the deck's styles has none of its own to change.
  let own = false;
  const content = {
    paragraphs: element.content.paragraphs.map((paragraph) => ({
      ...paragraph,
      runs: paragraph.runs.map((run) => {
        const { size, letterSpacing } = run.marks ?? {};
        if (size === undefined) return run;
        own = true;
        const spacing = letterSpacing ? { letterSpacing: sized(letterSpacing) } : {};
        return { ...run, marks: { ...run.marks, size: sized(size), ...spacing } };
      }),
    })),
  };
  if (!own) return element;
  out.set(element.id, { ...out.get(element.id), content });
  return { ...element, content };
}

/**
 * What a frame put beside its picture, after the picture went from one box to another.
 * Stickers keep their size and follow their part of the picture (`besideAt`). Text boxes and
 * their flexible plates reach as far as their ends go. Only when the artwork itself changes
 * scale (`ratio`) do the stickers, the fixed parts of plates, and their type change size too.
 */
function besidePicture(
  given: Element,
  from: Frame,
  to: Frame,
  ratio: number,
  out: Map<string, Patch>,
): Element {
  const x = (v: number) => besideAt(v, [from.x, from.w], [to.x, to.w], ratio);
  const y = (v: number) => besideAt(v, [from.y, from.h], [to.y, to.h], ratio);
  const now = current(given, out);
  const element = ratio === 1 ? now : typeSized(now, ratio, out);
  const { frame } = element;
  if (element.type === 'group' && textBackground(element)) {
    // A plate reaches toward the same two parts of the card as its text. Round badges on
    // a corner stay the same size; a banner crossing the middle lengthens with the card.
    const center = { x: frame.x + frame.w / 2, y: frame.y + frame.h / 2 };
    const length = (direction: Point, size: number) => {
      const unit = rotateVector(direction, element.rotation);
      // Use the axis this side lies along. A nearly horizontal sign keeps its height in
      // a wider magnet; a vertical sign instead lengthens when the magnet grows taller.
      const axis = Math.abs(unit.x) >= Math.abs(unit.y) ? 'x' : 'y';
      const map = axis === 'x' ? x : y;
      const half = (unit[axis] * size) / 2;
      return Math.max(1, (map(center[axis] + half) - map(center[axis] - half)) / unit[axis]);
    };
    const next = tidyFrame({
      x: x(frame.x),
      y: y(frame.y),
      w: length({ x: 1, y: 0 }, frame.w),
      h: length({ x: 0, y: 1 }, frame.h),
    });
    // A tilted sign must stay inside the card too. Pin the rotated bounds to the side it
    // stood at, so lengthening it does not push a corner past the magnet's edge.
    const was = rotatedBounds(frame, element.rotation);
    const is = rotatedBounds(next, element.rotation);
    const anchor = (
      start: number,
      length: number,
      a: number,
      n: number,
      b: number,
      m: number,
      map: (v: number) => number,
    ) => {
      const middle = a + n / 2;
      if (middle <= start + length / 3) return map(a) - b;
      if (middle >= start + (2 * length) / 3) return map(a + n) - b - m;
      return (map(a) + map(a + n) - m) / 2 - b;
    };
    next.x = tidy(next.x + anchor(from.x, from.w, was.x, was.w, is.x, is.w, x));
    next.y = tidy(next.y + anchor(from.y, from.h, was.y, was.h, is.y, is.h, y));
    const children = scaleLabel(element, next.w / frame.w, next.h / frame.h, out, ratio);
    out.set(element.id, { ...out.get(element.id), frame: next });
    return { ...element, frame: next, children };
  }
  if (element.type === 'text' && element.rotation === 0) {
    const next = tidyFrame({
      x: x(frame.x),
      y: y(frame.y),
      w: Math.max(1, x(frame.x + frame.w) - x(frame.x)),
      h: Math.max(1, y(frame.y + frame.h) - y(frame.y)),
    });
    out.set(element.id, { ...out.get(element.id), frame: next });
    return { ...element, frame: next };
  }
  const sized = ratio === 1 ? element : scaleElement(element, ratio, ratio, out, ratio);
  const middle = (f: Frame) => ({ x: f.x + f.w / 2, y: f.y + f.h / 2 });
  const [was, is] = [middle(frame), middle(sized.frame)];
  return shifted(sized, x(was.x) - is.x, y(was.y) - is.y, out);
}

/**
 * The children of a magnet whose card is an element of its own (ADR-095), stretched by `kx` and
 * `ky`. The card takes the stretch and keeps its artwork's size; the photograph goes with the
 * opening as a part of the artwork does (`placedAround`): one that fills it grows with it. What
 * stands beside them follows its part of the card (`besidePicture`).
 */
function aroundCard(
  group: GroupElement,
  card: Element,
  art: Artwork,
  kx: number,
  ky: number,
  out: Map<string, Patch>,
): Element[] {
  const grown = scaleElement(card, kx, ky, out);
  const was = artworkLayout(art, card.frame);
  const now = artworkLayout(art, grown.frame);
  const drawn = now.scale / was.scale;
  const ratio = Math.abs(drawn - 1) < 1e-6 ? 1 : drawn;
  const photo = framedPicture(group);
  return group.children.map((child) => {
    if (child.id === card.id) return grown;
    if (child.id !== photo?.id || photo.mask?.kind !== 'window' || photo.rotation !== 0) {
      return besidePicture(child, card.frame, grown.frame, ratio, out);
    }
    const { opening: o } = photo.mask;
    const opening = {
      ...o,
      w: o.w + was.box.w - art.viewBox.w,
      h: o.h + was.box.h - art.viewBox.h,
    };
    const { frame: f } = photo;
    const placed = placedAround(
      opening,
      {
        x: (f.x - card.frame.x) / was.scale,
        y: (f.y - card.frame.y) / was.scale,
        w: f.w / was.scale,
        h: f.h / was.scale,
      },
      { w: now.box.w - was.box.w, h: now.box.h - was.box.h },
    );
    const frame = tidyFrame({
      x: grown.frame.x + placed.x * now.scale,
      y: grown.frame.y + placed.y * now.scale,
      w: placed.w * now.scale,
      h: placed.h * now.scale,
    });
    out.set(photo.id, { ...out.get(photo.id), frame });
    return { ...photo, frame };
  });
}

/**
 * The children of a group stretched by `kx` and `ky`. A label uses its plate's flexible bands
 * for both its drawing and its text boxes. In a framed picture the artwork and stickers keep
 * their size, the photograph fills the opening, and text backgrounds lengthen with the frame.
 * Legacy artwork without a scale follows the ordinary group resize.
 */
function scaleChildren(
  group: GroupElement,
  kx: number,
  ky: number,
  out: Map<string, Patch>,
  artworkRatio = 1,
): Element[] {
  if (textBackground(group)) return scaleLabel(group, kx, ky, out, artworkRatio);
  const picture = framedPicture(group);
  const card = magnetCard(group);
  if (card?.layout && card.rotation === 0) return aroundCard(group, card, card.layout, kx, ky, out);
  const design = picture?.smartFrame;
  if (!picture || design?.scale === undefined || picture.rotation !== 0) {
    return group.children.map((child) => scaleElement(child, kx, ky, out, artworkRatio));
  }
  const grown = scaleElement(picture, kx, ky, out);
  const drawn =
    frameLayout(design, grown.frame).scale.x / frameLayout(design, picture.frame).scale.x;
  const ratio = Math.abs(drawn - 1) < 1e-6 ? 1 : drawn;
  return group.children.map((child) =>
    child.id === picture.id ? grown : besidePicture(child, picture.frame, grown.frame, ratio, out),
  );
}

/**
 * The patches that give a group a new frame: everything in it, at any depth, is stretched along.
 * Where turned children do not come to an exact fit, the groups take the box their children end
 * up in.
 */
export function resizeGroup(was: GroupElement, frame: Frame): Map<string, Patch> {
  const out = new Map<string, Patch>();
  const group = current(was, out);
  const kx = group.frame.w > 0 ? frame.w / group.frame.w : 1;
  const ky = group.frame.h > 0 ? frame.h / group.frame.h : 1;
  const children = scaleChildren(group, kx, ky, out);
  out.set(group.id, { ...out.get(group.id), frame });
  for (const [id, placement] of refitAll([{ ...group, frame, children }])) {
    out.set(id, { ...out.get(id), ...placement });
  }
  return out;
}

/**
 * The patches that give one element a new frame, with whatever else `own` says of it: a group
 * with what is in it (`resizeGroup`), and a picture in a frame of an earlier catalogue with the
 * artwork that frame has now.
 */
export function resizeOne(element: Element, own: Patch & { frame: Frame }): Map<string, Patch> {
  if (element.type === 'group') return resizeGroup(element, own.frame);
  const out = new Map<string, Patch>();
  current(element, out);
  out.set(element.id, { ...out.get(element.id), ...own });
  return out;
}

/**
 * The patches that resize several elements of one parent together: the box around them goes from
 * `from` to `to` (both in the coordinates their frames are written in), and each element is
 * stretched with it, like the children of a group.
 */
export function resizeTogether(
  elements: readonly Element[],
  from: Frame,
  to: Frame,
): Map<string, Patch> {
  const out = new Map<string, Patch>();
  const kx = from.w > 0 ? to.w / from.w : 1;
  const ky = from.h > 0 ? to.h / from.h : 1;
  // Stretched around the corner of the box, then put where the box is now.
  const scaled = elements.map((element) =>
    scaleElement(
      {
        ...element,
        frame: { ...element.frame, x: element.frame.x - from.x, y: element.frame.y - from.y },
      },
      kx,
      ky,
      out,
    ),
  );
  for (const [id, placement] of refitAll(scaled)) out.set(id, { ...out.get(id), ...placement });
  for (const element of elements) {
    const patch = out.get(element.id);
    if (!patch?.frame) continue;
    out.set(element.id, {
      ...patch,
      frame: tidyFrame({ ...patch.frame, x: patch.frame.x + to.x, y: patch.frame.y + to.y }),
    });
  }
  return out;
}

/**
 * The patches that turn several elements of one parent together by `angle` degrees around
 * `center` (in the coordinates their frames are written in): each one turns by the angle, and
 * its centre travels around the common centre, as if they were a group for the length of the
 * gesture. A group among them turns as one thing, with what is in it.
 */
export function rotateTogether(
  elements: readonly Element[],
  center: Point,
  angle: number,
): Map<string, Patch> {
  const out = new Map<string, Patch>();
  for (const element of elements) {
    const { frame } = element;
    const arm = rotateVector(
      { x: frame.x + frame.w / 2 - center.x, y: frame.y + frame.h / 2 - center.y },
      angle,
    );
    out.set(element.id, {
      frame: tidyFrame({
        ...frame,
        x: center.x + arm.x - frame.w / 2,
        y: center.y + arm.y - frame.h / 2,
      }),
      rotation: tidy(normalizeAngle(element.rotation + angle)),
    });
  }
  return out;
}
