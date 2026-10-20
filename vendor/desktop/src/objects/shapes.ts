import { readMediaJson } from '@slidr/media-library';
import {
  createElement,
  type Direction,
  type Frame,
  type LineElement,
  type ShapeElement,
} from '@slidr/model';
import { extraShapes, presetPath, shapePresets } from '@slidr/renderer';

/*
 * The shape library (SHP-01) and the lines of the Insert menu (SHP-05): what each one is called,
 * where it sits in the library, and the element a click inserts. Pure, so it is tested without a
 * DOM. The geometry itself is the renderer's (`presetPath`).
 */

export type ShapeGroup = 'basic' | 'polygons' | 'arrows' | 'callouts' | 'brackets';

interface ShapeSpec {
  group: ShapeGroup;
  /** The size a click inserts, in slide pixels. */
  w: number;
  h: number;
  /** Proportions of the library glyph, when the inserted ones would draw too thin to read. */
  glyph?: readonly [number, number];
}

interface ShapeCatalog {
  groups: ShapeGroup[];
  /** In library order. A preset the renderer adds later shows at the end of `basic` until listed. */
  shapes: Record<string, ShapeSpec>;
  /** The lines of the Insert menu drawn small, in a 24 box, running left to right. */
  lines: Record<LineKind, string>;
}

/** The box of a regular polygon standing on a vertex, so it is inserted with equal sides. */
function regularBox(sides: number, size = 360): { w: number; h: number } {
  const xs: number[] = [];
  const ys: number[] = [];
  for (let i = 0; i < sides; i++) {
    const a = -Math.PI / 2 + (i * 2 * Math.PI) / sides;
    xs.push(Math.cos(a));
    ys.push(Math.sin(a));
  }
  const w = Math.max(...xs) - Math.min(...xs);
  const h = Math.max(...ys) - Math.min(...ys);
  const scale = size / Math.max(w, h);
  return { w: Math.round(w * scale), h: Math.round(h * scale) };
}

const polygon = (sides: number): ShapeSpec => ({ group: 'polygons', ...regularBox(sides) });

/**
 * The library as the app knew it before it became a file of the media library: what the shapes
 * and lines are when that file cannot be read. The shapes are the renderer's, so without the
 * file they still draw, and the Insert menu still offers them.
 */
const BUILT_IN: ShapeCatalog = {
  groups: ['basic', 'polygons', 'arrows', 'callouts', 'brackets'],
  shapes: {
    rect: { group: 'basic', w: 480, h: 320 },
    roundRect: { group: 'basic', w: 480, h: 320 },
    ellipse: { group: 'basic', w: 360, h: 360 },
    triangle: { group: 'basic', w: 400, h: 346 },
    rightTriangle: { group: 'basic', w: 400, h: 320 },
    diamond: { group: 'basic', w: 360, h: 360 },
    parallelogram: { group: 'basic', w: 480, h: 300 },
    trapezoid: { group: 'basic', w: 480, h: 300 },
    plus: { group: 'basic', w: 320, h: 320 },
    donut: { group: 'basic', w: 360, h: 360 },
    frame: { group: 'basic', w: 480, h: 360 },
    heart: { group: 'basic', w: 360, h: 330 },
    pentagon: polygon(5),
    hexagon: polygon(6),
    heptagon: polygon(7),
    octagon: polygon(8),
    decagon: polygon(10),
    star4: polygon(4),
    star5: polygon(5),
    star6: polygon(6),
    star8: polygon(8),
    star12: polygon(12),
    arrowRight: { group: 'arrows', w: 480, h: 240 },
    arrowLeft: { group: 'arrows', w: 480, h: 240 },
    arrowUp: { group: 'arrows', w: 240, h: 480 },
    arrowDown: { group: 'arrows', w: 240, h: 480 },
    arrowLeftRight: { group: 'arrows', w: 560, h: 240 },
    chevron: { group: 'arrows', w: 400, h: 280 },
    homePlate: { group: 'arrows', w: 480, h: 240 },
    wedgeRectCallout: { group: 'callouts', w: 480, h: 280 },
    wedgeRoundRectCallout: { group: 'callouts', w: 480, h: 280 },
    leftBracket: { group: 'brackets', w: 80, h: 400, glyph: [7, 18] },
    rightBracket: { group: 'brackets', w: 80, h: 400, glyph: [7, 18] },
    leftBrace: { group: 'brackets', w: 100, h: 400, glyph: [9, 18] },
    rightBrace: { group: 'brackets', w: 100, h: 400, glyph: [9, 18] },
  },
  lines: {
    line: 'M4 12H20',
    arrow: 'M4 12H20M14 6l6 6-6 6',
    doubleArrow: 'M4 12H20M14 6l6 6-6 6M10 6l-6 6 6 6',
    elbow: 'M4 6H12V18H20',
    curved: 'M4 6C12 6 12 18 20 18',
  },
};

const isRecord = (value: unknown): value is Record<string, never> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** The library authored in the media library (`elements/catalogs/shapes.json`), part by part. */
const authored = await readMediaJson<Partial<ShapeCatalog>>('elements/catalogs/shapes.json');
const library: ShapeCatalog = {
  groups:
    Array.isArray(authored?.groups) && authored.groups.length > 0
      ? authored.groups
      : BUILT_IN.groups,
  shapes: isRecord(authored?.shapes) ? authored.shapes : BUILT_IN.shapes,
  lines: isRecord(authored?.lines) ? authored.lines : BUILT_IN.lines,
};
export const SHAPE_GROUPS: readonly ShapeGroup[] = library.groups;
const CATALOGUE = library.shapes;

const UNLISTED: ShapeSpec = { group: 'basic', w: 360, h: 360 };

function specOf(preset: string): ShapeSpec {
  return CATALOGUE[preset] ?? extraShapes[preset] ?? UNLISTED;
}

/** Every preset the renderer draws, by library group and in library order. */
export function shapeLibrary(
  presets: readonly string[] = shapePresets,
): { group: ShapeGroup; presets: string[] }[] {
  const listed = Object.keys(CATALOGUE).filter((preset) => presets.includes(preset));
  const all = [...listed, ...presets.filter((preset) => !(preset in CATALOGUE))];
  return SHAPE_GROUPS.map((group) => ({
    group,
    presets: all.filter((preset) => specOf(preset).group === group),
  })).filter((entry) => entry.presets.length > 0);
}

/** Brackets and braces: an outline with nothing to fill. */
export function isOpenPreset(preset: string): boolean {
  return presetPath(preset, 100, 100)?.closed === false;
}

/** The side of the square a library glyph is drawn in, and the part of it the shape may take. */
export const GLYPH_BOX = 24;
const GLYPH_INK = 18;
/** A speech bubble's tail hangs this far below its frame, as a share of the height. */
const CALLOUT_TAIL = 0.25;

/** A preset drawn small for the library: path data, and where it sits in the glyph box. */
export function shapeGlyph(
  preset: string,
): { d: string; closed: boolean; x: number; y: number } | undefined {
  const spec = specOf(preset);
  const [gw, gh] = spec.glyph ?? [spec.w, spec.h];
  const tall = spec.group === 'callouts' ? 1 + CALLOUT_TAIL : 1;
  const scale = Math.min(GLYPH_INK / gw, GLYPH_INK / (gh * tall));
  const w = gw * scale;
  const h = gh * scale;
  const path = presetPath(preset, w, h);
  if (!path) return undefined;
  return { ...path, x: (GLYPH_BOX - w) / 2, y: (GLYPH_BOX - h * tall) / 2 };
}

/* ---------------------------------------------------------------- inserting */

interface Size {
  w: number;
  h: number;
}

/** How far a new element steps aside when one already sits where it would land. */
const CASCADE = 24;
/** Outline of a new open shape and of a new line: readable on a 1920 slide at 64%. */
const STROKE_WIDTH = 4;

/**
 * A frame of the given size in the middle of the slide. When an element already starts at that
 * very spot (a shape was just inserted and not moved), the new one steps aside so both show.
 */
export function centredFrame(size: Size, slide: Size, taken: readonly Frame[] = []): Frame {
  let x = Math.round((slide.w - size.w) / 2);
  let y = Math.round((slide.h - size.h) / 2);
  for (let step = 0; step < 12 && taken.some((f) => f.x === x && f.y === y); step++) {
    x += CASCADE;
    y += CASCADE;
  }
  return { x, y, w: size.w, h: size.h };
}

/**
 * A new shape of the library, in the theme's colours: filled with `primary`, or for an open
 * outline (a bracket) stroked with `text`. Colours are tokens, so the shape follows the theme.
 */
export function newShape(preset: string, slide: Size, taken: readonly Frame[] = []): ShapeElement {
  const spec = specOf(preset);
  const frame = centredFrame(spec, slide, taken);
  const geometry = { kind: 'preset', preset } as const;
  if (isOpenPreset(preset)) {
    return createElement.shape({
      frame,
      geometry,
      fill: { kind: 'none' },
      stroke: { color: { token: 'text' }, width: STROKE_WIDTH },
    });
  }
  return createElement.shape({
    frame,
    geometry,
    fill: { kind: 'solid', color: { token: 'primary' } },
  });
}

export type LineKind = 'line' | 'arrow' | 'doubleArrow' | 'elbow' | 'curved';

export const LINE_KINDS: readonly LineKind[] = Object.keys(library.lines) as LineKind[];

/**
 * A new line. It runs in the reading direction of the deck, so an arrow points forward: to the
 * left in a right-to-left deck. Elbow and curved lines start plain; heads are one click away.
 */
export function newLine(
  kind: LineKind,
  slide: Size,
  taken: readonly Frame[] = [],
  dir: Direction = 'ltr',
): LineElement {
  const bent = kind === 'elbow' || kind === 'curved';
  const size = bent ? { w: 360, h: 240 } : { w: 480, h: 0 };
  const rtl = dir === 'rtl';
  return createElement.line({
    frame: centredFrame(size, slide, taken),
    points: [
      { x: rtl ? size.w : 0, y: 0 },
      { x: rtl ? 0 : size.w, y: size.h },
    ],
    stroke: { color: { token: 'text' }, width: STROKE_WIDTH },
    startHead: kind === 'doubleArrow' ? 'triangle' : 'none',
    endHead: kind === 'arrow' || kind === 'doubleArrow' ? 'triangle' : 'none',
    curve: kind === 'elbow' ? 'elbow' : kind === 'curved' ? 'curved' : 'straight',
  });
}

/** The lines of the Insert menu drawn small, in a 24 box, running left to right. */
export const LINE_GLYPHS: Record<LineKind, string> = library.lines;
