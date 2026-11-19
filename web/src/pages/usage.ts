// Usage page (SPEC 8.5): tokens per day and per hour stacked by plan and model, runs per day by
// agent kind, a table by plan and model (also the chart's table view) and cost notes.

import './agents.css'; // shared: sr-only, filters, status chips
import './plans.css'; // shared: table.data, .table-scroll, figure.chart
import './usage.css';
import { api, type PublicConfig } from '../api.ts';
import { h } from '../dom.ts';
import { linear, responsive, s, fix } from '../charts/svg.ts';
import {
  dayLabel,
  fmtFull,
  fmtTokens,
  hourLabel,
  labelEvery,
  layers,
  measureOf,
  measureSeries,
  MAX_SLOTS,
  MEASURES,
  niceMax,
  seriesLabel,
  stack,
  summaryText,
  type Layer,
  type Measure,
  type Usage,
} from './usage-logic.ts';

const REFRESH_MS = 60_000;
const DAY_CHOICES = [7, 14, 30];

interface Ctx {
  config: PublicConfig | null;
  title: string;
}

interface BarSpec {
  id: string;
  /** Read by screen readers instead of the bars; the tables carry the numbers. */
  label: string;
  layers: Layer[];
  ticks: string[];
  tips: string[];
  minLabelPx: number;
  fmt: (n: number) => string;
  integer?: boolean;
  height: number;
}

/** A stacked bar chart, redrawn on resize, with a per-bar tooltip. */
function barChart(spec: BarSpec): HTMLElement {
  const host = h('div', { class: 'chart-svg' });
  const tip = h('div', { class: 'usage-tip', role: 'presentation', hidden: true });
  const fig = h('figure', { class: 'chart usage-chart', id: spec.id }, host, tip);
  const n = spec.ticks.length;
  const stacked = stack(spec.layers, n);
  const peak = Math.max(0, ...stacked.map((b) => b.total));
  const { max, step } = niceMax(peak, 4, spec.integer ? 1 : 0);
  const names = new Map(spec.layers.map((l) => [l.key, l.label]));

  responsive(host, (width) => {
    const H = spec.height;
    const left = 44;
    const right = 6;
    const top = 8;
    const bottom = 22;
    const plotW = Math.max(10, width - left - right);
    const y = linear([0, max], [H - bottom, top]);
    const band = plotW / Math.max(1, n);
    const gap = band > 8 ? Math.min(6, band * 0.25) : band > 3 ? 1 : 0;
    const barW = Math.max(1, band - gap);
    const every = labelEvery(n, plotW, spec.minLabelPx);

    const grid = s('g', { class: 'grid', 'aria-hidden': 'true' });
    for (let v = 0; v <= max + 1e-9; v += step) {
      const yy = fix(y(v));
      grid.append(
        s('line', { x1: left, x2: width - right, y1: yy, y2: yy }),
        s('text', { x: left - 6, y: yy + 4, 'text-anchor': 'end' }, spec.fmt(v)),
      );
    }
    for (let i = 0; i < n; i++) {
      // Label from the right so the newest bucket is always labelled.
      if ((n - 1 - i) % every) continue;
      grid.append(
        s(
          'text',
          { x: fix(left + band * i + band / 2), y: H - 6, 'text-anchor': 'middle' },
          spec.ticks[i] ?? '',
        ),
      );
    }

    const bars = s('g', { class: 'bars' });
    const hits = s('g', { class: 'hits' });
    stacked.forEach((b, i) => {
      const x = left + band * i + gap / 2;
      b.segments.forEach((seg, j) => {
        const y0 = y(seg.y0);
        const y1 = y(seg.y1);
        // A 1px surface gap between stacked segments; the top segment gets round ends.
        const hgt = Math.max(0.5, y0 - y1 - (j < b.segments.length - 1 ? 1 : 0));
        bars.append(
          s('rect', {
            class: `seg slot-${seg.slot}`,
            x: fix(x),
            y: fix(y0 - hgt),
            width: fix(barW),
            height: fix(hgt),
            rx: j === b.segments.length - 1 && barW >= 6 ? 2 : 0,
            'data-key': seg.key,
          }),
        );
      });
      hits.append(
        s('rect', {
          class: 'hit',
          x: fix(left + band * i),
          y: top,
          width: fix(band),
          height: H - bottom - top,
          'data-i': i,
        }),
      );
    });

    const svg = s(
      'svg',
      {
        width,
        height: H,
        viewBox: `0 0 ${width} ${H}`,
        role: 'img',
        'aria-label': spec.label,
      },
      grid,
      s('line', {
        class: 'baseline',
        x1: left,
        x2: width - right,
        y1: H - bottom,
        y2: H - bottom,
        'aria-hidden': 'true',
      }),
      bars,
      hits,
    );
    host.replaceChildren(svg);

    const show = (i: number) => {
      const b = stacked[i];
      if (!b) return;
      tip.replaceChildren(
        h('b', {}, spec.tips[i] ?? ''),
        h('span', { class: 'tip-total' }, `Total ${spec.fmt(b.total)}`),
        ...[...b.segments]
          .reverse()
          .map((seg) =>
            h(
              'span',
              { class: 'tip-row' },
              h('i', { class: `sw slot-${seg.slot}`, 'aria-hidden': 'true' }),
              `${names.get(seg.key) ?? seg.key}: ${spec.fmt(seg.y1 - seg.y0)}`,
            ),
          ),
      );
      if (!b.segments.length) tip.append(h('span', { class: 'muted' }, 'Nothing'));
      tip.hidden = false;
      const cx = left + band * i + band / 2;
      const tw = tip.offsetWidth;
      tip.style.left = `${Math.max(0, Math.min(width - tw, cx - tw / 2))}px`;
      tip.style.top = `${Math.max(0, y(b.total) - tip.offsetHeight - 8)}px`;
      for (const r of hits.children) r.classList.toggle('on', r.getAttribute('data-i') === `${i}`);
    };
    const hide = () => {
      tip.hidden = true;
      for (const r of hits.children) r.classList.remove('on');
    };
    hits.addEventListener('pointerover', (ev) => {
      const i = (ev.target as Element).getAttribute('data-i');
      if (i !== null) show(Number(i));
    });
    svg.addEventListener('pointerleave', hide);
  });
  return fig;
}

function legend(ls: Layer[], label: string): HTMLElement {
  return h(
    'ul',
    { class: 'usage-legend', 'aria-label': label },
    ...ls.map((l) =>
      h('li', {}, h('i', { class: `sw slot-${l.slot}`, 'aria-hidden': 'true' }), l.label),
    ),
  );
}

function panel(id: string, title: string, ...body: (HTMLElement | null)[]): HTMLElement {
  return h(
    'section',
    { class: 'box usage-panel', id, 'aria-labelledby': `${id}-title` },
    h('h2', { id: `${id}-title`, class: 'box-h' }, title),
    ...body,
  );
}

export function mountUsage(main: HTMLElement, ctx: Ctx): () => void {
  let stopped = false;
  let timer: number | undefined;
  let days = 14;
  let measure: Measure = 'io';
  let data: Usage | null = null;

  const summary = h('p', { class: 'arrives', id: 'usage-summary', 'aria-live': 'polite' });
  const refresh = h('button', { type: 'button', id: 'usage-refresh', class: 'ghost' }, 'Refresh');
  const head = h(
    'div',
    { class: 'page-head' },
    h('h1', { id: 'page-title', tabindex: '-1' }, ctx.title),
    summary,
    refresh,
  );

  const rangeSel = h(
    'select',
    { id: 'usage-days' },
    ...DAY_CHOICES.map((d) =>
      h('option', { value: String(d), selected: d === days }, `Last ${d} days`),
    ),
  );
  const measureGroup = h(
    'fieldset',
    { class: 'seg-group', id: 'usage-measure' },
    h('legend', {}, 'Tokens counted'),
    ...MEASURES.map(([value, label]) =>
      h(
        'label',
        {},
        h('input', {
          type: 'radio',
          name: 'usage-measure',
          value,
          checked: value === measure,
        }),
        h('span', {}, label),
      ),
    ),
  );
  const bar = h(
    'form',
    { class: 'filters usage-filters', 'aria-label': 'Usage options' },
    h('div', { class: 'field' }, h('label', { for: 'usage-days' }, 'Range'), rangeSel),
    measureGroup,
  );
  const body = h('div', { class: 'usage-body' }, h('p', { class: 'muted' }, 'Loading…'));
  main.replaceChildren(head, bar, body);

  bar.addEventListener('submit', (ev) => ev.preventDefault());
  rangeSel.addEventListener('change', () => {
    days = Number(rangeSel.value);
    void load();
  });
  measureGroup.addEventListener('change', (ev) => {
    measure = (ev.target as HTMLInputElement).value as Measure;
    render();
  });
  refresh.addEventListener('click', () => void load());

  function render(): void {
    if (!data) return;
    const u = data;
    const tz = u.timezone;
    summary.textContent = summaryText(u, measure);
    const info = u.series.map((x) => ({ key: x.key, label: seriesLabel(x) }));
    const dayLayers = layers(
      info,
      u.daily.series.map((x) => ({ key: x.key, values: measureSeries(x, measure) })),
      u.daily.buckets.length,
    );
    const hourLayers = layers(
      info,
      u.hourly.series.map((x) => ({ key: x.key, values: measureSeries(x, measure) })),
      u.hourly.buckets.length,
    );
    // Colors follow the series key across both token charts: use the daily slots for both.
    const slotOf = new Map(dayLayers.map((l) => [l.key, l.slot]));
    for (const l of hourLayers) l.slot = slotOf.get(l.key) ?? MAX_SLOTS;
    const what = measure === 'io' ? 'input and output tokens' : 'all tokens, with cache';

    const empty = !u.series.length;
    const dayTicks = u.daily.buckets.map((d) => dayLabel(d));
    const dayTips = u.daily.buckets.map((d) => dayLabel(d, true));
    const tokensDay = panel(
      'usage-daily',
      'Tokens per day',
      empty
        ? h('p', { class: 'muted' }, `No runs reported token counts in the last ${u.days} days.`)
        : null,
      empty ? null : legend(dayLayers, 'Plan and model'),
      empty
        ? null
        : barChart({
            id: 'usage-daily-chart',
            label: `Stacked bars: ${what} per day for the last ${u.days} days, by plan and model. The table below has the totals.`,
            layers: dayLayers,
            ticks: dayTicks,
            tips: dayTips,
            minLabelPx: 44,
            fmt: fmtTokens,
            height: 200,
          }),
    );
    const tokensHour = panel(
      'usage-hourly',
      `Tokens per hour, last ${u.hours} h`,
      hourLayers.length ? legend(hourLayers, 'Plan and model') : null,
      hourLayers.length
        ? barChart({
            id: 'usage-hourly-chart',
            label: `Stacked bars: ${what} per hour for the last ${u.hours} hours (${tz}), by plan and model.`,
            layers: hourLayers,
            ticks: u.hourly.buckets.map((b) => hourLabel(b, tz)),
            tips: u.hourly.buckets.map((b) => hourLabel(b, tz, true)),
            minLabelPx: 48,
            fmt: fmtTokens,
            height: 160,
          })
        : h('p', { class: 'muted' }, `No tokens in the last ${u.hours} hours.`),
    );

    const kindLayers = layers(
      u.runs_per_day.by_kind.map((k) => ({ key: k.agent_kind, label: k.agent_kind })),
      u.runs_per_day.by_kind.map((k) => ({ key: k.agent_kind, values: k.counts })),
      u.runs_per_day.buckets.length,
    );
    const totalRuns = kindLayers.reduce((a, l) => a + l.total, 0);
    const runsDay = panel(
      'usage-runs',
      'Runs per day',
      totalRuns ? legend(kindLayers, 'Agent kind') : null,
      totalRuns
        ? barChart({
            id: 'usage-runs-chart',
            label: `Stacked bars: runs started per day for the last ${u.days} days, by agent kind. ${totalRuns} in total.`,
            layers: kindLayers,
            ticks: dayTicks,
            tips: dayTips,
            minLabelPx: 44,
            fmt: (v) => String(Math.round(v)),
            integer: true,
            height: 140,
          })
        : h('p', { class: 'muted' }, 'No runs started in this range.'),
    );

    const table = h(
      'div',
      { class: 'table-scroll', tabindex: '0', 'aria-labelledby': 'usage-table-title' },
      h(
        'table',
        { class: 'data usage-table' },
        h(
          'thead',
          {},
          h(
            'tr',
            {},
            ...['Plan', 'Model', 'Runs', 'In', 'Out', 'Cache read', 'Cache write', 'Counted'].map(
              (x, i) => h('th', { scope: 'col', class: i >= 2 ? 'num' : null }, x),
            ),
          ),
        ),
        h(
          'tbody',
          {},
          ...u.series.map((x) =>
            h(
              'tr',
              { 'data-key': x.key },
              h(
                'th',
                { scope: 'row' },
                h('i', {
                  class: `sw slot-${slotOf.get(x.key) ?? 8}`,
                  'aria-hidden': 'true',
                }),
                x.plan_name,
              ),
              h('td', {}, x.model),
              h('td', { class: 'num' }, x.runs),
              h('td', { class: 'num' }, fmtFull(x.tokens.in)),
              h('td', { class: 'num' }, fmtFull(x.tokens.out)),
              h('td', { class: 'num' }, fmtFull(x.tokens.cache_read)),
              h('td', { class: 'num' }, fmtFull(x.tokens.cache_write)),
              h('td', { class: 'num strong' }, fmtFull(measureOf(x.tokens, measure))),
            ),
          ),
        ),
      ),
    );
    const byPlan = panel(
      'usage-table',
      'By plan and model',
      empty ? h('p', { class: 'muted' }, 'Nothing to total yet.') : table,
      h(
        'p',
        { class: 'muted small' },
        `Token totals are spread evenly over the hours each run was open. "Counted" is ${what}.`,
        u.runs_without_tokens
          ? ` ${u.runs_without_tokens} run${u.runs_without_tokens === 1 ? '' : 's'} reported no token counts.`
          : '',
      ),
    );

    const notes = panel(
      'usage-notes',
      'Cost notes',
      u.cost_notes.length
        ? h(
            'ul',
            { class: 'cost-notes' },
            ...u.cost_notes.map((c) =>
              h(
                'li',
                {},
                h(
                  'time',
                  { datetime: c.started_at, class: 'muted' },
                  new Intl.DateTimeFormat('en-US', {
                    timeZone: tz,
                    month: 'short',
                    day: 'numeric',
                    hour: '2-digit',
                    minute: '2-digit',
                    hourCycle: 'h23',
                  }).format(new Date(c.started_at)),
                ),
                h(
                  'span',
                  { class: 'who' },
                  `${c.agent_kind}${c.model ? ` · ${c.model}` : ''} · run ${c.run_id}`,
                ),
                h('span', { class: 'note' }, c.note),
              ),
            ),
          )
        : h(
            'p',
            { class: 'muted' },
            'No cost notes. Agents can add one with ',
            h('code', {}, 'cost_note'),
            ' when they report a run.',
          ),
    );

    body.replaceChildren(
      h(
        'div',
        { class: 'usage-grid' },
        h('div', { class: 'usage-col' }, tokensDay, byPlan),
        h('div', { class: 'usage-col' }, tokensHour, runsDay, notes),
      ),
    );
  }

  async function load(): Promise<void> {
    window.clearTimeout(timer);
    try {
      data = await api<Usage>(`/usage?days=${days}&hours=48`);
      if (stopped) return;
      render();
    } catch (err) {
      if (stopped) return;
      body.replaceChildren(
        h('p', { class: 'error' }, `Could not load usage: ${(err as Error).message}`),
      );
    }
    if (!stopped) timer = window.setTimeout(() => void load(), REFRESH_MS);
  }
  void load();

  return () => {
    stopped = true;
    window.clearTimeout(timer);
  };
}
