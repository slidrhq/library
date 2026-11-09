import {
  SLIDE_HEIGHT,
  SLIDE_WIDTH,
  type Element,
  type Frame,
  type Layout,
  type Placeholder,
} from '@slidr/model';
import { pointsAcross, type Points } from './pointsAcross';
import type { Template } from './template';

/**
 * The layouts a template's own title over content is read from, plainest content first: the
 * standard layouts put their title where the template's content slides put theirs.
 */
const SOURCES: readonly Layout['archetype'][] = [
  'table',
  'chart',
  'comparison',
  'cards',
  'timeline',
  'process',
  'team',
  'bigNumber',
  'textImage',
];

/** How far above the foot the body of the text layout stops. */
const FOOT_GAP = 40;

/** How far above the top of the foot its rule may stand and still be part of it. */
const FOOT_ZONE = 24;

/**
 * The simple text layout every template offers, including older personal templates. A template
 * that draws its own keeps them; for one that does not they are made from its content slides:
 * the title on one line where their title stands, and the ground, the frame and the foot (rule,
 * mark, slide number) those slides have, with the kicker over their title and their footer. Under
 * the title, the points of the text-and-image slide across the width, with what it draws with
 * them (ADR-136); three plain ones for a template without that slide.
 */
export function withStandardLayouts(template: Template): Template {
  template = withoutTitleLayout(template);
  const layouts = [...template.layouts];
  const source = SOURCES.map((archetype) =>
    layouts.find(
      (layout) =>
        layout.archetype === archetype && layout.placeholders.some((p) => p.role === 'title'),
    ),
  ).find((layout) => layout !== undefined);
  const seat = source?.placeholders.find((place) => place.role === 'title');
  const styles = layouts.find((layout) => layout.archetype === 'textImage');
  const titleStyle =
    styles?.placeholders.find((place) => place.role === 'title')?.styleRef ??
    seat?.styleRef ??
    'title';
  const bodyStyle = styles?.placeholders.find((place) => place.role === 'body')?.styleRef ?? 'body';
  const headingStyle =
    styles?.placeholders.find((place) => place.role === 'subtitle')?.styleRef ?? 'heading';

  // One line of the title, where the source's title sets its first line (or its last, when the
  // title grows upwards from a line), across the width between the margins of that title.
  const look = template.theme.textStyles[titleStyle];
  const line = Math.ceil(look ? look.size * look.lineHeight : 90);
  const box = seat?.frame;
  const margin = box ? (template.dir === 'rtl' ? SLIDE_WIDTH - box.x - box.w : box.x) : 96;
  const spare = box ? Math.max(box.h - line, 0) : 0;
  const top =
    (box?.y ?? 96) +
    (seat?.vAlign === 'bottom' ? spare : seat?.vAlign === 'middle' ? Math.round(spare / 2) : 0);
  const titleFrame: Frame = { x: margin, y: top, w: SLIDE_WIDTH - 2 * margin, h: line };

  // The foot: what the source draws from its footer, or from its mark and number, downwards.
  const foot = source ? footTop(source) : undefined;
  // The head and the foot the text-and-image slide seats too (ROLE_CONTRACT): the kicker that
  // stands over the source's title, the nearest above it, and the footer of its foot.
  const kicker = source?.placeholders
    .filter(
      (place) =>
        place.role === 'caption' && box !== undefined && place.frame.y + place.frame.h <= box.y + 4,
    )
    .sort((a, b) => b.frame.y - a.frame.y)[0];
  const footer = source?.placeholders.find((place) => place.role === 'footer');
  const seated = (place: Placeholder | undefined, id: string): Placeholder[] =>
    place ? [{ ...(JSON.parse(JSON.stringify(place)) as Placeholder), id }] : [];
  const bodyTop = top + line + Math.round(line * 0.6);
  const bodyBottom = Math.max((foot ?? SLIDE_HEIGHT - 140) - FOOT_GAP, bodyTop + line);

  const taken = new Set(layouts.map((layout) => layout.id));
  const id = (archetype: 'title' | 'text'): string => {
    const base = `l_${template.theme.id}_${archetype}`;
    let candidate = base;
    let index = 2;
    while (taken.has(candidate)) candidate = `${base}_${index++}`;
    taken.add(candidate);
    return candidate;
  };
  // What the source draws around its content, and not the content: a frame around the whole
  // slide, what stands over its title (a rule, a dot before the line over it), and its foot.
  const around = (decoration: Element): boolean => {
    const { x, y, w, h } = decoration.frame;
    const whole = x <= 48 && y <= 48 && x + w >= SLIDE_WIDTH - 48 && y + h >= SLIDE_HEIGHT - 48;
    const over = box !== undefined && y + h <= box.y;
    const under = foot !== undefined && y >= foot - FOOT_ZONE;
    return whole || over || under;
  };
  const drawn = (
    archetype: 'title' | 'text',
  ): Pick<Layout, 'background' | 'decorations' | 'objects'> => ({
    ...(source?.background ? { background: source.background } : {}),
    decorations: (source?.decorations ?? [])
      .filter(around)
      .map((decoration) => renamed(decoration, archetype)),
    ...(source?.objects
      ? { objects: source.objects.filter(around).map((object) => renamed(object, archetype)) }
      : {}),
  });
  const title = (): Placeholder => ({
    id: 'p_title',
    role: 'title',
    frame: { ...titleFrame },
    styleRef: titleStyle,
    align: 'start',
    // A title that grows upwards from its line in the template keeps doing so here.
    vAlign: seat?.vAlign === 'bottom' ? 'bottom' : 'top',
  });
  if (!layouts.some((layout) => layout.archetype === 'text')) {
    const beforeImage = layouts.findIndex((layout) => layout.archetype === 'textImage');
    const rename = (old: string) => `${old}_text`;
    const measured = styles ? pointsAcross(styles, { rename }) : undefined;
    const points: Points =
      styles && measured && measured.placeholders.length > 0
        ? pointsAcross(styles, {
            rename,
            // Right under the title, and never into the foot.
            rise: Math.min(bodyTop - measured.top, bodyBottom - measured.bottom),
          })
        : plainPoints(
            { x: margin, y: bodyTop, w: SLIDE_WIDTH - 2 * margin, h: bodyBottom - bodyTop },
            template.theme.textStyles[headingStyle],
            headingStyle,
            bodyStyle,
          );
    const kept = drawn('text');
    const objects = [...(kept.objects ?? []), ...points.objects];
    layouts.splice(beforeImage < 0 ? layouts.length : beforeImage, 0, {
      id: id('text'),
      name: 'Text',
      archetype: 'text',
      placeholders: [
        ...seated(kicker, 'p_kicker'),
        title(),
        ...points.placeholders,
        ...seated(footer, 'p_footer'),
      ],
      ...kept,
      decorations: [...kept.decorations, ...points.decorations],
      ...(objects.length > 0 ? { objects } : {}),
    });
  }
  const textIndex = layouts.findIndex((layout) => layout.archetype === 'text');
  const imageIndex = layouts.findIndex((layout) => layout.archetype === 'textImage');
  if (textIndex >= 0 && imageIndex >= 0 && textIndex !== imageIndex - 1) {
    const [textLayout] = layouts.splice(textIndex, 1);
    layouts.splice(
      layouts.findIndex((layout) => layout.archetype === 'textImage'),
      0,
      textLayout!,
    );
  }
  return { ...template, layouts };
}

/** Three points one under the other in a box, for a template without a text-and-image slide. */
function plainPoints(
  box: Frame,
  look: { size: number; lineHeight: number } | undefined,
  headingStyle: Placeholder['styleRef'],
  bodyStyle: Placeholder['styleRef'],
): Points {
  const row = Math.floor(box.h / 3);
  const heading = Math.ceil(look ? look.size * look.lineHeight : 52);
  const gap = Math.round(heading / 4);
  const placeholders = [0, 1, 2].flatMap((i): Placeholder[] => [
    {
      id: `p_point${i + 1}`,
      role: 'subtitle',
      frame: { x: box.x, y: box.y + i * row, w: box.w, h: heading },
      styleRef: headingStyle,
      align: 'start',
      vAlign: 'top',
    },
    {
      id: `p_detail${i + 1}`,
      role: 'body',
      frame: {
        x: box.x,
        y: box.y + i * row + heading + gap,
        w: box.w,
        h: Math.max(row - heading - 3 * gap, heading),
      },
      styleRef: bodyStyle,
      align: 'start',
      vAlign: 'top',
    },
  ]);
  return { placeholders, decorations: [], objects: [], top: box.y, bottom: box.y + box.h };
}

/**
 * The top of a layout's foot: its footer, or else the mark and the slide number it draws in the
 * lower half of the slide. Undefined for a layout without a foot.
 */
function footTop(layout: Layout): number | undefined {
  const footer = layout.placeholders.find((place) => place.role === 'footer')?.frame.y;
  if (footer !== undefined) return footer;
  const masters = layout.decorations
    .filter((d) => (d.role === 'logo' || d.role === 'slideNumber') && d.frame.y > SLIDE_HEIGHT / 2)
    .map((d) => d.frame.y);
  return masters.length > 0 ? Math.min(...masters) : undefined;
}

/** A decoration of another layout, under an id of its own in a standard layout. */
function renamed(decoration: Element, archetype: 'title' | 'text'): Element {
  const id = (old: string) => `${old}_${archetype}`;
  if (decoration.type !== 'group') return { ...decoration, id: id(decoration.id) };
  return {
    ...decoration,
    id: id(decoration.id),
    children: decoration.children.map((child) => renamed(child, archetype)),
  };
}

/** Remove the retired title-only choice and its previews in both directions. */
export function withoutTitleLayout(template: Template): Template {
  const removed = new Set(
    template.layouts.filter((layout) => layout.archetype === 'title').map((layout) => layout.id),
  );
  return {
    ...template,
    layouts: template.layouts.filter((layout) => !removed.has(layout.id)),
    ...(template.flipped
      ? { flipped: template.flipped.filter((layout) => !removed.has(layout.id)) }
      : {}),
    ...(template.sample
      ? {
          sample: template.sample.filter(
            (slide) => !slide.layoutId || !removed.has(slide.layoutId),
          ),
        }
      : {}),
  };
}
