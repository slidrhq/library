import { LINE_FLOW_DEFAULTS, type LineElement, type LineFlow, type Stroke } from '@slidr/model';
import type { CSSProperties } from 'react';
import { num } from './css';
import { colorCss } from './theme';

/*
 * What runs along a line (ADR-131): its dashes flow toward its end, and riders, boxes or dots,
 * travel its path at the same pace, as on a conveyor. Both are CSS animations that never end, so
 * they play wherever the slide is drawn (the stage, a show, an exported file), and whatever holds
 * the animations of a page holds them too: a show's black screen, a still tile of Elements.
 *
 * A rider goes along the line's own path (`offset-path`), the path the line is drawn with, so it
 * follows the line's points, its curve and its mirroring as the stroke does. The keyframes are
 * named for the whole document and written once with the ambient motions' (`AMBIENT_KEYFRAMES`);
 * how far the dashes move in a round is a custom property of the stroke, which they read.
 */

/** The custom property the dashes' keyframes read how far a round moves them from. */
const SHIFT = '--slidr-flow';

/**
 * The dashes move by one period of their pattern a round; a rider goes the whole line, fading
 * in as it sets out and out as it arrives, so it never stands on a head of the line.
 */
export const FLOW_KEYFRAMES =
  `@keyframes slidr-flow{to{stroke-dashoffset:var(${SHIFT})}}` +
  '@keyframes slidr-ride{0%{offset-distance:0%;opacity:0}7%,93%{opacity:1}to{offset-distance:100%;opacity:0}}';

/** The numbers of a path's data, after the command each belongs to. */
const TOKEN = /[MLHVC]|-?(?:\d+(?:\.\d*)?|\.\d+)(?:e[-+]?\d+)?/gi;

/** Straight pieces a cubic Bézier is measured in. */
const CURVE_STEPS = 24;

/**
 * The length of a line's path in slide pixels: the path `linePath` writes, of moves, lines,
 * horizontal and vertical lines and cubic Béziers, all absolute.
 */
export function pathLength(d: string): number {
  const tokens = d.match(TOKEN) ?? [];
  let i = 0;
  const next = () => Number(tokens[i++]);
  let x = 0;
  let y = 0;
  let length = 0;
  let command = 'M';
  while (i < tokens.length) {
    const token = tokens[i] as string;
    if (/^[a-z]$/i.test(token)) {
      command = token.toUpperCase();
      i++;
      continue;
    }
    switch (command) {
      case 'M':
        x = next();
        y = next();
        command = 'L';
        break;
      case 'L': {
        const [nx, ny] = [next(), next()];
        length += Math.hypot(nx - x, ny - y);
        [x, y] = [nx, ny];
        break;
      }
      case 'H': {
        const nx = next();
        length += Math.abs(nx - x);
        x = nx;
        break;
      }
      case 'V': {
        const ny = next();
        length += Math.abs(ny - y);
        y = ny;
        break;
      }
      case 'C': {
        const [x1, y1, x2, y2, nx, ny] = [next(), next(), next(), next(), next(), next()];
        let [px, py] = [x, y];
        for (let step = 1; step <= CURVE_STEPS; step++) {
          const t = step / CURVE_STEPS;
          const u = 1 - t;
          const qx = u * u * u * x + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t * nx;
          const qy = u * u * u * y + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * ny;
          length += Math.hypot(qx - px, qy - py);
          [px, py] = [qx, qy];
        }
        [x, y] = [nx, ny];
        break;
      }
      default:
        i++;
    }
  }
  return Number.isFinite(length) ? length : 0;
}

/** One round of a dash pattern (`stroke-dasharray`), in slide pixels. */
function dashPeriod(dashArray: string | undefined): number {
  if (!dashArray) return 0;
  return dashArray
    .split(/[\s,]+/)
    .map(Number)
    .filter((n) => Number.isFinite(n))
    .reduce((sum, n) => sum + n, 0);
}

/** How long a round of a motion takes, in milliseconds, at least one. */
const ms = (distance: number, speed: number) =>
  `${num(Math.max(1, (distance / speed) * 1000), 1)}ms`;

/**
 * The animation of a line's stroke whose dashes flow, if they do: one period of the pattern a
 * round, forward or back. A solid stroke has nothing to move.
 */
export function flowStrokeStyle(flow: LineFlow, dashArray: string | undefined): CSSProperties {
  const period = dashPeriod(dashArray);
  if (!(period > 0) || !(flow.speed > 0)) return {};
  return {
    animation: `slidr-flow ${ms(period, flow.speed)} linear infinite`,
    [SHIFT]: `${num(flow.reverse ? period : -period, 2)}px`,
  } as CSSProperties;
}

/** A rider's longest side when the flow gives none: in proportion to the line's width. */
export function riderSize(flow: LineFlow, stroke: Stroke): number {
  if (flow.size !== undefined) return flow.size;
  const w = Math.max(stroke.width, 0.5);
  return flow.rider === 'dot' ? Math.max(10, w * 3.5) : Math.max(16, w * 7);
}

/** The riders of a line's flow, each going the path `d` drawn of it. */
export function FlowRiders({ element: e, d }: { element: LineElement; d: string }) {
  const flow = e.flow;
  if (!flow || !flow.rider || flow.rider === 'none' || !(flow.speed > 0)) return null;
  const length = pathLength(d);
  if (!(length > 0)) return null;
  const count = flow.count ?? LINE_FLOW_DEFAULTS.count;
  const round = (length / flow.speed) * 1000;
  const size = riderSize(flow, e.stroke);
  const fill = colorCss(flow.color ?? e.stroke.color);
  // A ring in the slide's ground sets a rider apart from the dashes it rides on.
  const ring = { stroke: colorCss({ token: 'bg' }), strokeWidth: num(Math.max(1, size * 0.1), 2) };
  const shape =
    flow.rider === 'dot' ? (
      <circle r={num(size / 2, 2)} style={{ fill, ...ring }} />
    ) : (
      <rect
        x={num(-size / 2, 2)}
        y={num(-size * 0.35, 2)}
        width={num(size, 2)}
        height={num(size * 0.7, 2)}
        rx={num(size * 0.16, 2)}
        style={{ fill, ...ring }}
      />
    );
  return (
    <g data-slidr-riders="">
      {Array.from({ length: count }, (_, i) => (
        <g
          key={i}
          style={{
            offsetPath: `path('${d}')`,
            offsetRotate: 'auto',
            offsetDistance: '0%',
            // Hidden until its round places it, where the animation does not run.
            opacity: 0,
            animation: `slidr-ride ${num(Math.max(1, round), 1)}ms linear ${num((-round * i) / count, 1)}ms infinite${flow.reverse ? ' reverse' : ''}`,
          }}
        >
          {shape}
        </g>
      ))}
    </g>
  );
}
