import {
  SLIDE_HEIGHT,
  SLIDE_WIDTH,
  type Element,
  type Frame,
  type Layout,
  type Placeholder,
} from '@slidr/model';

/** How far over its first heading and under its last body what is drawn with the points may reach. */
const OVER = 48;
const UNDER = 32;

/** How far before the points' text, toward the picture, what is drawn with them may begin. */
const BEFORE = 80;

/** What stands this near the edge of the slide is the slide's (a crop mark), not the points'. */
const EDGE = 72;

/** What stands this little over the foot (its rule) is the foot's. */
const FOOT_ZONE = 24;

/** The points of a layout, and what it draws with them. */
export interface Points {
  placeholders: Placeholder[];
  decorations: Element[];
  objects: Element[];
  /** Where they begin and end, before they are moved. */
  top: number;
  bottom: number;
}

export interface PointsAcrossOptions {
  /** How far to move them down (up, when negative). */
  rise?: number;
  /** The id of what is drawn with them in the text layout. */
  rename?: (id: string) => string;
}

/**
 * The points of a text-and-image layout across the slide, as the text layout seats them
 * (ADR-136): its headings and their bodies, with what the layout draws with them (their numbers,
 * the rules between them, a thread, a card for each, a panel behind them), moved from the column
 * beside the picture to the width the column's outer margin leaves on both sides. What spans the
 * column spans the slide; what is narrow keeps its place by the side it stands at. The picture,
 * what frames it and what the slide draws everywhere (its ground, its foot) stay behind.
 */
export function pointsAcross(layout: Layout, options: PointsAcrossOptions = {}): Points {
  const { rise = 0, rename = (id: string) => id.replace('text_image', 'text') } = options;
  const points = layout.placeholders.filter((p) => p.role === 'subtitle' || p.role === 'body');
  if (points.length === 0)
    return { placeholders: [], decorations: [], objects: [], top: 0, bottom: 0 };

  // Worked out with the column on the right; a column on the left is mirrored there and back.
  const image = layout.placeholders.find((p) => p.role === 'image');
  const middle = (f: Frame) => f.x + f.w / 2;
  const centre = points.reduce((sum, p) => sum + middle(p.frame), 0) / points.length;
  const onRight = image ? centre > middle(image.frame) : centre > SLIDE_WIDTH / 2;
  const turn = (f: Frame): Frame => (onRight ? f : { ...f, x: SLIDE_WIDTH - f.x - f.w });

  const text = points.map((p) => turn(p.frame));
  const inner = Math.min(...text.map((f) => f.x));
  const top = Math.min(...text.map((f) => f.y));
  const bottom = Math.max(...text.map((f) => f.y + f.h));
  // The foot: the footer, or the mark and the slide number in the lower half.
  const foot = Math.min(
    ...layout.placeholders.filter((p) => p.role === 'footer').map((p) => p.frame.y),
    ...layout.decorations
      .filter(
        (d) => (d.role === 'logo' || d.role === 'slideNumber') && d.frame.y > SLIDE_HEIGHT / 2,
      )
      .map((d) => d.frame.y),
  );
  const withPoints = (element: Element): boolean => {
    if (element.role === 'logo' || element.role === 'slideNumber') return false;
    const f = turn(element.frame);
    const whole = f.w >= SLIDE_WIDTH - 100 && f.h >= SLIDE_HEIGHT - 100;
    const beside = f.y < bottom + UNDER && f.y + f.h > top - OVER && f.y < foot - FOOT_ZONE;
    return !whole && beside && f.x >= inner - BEFORE && middle(f) <= SLIDE_WIDTH - EDGE;
  };
  const decorations = layout.decorations.filter(withPoints);
  const objects = (layout.objects ?? []).filter(withPoints);

  const drawn = [...text, ...[...decorations, ...objects].map((e) => turn(e.frame))];
  const left = Math.min(...drawn.map((f) => f.x));
  const right = Math.max(...drawn.map((f) => f.x + f.w));
  const shift = SLIDE_WIDTH - right - left;
  const half = (left + right) / 2;
  const span = right - left;
  /** The frame across the slide, and how much wider it is. */
  const across = (frame: Frame, canStretch: boolean): [Frame, number] => {
    const f = turn(frame);
    const stretched = canStretch && f.w >= span / 2;
    const moved: Frame = stretched
      ? { ...f, x: f.x + shift, w: f.w - shift }
      : middle(f) >= half
        ? { ...f }
        : { ...f, x: f.x + shift };
    moved.y = f.y + rise;
    return [turn(moved), moved.w / f.w];
  };

  const element = (e: Element): Element => {
    const [frame, wider] = across(e.frame, e.type !== 'group');
    const id = rename(e.id);
    if (e.type === 'group') {
      const dx = frame.x - e.frame.x;
      const dy = frame.y - e.frame.y;
      const moved = (child: Element): Element => ({
        ...child,
        id: rename(child.id),
        frame: { ...child.frame, x: child.frame.x + dx, y: child.frame.y + dy },
        ...(child.type === 'group' ? { children: child.children.map(moved) } : {}),
      });
      return { ...e, id, frame, children: e.children.map(moved) };
    }
    if (e.type === 'line' && wider !== 1) {
      return { ...e, id, frame, points: e.points.map((p) => ({ ...p, x: p.x * wider })) };
    }
    if (e.type === 'svg' && wider !== 1 && !e.stretch && e.markup) {
      // A rule drawn to the column's width is drawn to the slide's.
      return { ...e, id, frame, markup: unfitted(e.markup) };
    }
    return { ...e, id, frame };
  };

  return {
    placeholders: points.map((p) => ({
      ...(JSON.parse(JSON.stringify(p)) as Placeholder),
      frame: across(p.frame, true)[0],
    })),
    decorations: decorations.map(element),
    objects: objects.map(element),
    top,
    bottom,
  };
}

/** Svg markup that fills its box whatever its shape, as a rule widened with its box should. */
function unfitted(markup: string): string {
  return /<svg\b[^>]*\bpreserveAspectRatio=/.test(markup)
    ? markup
    : markup.replace(/<svg\b/, '<svg preserveAspectRatio="none"');
}
