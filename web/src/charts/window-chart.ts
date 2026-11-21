// A plan window chart: used % over the window with the even-pace line, the projection at the
// recent rate, the 1 h / 2 h projections, the target-empty marker, the reserve band and a "now"
// line. A past week adds its final value and the time it ran out; other weeks can be overlaid
// (aligned by the caller onto this window's time axis). A zoomed view (`view` + `y`) shows part
// of the window with a fitted y axis, 15-minute ticks, the launch cutoff and the reset. Inline
// SVG, redrawn on resize, with a hover crosshair that reads out the nearest reading, each
// overlay's value at that point and where each projection ends.

import { h } from '../dom.ts';
import { projectionSegment } from './projection-geometry.ts';
import { spreadLabels, valueAt } from '../pages/past-weeks-logic.ts';
import { clipLine, quarterTicks, yTicks, type YZoom } from '../pages/final-stretch-logic.ts';
import { linear, points, responsive, s, fix } from './svg.ts';

const HOUR = 3600_000;

export interface ChartPoint {
  t: number;
  used: number;
  note?: string;
}

export interface WindowChartSpec {
  label: string;
  start: number;
  end: number;
  now: number;
  points: ChartPoint[];
  /** Weekly projection at reset, or when the allowance runs out. */
  projection?: ChartPoint & { runsOut: boolean; readout?: string };
  /**
   * Extra projections (the 1 h and 2 h rates), each told apart by dash pattern, end marker and
   * an inline tag. Elements carry data-proj=<key> so a page can hide one with CSS.
   */
  shortProjections?: ShortLine[];
  /** When the plan should be near empty (reset minus the buffer). */
  targetEmpty?: number;
  /** Used % to reach at target empty: the even-pace line ends there (default 100 at the reset). */
  targetPct?: number;
  /** Shade targetPct..100% as the reserve band. */
  reserve?: boolean;
  /** Zoomed time range (default the whole window). */
  view?: { from: number; to: number };
  /** Zoomed y range (default 0-100%). */
  y?: YZoom;
  /** The readings line when it differs from the dots (clipped to the zoomed range). */
  linePoints?: ChartPoint[];
  /** Always draw a dot per reading (default: only when there are 40 or fewer). */
  dots?: boolean;
  /** No new launches from this time: a marked rule. */
  launchCutoff?: number;
  /** Draw and label the reset (the window's end) as a rule. */
  resetLine?: boolean;
  /** Draw the readings from 0% at the window start (false for a week whose data starts late). */
  fromZero?: boolean;
  /** A finished week's last reading, marked and labeled with its value. */
  final?: ChartPoint;
  /** When a week ran out (first reading at 100%). */
  ranOut?: number;
  /** Other weeks drawn under the readings, already on this window's time axis. */
  overlays?: Overlay[];
  /** Overlays whose key is in here start hidden (legend toggles). */
  hidden?: ReadonlySet<string>;
  ticks: 'day' | 'hour' | 'quarter';
  timeZone?: string;
  height?: number;
}

export interface ShortLine {
  key: string;
  /** Short tag drawn at the end of the line ("1 h"). */
  tag: string;
  /** End point: used % at the reset, or 100 at the time it runs out. */
  t: number;
  used: number;
  runsOut: boolean;
  /** Hover text, e.g. "Last 1 h: 97% at reset". */
  readout: string;
}

export interface Overlay {
  /** Window id, or "avg"; elements carry data-overlay=<key>. */
  key: string;
  /** End label, e.g. "Nov 6–13: 91%". */
  label: string;
  /** Compact end label for narrow charts, e.g. "Nov 6: 91%". */
  short: string;
  /** Name in the hover readout, e.g. "Nov 6–13". */
  name: string;
  points: ChartPoint[];
  dash: string;
  /** Style slot 0-3 (newest first) or "avg". */
  slot: number | 'avg';
}

/** End marker shapes for the short projections, in order: square, then triangle. */
const SHAPES = [
  (x: number, y: number) => `M${x - 4},${y - 4} h8 v8 h-8 Z`,
  (x: number, y: number) => `M${x},${y - 5} L${x + 5},${y + 4} L${x - 5},${y + 4} Z`,
];

function hourIn(t: number, tz?: string): number {
  const hh = new Intl.DateTimeFormat('en-US', { hour: 'numeric', hourCycle: 'h23', timeZone: tz })
    .formatToParts(new Date(t))
    .find((p) => p.type === 'hour')?.value;
  return Number(hh ?? 0) % 24;
}

function ticks(spec: WindowChartSpec, width: number): { t: number; label: string }[] {
  const out: { t: number; label: string }[] = [];
  if (spec.ticks === 'quarter') {
    const fmt = new Intl.DateTimeFormat(undefined, {
      hour: 'numeric',
      minute: '2-digit',
      timeZone: spec.timeZone,
    });
    const span = spec.view ?? { from: spec.start, to: spec.end };
    return quarterTicks(span).map((t) => ({ t, label: fmt.format(new Date(t)) }));
  }
  const first = Math.ceil(spec.start / HOUR) * HOUR;
  const fmt =
    spec.ticks === 'day'
      ? new Intl.DateTimeFormat(undefined, {
          weekday: width < 520 ? 'narrow' : 'short',
          day: width < 520 ? undefined : 'numeric',
          timeZone: spec.timeZone,
        })
      : new Intl.DateTimeFormat(undefined, { hour: 'numeric', timeZone: spec.timeZone });
  for (let t = first; t < spec.end; t += HOUR) {
    if (t <= spec.start) continue;
    if (spec.ticks === 'day' && hourIn(t, spec.timeZone) !== 0) continue;
    out.push({ t, label: fmt.format(new Date(t)) });
  }
  return out;
}

export function windowChart(spec: WindowChartSpec): HTMLElement {
  const svgHost = h('div', { class: 'chart-svg' });
  const tip = h('div', { class: 'chart-tip', role: 'status', hidden: true });
  const wrap = h('figure', { class: 'chart' }, svgHost, tip);
  responsive(svgHost, (width) => draw(width));

  function draw(width: number) {
    const height = spec.height ?? Math.max(200, Math.min(270, Math.round(width * 0.36)));
    // Overlays keep their end labels in a gutter right of the plot, clear of the projection
    // tags; narrow charts use a smaller gutter and compact labels.
    const hasOv = (spec.overlays?.length ?? 0) > 0;
    const wide = width >= 640;
    const gutter = hasOv ? (wide ? 128 : 74) : 0;
    const m = { l: 40, r: 14 + gutter, t: 18, b: 26 };
    const x0 = spec.view?.from ?? spec.start;
    const x1 = spec.view?.to ?? spec.end;
    const x = linear([x0, x1], [m.l, width - m.r]);
    const yz = spec.y ?? { lo: 0, hi: 100, zoomed: false, step: 25 };
    const y = linear([yz.lo, yz.hi], [height - m.b, m.t]);
    const inX = (t: number) => t >= x0 && t <= x1;
    const dom = { start: x0, end: x1, now: spec.now };
    const svg = s('svg', {
      width,
      height,
      viewBox: `0 0 ${width} ${height}`,
      role: 'img',
      'aria-label': spec.label,
    });

    const grid = s('g', { class: 'grid' });
    for (const v of yTicks(yz)) {
      grid.append(
        s('line', { x1: m.l, x2: width - m.r, y1: fix(y(v)), y2: fix(y(v)) }),
        s('text', { x: m.l - 6, y: fix(y(v)) + 4, 'text-anchor': 'end' }, `${v}%`),
      );
    }
    const tk = ticks(spec, width);
    // Clock-time labels ("10:45 PM") are wider than day or hour labels.
    const quarter = spec.ticks === 'quarter';
    const every = Math.max(1, Math.ceil((tk.length * (quarter ? 64 : 44)) / (width - m.l - m.r)));
    // A zoomed time axis labels every other tick when they would crowd.
    tk.forEach((tick, i) => {
      grid.append(
        s('line', {
          class: 'vtick',
          x1: fix(x(tick.t)),
          x2: fix(x(tick.t)),
          y1: m.t,
          y2: height - m.b,
        }),
      );
      const tx = fix(x(tick.t));
      if (quarter) {
        // Centered under the tick; skipped where it would run past either end of the plot.
        if (i % every === 0 && tx - 28 >= m.l - 8 && tx + 28 <= width - m.r + 8) {
          grid.append(s('text', { x: tx, y: height - 8, 'text-anchor': 'middle' }, tick.label));
        }
      } else if (i % every === 0) {
        grid.append(s('text', { x: tx + 3, y: height - 8 }, tick.label));
      }
    });
    svg.append(grid);

    if (yz.lo > 0) {
      // Axis break: the y axis does not start at 0.
      const by = height - m.b;
      grid.append(
        s('path', {
          class: 'axis-break',
          d: `M${m.l - 5},${by - 1} l10,-4 M${m.l - 5},${by + 3} l10,-4`,
        }),
      );
    }

    // The reserve: target % to 100%, kept for the lead and the final-hour jobs.
    const targetPct = spec.targetPct ?? 100;
    if (spec.reserve && targetPct < 100 && yz.hi > targetPct) {
      const top = fix(y(100));
      const bottom = fix(y(Math.max(targetPct, yz.lo)));
      const tall = bottom - top >= 14;
      svg.append(
        s('rect', {
          class: 'reserve',
          x: m.l,
          y: top,
          width: Math.max(0, width - m.l - m.r),
          height: Math.max(0, bottom - top),
        }),
        s(
          'text',
          { class: 'reserve-label', x: m.l + 4, y: tall ? (top + bottom) / 2 + 4 : bottom + 11 },
          `Reserve ${Math.round(targetPct)}–100%`,
        ),
      );
    }

    // Even pace: 0% at the start to the target % at target empty (flat to the reset), or to
    // 100% at the reset when no target is given.
    const evenPts =
      spec.targetEmpty !== undefined && spec.targetPct !== undefined
        ? [
            { t: spec.start, used: 0 },
            { t: spec.targetEmpty, used: targetPct },
            ...(spec.end > spec.targetEmpty ? [{ t: spec.end, used: targetPct }] : []),
          ]
        : [
            { t: spec.start, used: 0 },
            { t: spec.end, used: 100 },
          ];
    const evenIn = clipLine(evenPts, { from: x0, to: x1 });
    if (evenIn.length >= 2) {
      svg.append(
        s('polyline', {
          class: 'even',
          points: points(evenIn.map((q): [number, number] => [x(q.t), y(q.used)])),
        }),
      );
    }

    if (spec.targetEmpty !== undefined && spec.targetEmpty > spec.start && inX(spec.targetEmpty)) {
      const tx = fix(x(spec.targetEmpty));
      const ty = fix(y(targetPct));
      svg.append(
        s('line', { class: 'target-rule', x1: tx, x2: tx, y1: ty, y2: height - m.b }),
        s('path', {
          class: 'target',
          d: `M${tx},${ty - 6} L${tx + 6},${ty} L${tx},${ty + 6} L${tx - 6},${ty} Z`,
        }),
        s(
          'text',
          { class: 'target-label', x: tx - 5, y: height - m.b - 6, 'text-anchor': 'end' },
          'target empty',
        ),
      );
    }

    // Launch cutoff and reset rules, labeled at the top on two rows so they never collide.
    if (spec.launchCutoff !== undefined && inX(spec.launchCutoff)) {
      const cx = fix(x(spec.launchCutoff));
      svg.append(
        s('line', { class: 'cutoff-rule', x1: cx, x2: cx, y1: m.t, y2: height - m.b }),
        s(
          'text',
          { class: 'cutoff-label', x: cx - 4, y: m.t + 24, 'text-anchor': 'end' },
          'launch cutoff',
        ),
      );
    }
    if (spec.resetLine && inX(spec.end)) {
      const rx = fix(x(spec.end));
      svg.append(
        s('line', { class: 'reset-rule', x1: rx, x2: rx, y1: m.t, y2: height - m.b }),
        s('text', { class: 'reset-label', x: rx - 4, y: m.t + 10, 'text-anchor': 'end' }, 'reset'),
      );
    }

    if (spec.now > spec.start && spec.now < spec.end && spec.now > x0 && spec.now < x1) {
      const nx = fix(x(spec.now));
      svg.append(
        s('line', { class: 'now', x1: nx, x2: nx, y1: m.t - 6, y2: height - m.b }),
        s(
          'text',
          {
            class: 'now-label',
            x: nx + (nx > width - 60 ? -4 : 4),
            y: m.t - 6,
            'text-anchor': nx > width - 60 ? 'end' : 'start',
          },
          'now',
        ),
      );
    }

    const overlays = spec.overlays ?? [];
    const ovEnds = overlays.map((o) => o.points[o.points.length - 1]);
    const labelYs = spreadLabels(
      ovEnds.map((e) => (e ? y(e.used) + 4 : m.t)),
      13,
      m.t + 4,
      height - m.b - 4,
    );
    const plotRight = width - m.r;
    overlays.forEach((o, i) => {
      const end = ovEnds[i];
      if (!end) return;
      const g = s('g', {
        class: `overlay ov-${o.slot}${spec.hidden?.has(o.key) ? ' ov-hidden' : ''}`,
        'data-overlay': o.key,
      });
      g.append(
        s('polyline', {
          class: 'ov-line',
          points: points(o.points.map((q): [number, number] => [x(q.t), y(q.used)])),
          'stroke-dasharray': o.dash,
        }),
      );
      const ex = fix(x(end.t));
      const ey = fix(y(end.used));
      const ly = fix(labelYs[i] as number);
      g.append(
        s('circle', { class: 'ov-end', cx: ex, cy: ey, r: 2.5 }),
        s('line', { class: 'ov-leader', x1: ex + 3, y1: ey, x2: plotRight + 6, y2: ly - 4 }),
        s(
          'text',
          { class: `ov-label${wide ? '' : ' ov-label-short'}`, x: plotRight + 9, y: ly },
          wide ? o.label : o.short,
        ),
      );
      svg.append(g);
    });

    const pts = spec.points;
    const last = pts[pts.length - 1];
    const p = spec.projection;
    const seg = last && p ? projectionSegment(dom, last.used, p) : null;
    if (seg) {
      svg.append(
        s('line', {
          class: 'proj',
          x1: fix(x(seg.t0)),
          y1: fix(y(seg.used0)),
          x2: fix(x(seg.t1)),
          y2: fix(y(seg.used1)),
        }),
      );
      if (seg.runsOut) {
        svg.append(s('circle', { class: 'runs-out', cx: fix(x(seg.t1)), cy: fix(y(100)), r: 4 }));
      }
    }

    const shorts = last ? (spec.shortProjections ?? []) : [];
    const segs = shorts.map((sp) => projectionSegment(dom, (last as ChartPoint).used, sp));
    // The higher end gets its tag above, the lower below, so close ends stay legible.
    const highest = Math.max(...segs.map((g) => (g ? g.used1 : -1)));
    shorts.forEach((sp, i) => {
      const g = segs[i];
      if (!g) return;
      const x1 = fix(x(g.t0));
      const y1 = fix(y(g.used0));
      const x2 = fix(x(g.t1));
      const y2 = fix(y(g.used1));
      const group = s('g', { class: `proj-short proj-${sp.key}`, 'data-proj': sp.key });
      group.append(s('line', { class: 'proj-line', x1, y1, x2, y2 }));
      const shape = SHAPES[i % SHAPES.length] as (typeof SHAPES)[0];
      group.append(
        g.runsOut
          ? s('circle', { class: 'runs-out', cx: x2, cy: y2, r: 4 })
          : s('path', { class: 'end-mark', d: shape(x2, y2) }),
      );
      const above = g.used1 === highest && segs.findIndex((o) => o?.used1 === highest) === i;
      const right = x2 > width - m.r - 40;
      group.append(
        s(
          'text',
          {
            class: 'proj-tag',
            x: right ? x2 - 8 : x2 + 8,
            y: above ? y2 - 7 : y2 + 15,
            'text-anchor': right ? 'end' : 'start',
          },
          g.runsOut ? `${sp.tag} out` : sp.tag,
        ),
      );
      svg.append(group);
    });

    if (pts.length || spec.linePoints?.length) {
      const line: [number, number][] = spec.linePoints
        ? spec.linePoints.map((p): [number, number] => [x(p.t), y(p.used)])
        : [
            ...(spec.fromZero === false ? [] : [[x(spec.start), y(0)] as [number, number]]),
            ...pts.map((p): [number, number] => [
              x(Math.min(Math.max(p.t, spec.start), spec.end)),
              y(p.used),
            ]),
          ];
      if (line.length) svg.append(s('polyline', { class: 'used', points: points(line) }));
      if (spec.dots || pts.length <= 40) {
        const dots = s('g', { class: 'dots' });
        for (const p of pts)
          dots.append(s('circle', { cx: fix(x(p.t)), cy: fix(y(p.used)), r: 3.5 }));
        svg.append(dots);
      }
    }

    if (spec.ranOut !== undefined) {
      const rx = fix(x(Math.min(Math.max(spec.ranOut, spec.start), spec.end)));
      const right = rx > width - m.r - 70;
      svg.append(
        s('line', { class: 'ran-out-rule', x1: rx, x2: rx, y1: fix(y(100)), y2: height - m.b }),
        s('circle', { class: 'runs-out ran-out', cx: rx, cy: fix(y(100)), r: 5 }),
        s(
          'text',
          {
            class: 'ran-out-label',
            x: right ? rx - 8 : rx + 8,
            // In the top margin, so it never meets the final-value label below the line.
            y: fix(y(100)) - 6,
            'text-anchor': right ? 'end' : 'start',
          },
          'ran out',
        ),
      );
    }
    if (spec.final) {
      const fx = fix(x(Math.min(Math.max(spec.final.t, spec.start), spec.end)));
      const fy = fix(y(spec.final.used));
      const right = fx > width - m.r - 50;
      svg.append(
        s('path', {
          class: 'final-mark',
          d: `M${fx},${fy - 6} L${fx + 6},${fy} L${fx},${fy + 6} L${fx - 6},${fy} Z`,
        }),
        s(
          'text',
          {
            class: 'final-label',
            x: right ? fx - 9 : fx + 9,
            y: spec.ranOut === undefined && fy > m.t + 20 ? fy - 8 : fy + 18,
            'text-anchor': right ? 'end' : 'start',
          },
          `${Math.round(spec.final.used)}%`,
        ),
      );
    }

    // Hover: crosshair and the nearest reading.
    const cross = s('line', { class: 'cross', y1: m.t, y2: height - m.b, visibility: 'hidden' });
    const focus = s('circle', { class: 'focus', r: 5, visibility: 'hidden' });
    const hit = s('rect', {
      class: 'hit',
      x: m.l,
      y: 0,
      width: Math.max(0, width - m.l - m.r),
      height,
    });
    svg.append(cross, focus, hit);
    const tf = new Intl.DateTimeFormat(undefined, {
      weekday: 'short',
      hour: 'numeric',
      minute: '2-digit',
      timeZone: spec.timeZone,
    });
    hit.addEventListener('pointermove', (ev) => {
      if (!pts.length) return;
      const box = svg.getBoundingClientRect();
      const px = ev.clientX - box.left;
      let best = pts[0] as ChartPoint;
      for (const p of pts) if (Math.abs(x(p.t) - px) < Math.abs(x(best.t) - px)) best = p;
      const bx = fix(x(best.t));
      const by = fix(y(best.used));
      cross.setAttribute('x1', String(bx));
      cross.setAttribute('x2', String(bx));
      focus.setAttribute('cx', String(bx));
      focus.setAttribute('cy', String(by));
      cross.setAttribute('visibility', 'visible');
      focus.setAttribute('visibility', 'visible');
      tip.replaceChildren(
        h(
          'div',
          {},
          h('b', {}, `${best.used.toFixed(1)}% used`),
          ` · ${tf.format(new Date(best.t))}`,
          best.note ? h('span', { class: 'muted' }, ` · ${best.note}`) : '',
        ),
        p?.readout ? h('div', { class: 'tip-proj' }, p.readout) : '',
        ...overlays.map((o) => {
          const v = valueAt(o.points, best.t);
          return h(
            'div',
            {
              class: `tip-overlay${spec.hidden?.has(o.key) ? ' ov-hidden' : ''}`,
              'data-overlay': o.key,
            },
            `${o.name}: ${v === null ? 'no reading' : `${v.toFixed(1)}%`}`,
          );
        }),
        ...shorts.map((sp) => h('div', { class: 'tip-proj', 'data-proj': sp.key }, sp.readout)),
      );
      tip.hidden = false;
      const left = Math.min(Math.max(bx - 80, 0), Math.max(0, width - tip.offsetWidth));
      tip.style.left = `${left}px`;
      tip.style.top = `${Math.max(0, by - 44)}px`;
    });
    hit.addEventListener('pointerleave', () => {
      cross.setAttribute('visibility', 'hidden');
      focus.setAttribute('visibility', 'hidden');
      tip.hidden = true;
    });

    svgHost.replaceChildren(svg);
  }

  return wrap;
}

export interface LegendItem {
  cls: string;
  label: string;
  /** Makes the entry a toggle button (aria-pressed) that shows or hides a series. */
  toggle?: { pressed: boolean; onToggle: (pressed: boolean) => void };
}

export function chartLegend(items: LegendItem[]): HTMLElement {
  return h(
    'ul',
    { class: 'legend' },
    ...items.map((i) => {
      const key = h('span', { class: `key key-${i.cls}`, 'aria-hidden': 'true' });
      if (!i.toggle) return h('li', {}, key, i.label);
      const t = i.toggle;
      const b = h(
        'button',
        { type: 'button', class: 'legend-toggle', 'aria-pressed': String(t.pressed) },
        key,
        i.label,
      );
      b.addEventListener('click', () => {
        const next = b.getAttribute('aria-pressed') !== 'true';
        b.setAttribute('aria-pressed', String(next));
        t.onToggle(next);
      });
      return h('li', {}, b);
    }),
  );
}
