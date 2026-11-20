// A plan window chart: used % over the window with the even-pace line, the projection at the
// recent rate, the 1 h / 2 h projections, the target-empty marker and a "now" line. Inline SVG,
// redrawn on resize, with a hover crosshair that reads out the nearest reading and where each
// projection ends.

import { h } from '../dom.ts';
import { projectionSegment } from './projection-geometry.ts';
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
  /** When the plan should reach 100% (reset minus the buffer). */
  targetEmpty?: number;
  ticks: 'day' | 'hour';
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
    const m = { l: 40, r: 14, t: 18, b: 26 };
    const x = linear([spec.start, spec.end], [m.l, width - m.r]);
    const y = linear([0, 100], [height - m.b, m.t]);
    const svg = s('svg', {
      width,
      height,
      viewBox: `0 0 ${width} ${height}`,
      role: 'img',
      'aria-label': spec.label,
    });

    const grid = s('g', { class: 'grid' });
    for (const v of [0, 25, 50, 75, 100]) {
      grid.append(
        s('line', { x1: m.l, x2: width - m.r, y1: fix(y(v)), y2: fix(y(v)) }),
        s('text', { x: m.l - 6, y: fix(y(v)) + 4, 'text-anchor': 'end' }, `${v}%`),
      );
    }
    const tk = ticks(spec, width);
    const every = Math.max(1, Math.ceil((tk.length * 44) / (width - m.l - m.r)));
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
      if (i % every === 0) {
        grid.append(s('text', { x: fix(x(tick.t)) + 3, y: height - 8 }, tick.label));
      }
    });
    svg.append(grid);

    // Even pace: 0% at the start to 100% at the reset.
    svg.append(
      s('line', {
        class: 'even',
        x1: x(spec.start),
        y1: y(0),
        x2: x(spec.end),
        y2: y(100),
      }),
    );

    if (spec.targetEmpty !== undefined && spec.targetEmpty > spec.start) {
      const tx = fix(x(spec.targetEmpty));
      const ty = fix(y(100));
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

    if (spec.now > spec.start && spec.now < spec.end) {
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

    const pts = spec.points;
    const last = pts[pts.length - 1];
    const p = spec.projection;
    const seg = last && p ? projectionSegment(spec, last.used, p) : null;
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
    const segs = shorts.map((sp) => projectionSegment(spec, (last as ChartPoint).used, sp));
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

    if (pts.length) {
      const line: [number, number][] = [
        [x(spec.start), y(0)],
        ...pts.map((p): [number, number] => [x(p.t), y(p.used)]),
      ];
      svg.append(s('polyline', { class: 'used', points: points(line) }));
      if (pts.length <= 40) {
        const dots = s('g', { class: 'dots' });
        for (const p of pts)
          dots.append(s('circle', { cx: fix(x(p.t)), cy: fix(y(p.used)), r: 3.5 }));
        svg.append(dots);
      }
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
