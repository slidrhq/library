import { extraShapes } from './extraShapes';

/**
 * Shape geometry: SVG path data in the element's own pixels (SHP-01). Presets are drawn at the
 * frame's size rather than stretched from a fixed box, so corners, arrow heads and star points
 * keep their proportions when the shape is resized.
 *
 * `adjust` values are fractions, as in other editors' shape handles. Each preset documents its own.
 */

export interface ShapePath {
  d: string;
  /** False for open outlines such as brackets: they have a stroke and no fill. */
  closed: boolean;
}

/** Presets drawn as a CSS box (background + border-radius) instead of a clipped path. */
export type BoxPreset = 'rect' | 'roundRect' | 'ellipse';

export function isBoxPreset(preset: string): preset is BoxPreset {
  return preset === 'rect' || preset === 'roundRect' || preset === 'ellipse';
}

type Pt = readonly [number, number];

const f = (v: number) => String(Math.round(v * 100) / 100);

function polygon(points: readonly Pt[]): string {
  return `${points.map(([x, y], i) => `${i ? 'L' : 'M'}${f(x)} ${f(y)}`).join(' ')} Z`;
}

/** Points on a circle, scaled so their bounding box fills the frame exactly. */
function fitToBox(points: readonly Pt[], w: number, h: number): Pt[] {
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  const sx = w / (Math.max(...xs) - minX || 1);
  const sy = h / (Math.max(...ys) - minY || 1);
  return points.map(([x, y]) => [(x - minX) * sx, (y - minY) * sy]);
}

function regular(sides: number, w: number, h: number): string {
  const pts: Pt[] = [];
  for (let i = 0; i < sides; i++) {
    const a = -Math.PI / 2 + (i * 2 * Math.PI) / sides;
    pts.push([Math.cos(a), Math.sin(a)]);
  }
  return polygon(fitToBox(pts, w, h));
}

function star(points: number, inner: number, w: number, h: number): string {
  const pts: Pt[] = [];
  for (let i = 0; i < points * 2; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / points;
    const r = i % 2 ? inner : 1;
    pts.push([r * Math.cos(a), r * Math.sin(a)]);
  }
  return polygon(fitToBox(pts, w, h));
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** A right-pointing block arrow; the others are this one mirrored or rotated. */
function arrowRight(w: number, h: number, shaft: number, head: number): Pt[] {
  const hl = clamp(head, 0, 1) * Math.min(w, h);
  const t = (clamp(shaft, 0, 1) * h) / 2;
  const cy = h / 2;
  return [
    [0, cy - t],
    [w - hl, cy - t],
    [w - hl, 0],
    [w, cy],
    [w - hl, h],
    [w - hl, cy + t],
    [0, cy + t],
  ];
}

function callout(w: number, h: number, tipX: number, tipY: number, body: 'rect' | 'round'): string {
  const tx = tipX * w;
  const ty = tipY * h;
  const r = body === 'round' ? Math.min(w, h) * 0.1667 : 0;
  // The tail leaves from the edge the tip is beyond, with a base a sixth of that edge wide.
  const below = ty > h;
  const above = ty < 0;
  const side = below ? 'bottom' : above ? 'top' : tx < 0 ? 'left' : 'right';
  const along = side === 'bottom' || side === 'top' ? w : h;
  const base = along / 6;
  const pos =
    side === 'bottom' || side === 'top'
      ? clamp(tx, r + base, w - r - base)
      : clamp(ty, r + base, h - r - base);
  const a = pos - base / 2;
  const b = pos + base / 2;
  const tip = `L${f(tx)} ${f(ty)}`;
  const arc = (x: number, y: number) =>
    r ? `A${f(r)} ${f(r)} 0 0 1 ${f(x)} ${f(y)}` : `L${f(x)} ${f(y)}`;
  return [
    `M${f(r)} 0`,
    side === 'top' ? `L${f(a)} 0 ${tip} L${f(b)} 0` : '',
    `L${f(w - r)} 0`,
    arc(w, r),
    side === 'right' ? `L${f(w)} ${f(a)} ${tip} L${f(w)} ${f(b)}` : '',
    `L${f(w)} ${f(h - r)}`,
    arc(w - r, h),
    side === 'bottom' ? `L${f(b)} ${f(h)} ${tip} L${f(a)} ${f(h)}` : '',
    `L${f(r)} ${f(h)}`,
    arc(0, h - r),
    side === 'left' ? `L0 ${f(b)} ${tip} L0 ${f(a)}` : '',
    `L0 ${f(r)}`,
    arc(r, 0),
    'Z',
  ]
    .filter(Boolean)
    .join(' ');
}

type Generator = (w: number, h: number, adj: readonly number[]) => string | ShapePath;

const a = (adj: readonly number[], i: number, fallback: number) => adj[i] ?? fallback;

/** Every preset. Box presets are listed too, so they can also be used as image masks. */
const PRESETS: Record<string, Generator> = {
  rect: (w, h) =>
    polygon([
      [0, 0],
      [w, 0],
      [w, h],
      [0, h],
    ]),
  /** adjust[0]: corner radius as a fraction of the shorter side, 0..0.5 (default 1/6). */
  roundRect: (w, h, adj) => {
    const r = clamp(a(adj, 0, 0.1667), 0, 0.5) * Math.min(w, h);
    return `M${f(r)} 0 H${f(w - r)} A${f(r)} ${f(r)} 0 0 1 ${f(w)} ${f(r)} V${f(h - r)} A${f(r)} ${f(r)} 0 0 1 ${f(w - r)} ${f(h)} H${f(r)} A${f(r)} ${f(r)} 0 0 1 0 ${f(h - r)} V${f(r)} A${f(r)} ${f(r)} 0 0 1 ${f(r)} 0 Z`;
  },
  ellipse: (w, h) =>
    `M0 ${f(h / 2)} A${f(w / 2)} ${f(h / 2)} 0 1 1 ${f(w)} ${f(h / 2)} A${f(w / 2)} ${f(h / 2)} 0 1 1 0 ${f(h / 2)} Z`,
  /** adjust[0]: where the apex is along the top edge, 0..1 (default 0.5). */
  triangle: (w, h, adj) =>
    polygon([
      [a(adj, 0, 0.5) * w, 0],
      [w, h],
      [0, h],
    ]),
  rightTriangle: (w, h) =>
    polygon([
      [0, 0],
      [w, h],
      [0, h],
    ]),
  diamond: (w, h) =>
    polygon([
      [w / 2, 0],
      [w, h / 2],
      [w / 2, h],
      [0, h / 2],
    ]),
  /** adjust[0]: horizontal slant as a fraction of the width (default 0.25). */
  parallelogram: (w, h, adj) => {
    const s = clamp(a(adj, 0, 0.25), 0, 1) * w;
    return polygon([
      [s, 0],
      [w, 0],
      [w - s, h],
      [0, h],
    ]);
  },
  /** adjust[0]: inset of the top corners as a fraction of the width (default 0.25). */
  trapezoid: (w, h, adj) => {
    const s = clamp(a(adj, 0, 0.25), 0, 0.5) * w;
    return polygon([
      [s, 0],
      [w - s, 0],
      [w, h],
      [0, h],
    ]);
  },
  pentagon: (w, h) => regular(5, w, h),
  hexagon: (w, h) => regular(6, w, h),
  heptagon: (w, h) => regular(7, w, h),
  octagon: (w, h) => regular(8, w, h),
  decagon: (w, h) => regular(10, w, h),
  /** adjust[0] on every star: inner radius as a fraction of the outer one. */
  star4: (w, h, adj) => star(4, a(adj, 0, 0.38), w, h),
  star5: (w, h, adj) => star(5, a(adj, 0, 0.45), w, h),
  star6: (w, h, adj) => star(6, a(adj, 0, 0.55), w, h),
  star8: (w, h, adj) => star(8, a(adj, 0, 0.7), w, h),
  star12: (w, h, adj) => star(12, a(adj, 0, 0.75), w, h),
  /** adjust[0]: arm thickness as a fraction of the shorter side (default 0.3). */
  plus: (w, h, adj) => {
    const t = (clamp(a(adj, 0, 0.3), 0, 1) * Math.min(w, h)) / 2;
    const cx = w / 2;
    const cy = h / 2;
    return polygon([
      [cx - t, 0],
      [cx + t, 0],
      [cx + t, cy - t],
      [w, cy - t],
      [w, cy + t],
      [cx + t, cy + t],
      [cx + t, h],
      [cx - t, h],
      [cx - t, cy + t],
      [0, cy + t],
      [0, cy - t],
      [cx - t, cy - t],
    ]);
  },
  /** Arrows. adjust[0]: shaft thickness as a fraction of the cross size (default 0.5); adjust[1]: head length as a fraction of the shorter side (default 0.5). */
  arrowRight: (w, h, adj) => polygon(arrowRight(w, h, a(adj, 0, 0.5), a(adj, 1, 0.5))),
  arrowLeft: (w, h, adj) =>
    polygon(arrowRight(w, h, a(adj, 0, 0.5), a(adj, 1, 0.5)).map(([x, y]) => [w - x, y])),
  arrowDown: (w, h, adj) =>
    polygon(arrowRight(h, w, a(adj, 0, 0.5), a(adj, 1, 0.5)).map(([x, y]) => [y, x])),
  arrowUp: (w, h, adj) =>
    polygon(arrowRight(h, w, a(adj, 0, 0.5), a(adj, 1, 0.5)).map(([x, y]) => [y, h - x])),
  arrowLeftRight: (w, h, adj) => {
    const hl = clamp(a(adj, 1, 0.5), 0, 1) * Math.min(w / 2, h);
    const t = (clamp(a(adj, 0, 0.5), 0, 1) * h) / 2;
    const cy = h / 2;
    return polygon([
      [0, cy],
      [hl, 0],
      [hl, cy - t],
      [w - hl, cy - t],
      [w - hl, 0],
      [w, cy],
      [w - hl, h],
      [w - hl, cy + t],
      [hl, cy + t],
      [hl, h],
    ]);
  },
  /** adjust[0]: depth of the notch and the point as a fraction of the shorter side (default 0.5). */
  chevron: (w, h, adj) => {
    const d = clamp(a(adj, 0, 0.5), 0, 1) * Math.min(w, h) * 0.5;
    return polygon([
      [0, 0],
      [w - d, 0],
      [w, h / 2],
      [w - d, h],
      [0, h],
      [d, h / 2],
    ]);
  },
  /** A pentagon arrow: adjust[0] as for chevron. */
  homePlate: (w, h, adj) => {
    const d = clamp(a(adj, 0, 0.5), 0, 1) * Math.min(w, h) * 0.5;
    return polygon([
      [0, 0],
      [w - d, 0],
      [w, h / 2],
      [w - d, h],
      [0, h],
    ]);
  },
  /** Speech bubbles. adjust[0], adjust[1]: the tail's tip relative to the frame (default -0.2 .. 1.25: below, near the start). */
  wedgeRectCallout: (w, h, adj) => callout(w, h, a(adj, 0, 0.2), a(adj, 1, 1.25), 'rect'),
  wedgeRoundRectCallout: (w, h, adj) => callout(w, h, a(adj, 0, 0.2), a(adj, 1, 1.25), 'round'),
  /** adjust[0]: ring thickness as a fraction of the shorter side (default 0.25). */
  donut: (w, h, adj) => {
    const t = clamp(a(adj, 0, 0.25), 0, 0.5) * Math.min(w, h);
    const rx = w / 2;
    const ry = h / 2;
    const ix = rx - t;
    const iy = ry - t;
    const outer = `M0 ${f(ry)} A${f(rx)} ${f(ry)} 0 1 1 ${f(w)} ${f(ry)} A${f(rx)} ${f(ry)} 0 1 1 0 ${f(ry)} Z`;
    const inner = `M${f(t)} ${f(ry)} A${f(ix)} ${f(iy)} 0 1 0 ${f(w - t)} ${f(ry)} A${f(ix)} ${f(iy)} 0 1 0 ${f(t)} ${f(ry)} Z`;
    return `${outer} ${inner}`;
  },
  /** adjust[0]: border thickness as a fraction of the shorter side (default 0.12). */
  frame: (w, h, adj) => {
    const t = clamp(a(adj, 0, 0.12), 0, 0.5) * Math.min(w, h);
    return `${polygon([
      [0, 0],
      [w, 0],
      [w, h],
      [0, h],
    ])} ${polygon([
      [t, t],
      [t, h - t],
      [w - t, h - t],
      [w - t, t],
    ])}`;
  },
  heart: (w, h) =>
    `M${f(w / 2)} ${f(h * 0.25)} C${f(w * 0.5)} ${f(h * 0.1)} ${f(w * 0.3)} 0 ${f(w * 0.2)} 0 C${f(w * 0.05)} 0 0 ${f(h * 0.15)} 0 ${f(h * 0.3)} C0 ${f(h * 0.55)} ${f(w * 0.25)} ${f(h * 0.75)} ${f(w / 2)} ${f(h)} C${f(w * 0.75)} ${f(h * 0.75)} ${f(w)} ${f(h * 0.55)} ${f(w)} ${f(h * 0.3)} C${f(w)} ${f(h * 0.15)} ${f(w * 0.95)} 0 ${f(w * 0.8)} 0 C${f(w * 0.7)} 0 ${f(w * 0.5)} ${f(h * 0.1)} ${f(w / 2)} ${f(h * 0.25)} Z`,
  /** Brackets and braces are open outlines. adjust[0]: corner size as a fraction of the width. */
  leftBracket: (w, h, adj) => {
    const r = Math.min(clamp(a(adj, 0, 1), 0, 1) * w, h / 2);
    return {
      d: `M${f(w)} 0 A${f(w)} ${f(r)} 0 0 0 0 ${f(r)} V${f(h - r)} A${f(w)} ${f(r)} 0 0 0 ${f(w)} ${f(h)}`,
      closed: false,
    };
  },
  rightBracket: (w, h, adj) => {
    const r = Math.min(clamp(a(adj, 0, 1), 0, 1) * w, h / 2);
    return {
      d: `M0 0 A${f(w)} ${f(r)} 0 0 1 ${f(w)} ${f(r)} V${f(h - r)} A${f(w)} ${f(r)} 0 0 1 0 ${f(h)}`,
      closed: false,
    };
  },
  leftBrace: (w, h) => {
    const m = w / 2;
    const q = Math.min(h / 4, w);
    return {
      d: `M${f(w)} 0 Q${f(m)} 0 ${f(m)} ${f(q)} V${f(h / 2 - q)} Q${f(m)} ${f(h / 2)} 0 ${f(h / 2)} Q${f(m)} ${f(h / 2)} ${f(m)} ${f(h / 2 + q)} V${f(h - q)} Q${f(m)} ${f(h)} ${f(w)} ${f(h)}`,
      closed: false,
    };
  },
  rightBrace: (w, h) => {
    const m = w / 2;
    const q = Math.min(h / 4, w);
    return {
      d: `M0 0 Q${f(m)} 0 ${f(m)} ${f(q)} V${f(h / 2 - q)} Q${f(m)} ${f(h / 2)} ${f(w)} ${f(h / 2)} Q${f(m)} ${f(h / 2)} ${f(m)} ${f(h / 2 + q)} V${f(h - q)} Q${f(m)} ${f(h)} 0 ${f(h)}`,
      closed: false,
    };
  },
};

export const shapePresets: readonly string[] = [
  ...Object.keys(PRESETS),
  ...Object.keys(extraShapes),
];

/** The path of a preset at a size, or undefined for an unknown preset name. */
export function presetPath(
  preset: string,
  w: number,
  h: number,
  adjust: readonly number[] = [],
): ShapePath | undefined {
  const generate = PRESETS[preset];
  if (!generate) {
    const extra = extraShapes[preset];
    return extra ? { d: extra.draw(w, h), closed: true } : undefined;
  }
  const out = generate(w, h, adjust);
  return typeof out === 'string' ? { d: out, closed: true } : out;
}

// ---- Path data: scaling `path` geometry from its viewBox to the frame, and bounds. ----

const ARGS: Record<string, number> = { m: 2, l: 2, h: 1, v: 1, c: 6, s: 4, q: 4, t: 2, a: 7, z: 0 };

interface Segment {
  command: string;
  args: number[];
}

/** Path data as commands with their arguments; repeated argument groups become separate segments. */
function segments(d: string): Segment[] {
  const tokens = d.match(/[a-zA-Z]|[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?/g) ?? [];
  const out: Segment[] = [];
  let i = 0;
  let command = '';
  while (i < tokens.length) {
    const token = tokens[i] as string;
    if (/[a-zA-Z]/.test(token)) {
      command = token;
      i++;
      if (command.toLowerCase() === 'z') {
        out.push({ command, args: [] });
        continue;
      }
    }
    const count = ARGS[command.toLowerCase()];
    if (!count) {
      i++;
      continue;
    }
    const args = tokens.slice(i, i + count).map(Number);
    if (args.length < count || args.some(Number.isNaN)) break;
    i += count;
    out.push({ command, args });
    // The pairs that follow a move are lines to them, as SVG reads them.
    if (command === 'M') command = 'L';
    else if (command === 'm') command = 'l';
  }
  return out;
}

/**
 * Scales path data by (sx, sy), then moves its absolute coordinates by (tx, ty). Arc radii scale
 * with their axes; that is exact unless the arc is rotated and the scale is not uniform, which
 * only bends an ellipse that was already tilted.
 */
export function transformPath(d: string, sx: number, sy: number, tx = 0, ty = 0): string {
  return segments(d)
    .map(({ command, args }) => {
      const abs = command !== command.toLowerCase();
      const dx = abs ? tx : 0;
      const dy = abs ? ty : 0;
      let out: number[];
      switch (command.toLowerCase()) {
        case 'z':
          return command;
        case 'h':
          out = [args[0]! * sx + dx];
          break;
        case 'v':
          out = [args[0]! * sy + dy];
          break;
        case 'a':
          out = [
            args[0]! * sx,
            args[1]! * sy,
            args[2]!,
            args[3]!,
            args[4]!,
            args[5]! * sx + dx,
            args[6]! * sy + dy,
          ];
          break;
        default:
          out = args.map((v, k) => (k % 2 ? v * sy + dy : v * sx + dx));
      }
      return `${command}${out.map(f).join(' ')}`;
    })
    .join(' ');
}

export function scalePath(d: string, sx: number, sy: number): string {
  return transformPath(d, sx, sy);
}

/**
 * The box that holds every point and control point of a path. Arcs count by their end points,
 * so a bulging arc may reach past the box; callers union it with the frame, which arcs in
 * presets stay inside.
 */
export function pathBounds(d: string): { x: number; y: number; w: number; h: number } {
  let x = 0;
  let y = 0;
  let startX = 0;
  let startY = 0;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const add = (px: number, py: number) => {
    minX = Math.min(minX, px);
    minY = Math.min(minY, py);
    maxX = Math.max(maxX, px);
    maxY = Math.max(maxY, py);
  };
  for (const { command, args } of segments(d)) {
    const rel = command === command.toLowerCase();
    const ox = rel ? x : 0;
    const oy = rel ? y : 0;
    switch (command.toLowerCase()) {
      case 'z':
        x = startX;
        y = startY;
        continue;
      case 'h':
        x = args[0]! + ox;
        break;
      case 'v':
        y = args[0]! + oy;
        break;
      case 'a':
        x = args[5]! + ox;
        y = args[6]! + oy;
        break;
      default:
        for (let k = 0; k < args.length; k += 2) add(args[k]! + ox, args[k + 1]! + oy);
        x = args[args.length - 2]! + ox;
        y = args[args.length - 1]! + oy;
    }
    add(x, y);
    if (command.toLowerCase() === 'm') {
      startX = x;
      startY = y;
    }
  }
  if (minX === Infinity) return { x: 0, y: 0, w: 0, h: 0 };
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

/** Pieces a curve is cut into, and the most an arc turns in one piece. */
const CURVE_PIECES = 24;
const ARC_STEP = Math.PI / 48;

/**
 * The points of an arc after its start, as the SVG specification turns the end points of an arc
 * into its centre (F.6.5), cut into pieces that turn at most `ARC_STEP` each.
 */
function arcPoints(
  x1: number,
  y1: number,
  [rxIn, ryIn, angle, large, sweep, x2, y2]: number[],
): Pt[] {
  if (x1 === x2 && y1 === y2) return [];
  let rx = Math.abs(rxIn!);
  let ry = Math.abs(ryIn!);
  if (!rx || !ry) return [[x2!, y2!]];
  const phi = (angle! * Math.PI) / 180;
  const cos = Math.cos(phi);
  const sin = Math.sin(phi);
  const dx = (x1 - x2!) / 2;
  const dy = (y1 - y2!) / 2;
  const x1p = cos * dx + sin * dy;
  const y1p = -sin * dx + cos * dy;
  const lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
  if (lambda > 1) {
    rx *= Math.sqrt(lambda);
    ry *= Math.sqrt(lambda);
  }
  const num = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p;
  const den = rx * rx * y1p * y1p + ry * ry * x1p * x1p;
  const coef = (large !== sweep ? 1 : -1) * Math.sqrt(Math.max(0, num / (den || 1)));
  const cxp = (coef * rx * y1p) / ry;
  const cyp = (-coef * ry * x1p) / rx;
  const cx = cos * cxp - sin * cyp + (x1 + x2!) / 2;
  const cy = sin * cxp + cos * cyp + (y1 + y2!) / 2;
  const turn = (ux: number, uy: number, vx: number, vy: number) =>
    Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
  const ux = (x1p - cxp) / rx;
  const uy = (y1p - cyp) / ry;
  const start = turn(1, 0, ux, uy);
  let delta = turn(ux, uy, (-x1p - cxp) / rx, (-y1p - cyp) / ry);
  if (!sweep && delta > 0) delta -= 2 * Math.PI;
  if (sweep && delta < 0) delta += 2 * Math.PI;
  const n = Math.max(2, Math.ceil(Math.abs(delta) / ARC_STEP));
  const out: Pt[] = [];
  for (let i = 1; i <= n; i++) {
    const t = start + (delta * i) / n;
    const ex = rx * Math.cos(t);
    const ey = ry * Math.sin(t);
    out.push([cos * ex - sin * ey + cx, sin * ex + cos * ey + cy]);
  }
  return out;
}

/**
 * A path as the lines it draws, one run of points for each part of it: curves and arcs cut into
 * short straight pieces. For measuring a drawn outline, such as how far a point is from it; not
 * for drawing.
 */
export function flattenPath(d: string): Pt[][] {
  const runs: Pt[][] = [];
  let run: Pt[] = [];
  let x = 0;
  let y = 0;
  let startX = 0;
  let startY = 0;
  // The second control point of the curve before, which a smooth curve mirrors.
  let control: Pt | null = null;
  let controlOf = '';
  const end = () => {
    if (run.length > 1) runs.push(run);
    run = [];
  };
  const to = (px: number, py: number) => {
    if (!run.length) run.push([x, y]);
    run.push([px, py]);
    x = px;
    y = py;
  };
  const cubic = (c1: Pt, c2: Pt, px: number, py: number) => {
    const [x0, y0] = [x, y];
    for (let i = 1; i <= CURVE_PIECES; i++) {
      const t = i / CURVE_PIECES;
      const s = 1 - t;
      to(
        s * s * s * x0 + 3 * s * s * t * c1[0] + 3 * s * t * t * c2[0] + t * t * t * px,
        s * s * s * y0 + 3 * s * s * t * c1[1] + 3 * s * t * t * c2[1] + t * t * t * py,
      );
    }
  };
  const quadratic = (c: Pt, px: number, py: number) => {
    const [x0, y0] = [x, y];
    for (let i = 1; i <= CURVE_PIECES; i++) {
      const t = i / CURVE_PIECES;
      const s = 1 - t;
      to(s * s * x0 + 2 * s * t * c[0] + t * t * px, s * s * y0 + 2 * s * t * c[1] + t * t * py);
    }
  };
  const mirrored = (kinds: string): Pt =>
    control && kinds.includes(controlOf) ? [2 * x - control[0], 2 * y - control[1]] : [x, y];
  for (const { command, args } of segments(d)) {
    const kind = command.toLowerCase();
    const ox = command === kind ? x : 0;
    const oy = command === kind ? y : 0;
    const a = args.map((v, k) => v + (k % 2 ? oy : ox));
    let next: Pt | null = null;
    switch (kind) {
      case 'm':
        end();
        x = startX = a[0]!;
        y = startY = a[1]!;
        break;
      case 'z':
        if (run.length) to(startX, startY);
        end();
        x = startX;
        y = startY;
        break;
      case 'l':
        to(a[0]!, a[1]!);
        break;
      case 'h':
        to(args[0]! + ox, y);
        break;
      case 'v':
        to(x, args[0]! + oy);
        break;
      case 'c':
        next = [a[2]!, a[3]!];
        cubic([a[0]!, a[1]!], next, a[4]!, a[5]!);
        break;
      case 's':
        next = [a[0]!, a[1]!];
        cubic(mirrored('cs'), next, a[2]!, a[3]!);
        break;
      case 'q':
        next = [a[0]!, a[1]!];
        quadratic(next, a[2]!, a[3]!);
        break;
      case 't':
        next = mirrored('qt');
        quadratic(next, a[0]!, a[1]!);
        break;
      case 'a':
        for (const [px, py] of arcPoints(x, y, [...args.slice(0, 5), args[5]! + ox, args[6]! + oy]))
          to(px, py);
        break;
    }
    control = next;
    controlOf = kind;
  }
  end();
  return runs;
}
