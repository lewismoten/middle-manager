// A plan window chart: used % over the window with the even-pace line, the projection at the
// recent rate, the target-empty marker and a "now" line. Inline SVG, redrawn on resize, with a
// hover crosshair that reads out the nearest reading.

import { h } from '../dom.ts';
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
  /** Project from the last reading at this rate (% per hour). */
  projectionRate?: number;
  /** When the plan should reach 100% (reset minus the buffer). */
  targetEmpty?: number;
  ticks: 'day' | 'hour';
  timeZone?: string;
  height?: number;
}

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

/** Where the projection line ends: the reset, or the moment it reaches 100%. */
export function projectionEnd(
  last: ChartPoint,
  rate: number,
  end: number,
): { t: number; used: number; runsOut: boolean } {
  const atEnd = last.used + (rate * (end - last.t)) / HOUR;
  if (rate > 0 && atEnd > 100) {
    return { t: last.t + ((100 - last.used) / rate) * HOUR, used: 100, runsOut: true };
  }
  return { t: end, used: Math.max(0, atEnd), runsOut: false };
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
    if (last && spec.projectionRate !== undefined) {
      const p = projectionEnd(last, spec.projectionRate, spec.end);
      svg.append(
        s('line', {
          class: 'proj',
          x1: fix(x(last.t)),
          y1: fix(y(last.used)),
          x2: fix(x(p.t)),
          y2: fix(y(p.used)),
        }),
      );
      if (p.runsOut) {
        svg.append(s('circle', { class: 'runs-out', cx: fix(x(p.t)), cy: fix(y(100)), r: 4 }));
      }
    }

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
        h('b', {}, `${best.used.toFixed(1)}% used`),
        ` · ${tf.format(new Date(best.t))}`,
        best.note ? h('span', { class: 'muted' }, ` · ${best.note}`) : '',
      );
      tip.hidden = false;
      const left = Math.min(Math.max(bx - 80, 0), width - 170);
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

export function chartLegend(items: { cls: string; label: string }[]): HTMLElement {
  return h(
    'ul',
    { class: 'legend' },
    ...items.map((i) =>
      h('li', {}, h('span', { class: `key key-${i.cls}`, 'aria-hidden': 'true' }), i.label),
    ),
  );
}
