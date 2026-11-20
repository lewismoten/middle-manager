// Burndown: per plan, the weekly chart (readings, even pace, projection, now, target empty), a
// week picker for past weeks, overlays of other weeks to compare ("Compare with", aligned by
// time since window start), the 5-hour window when the plan reports one, a past-weeks table and
// a pacing table for every plan. The picked week and comparison live in the URL
// (#/burndown?plan=&week=&compare=&avg=); the comparison is also remembered in localStorage.

import { h } from '../dom.ts';
import { gauge } from '../charts/gauge.ts';
import {
  chartLegend,
  windowChart,
  type ChartPoint,
  type LegendItem,
  type Overlay,
} from '../charts/window-chart.ts';
import {
  burnForecastLine,
  paceDifferenceLine,
  recentRateLabel,
  fmtDate,
  fmtTime,
  getPace,
  getReadings,
  getWindow,
  getWindows,
  modeBadge,
  pct,
  rate,
  readingAge,
  refreshWhileShown,
  shortOutcome,
  shortProjections,
  shortProjectionsLine,
  until,
  type PaceResponse,
  type PlanPace,
  type Reading,
  type WeeklyPace,
  type WindowDetail,
} from '../plans.ts';
import {
  alignSeries,
  AVERAGE_DASH,
  averageSeries,
  averageWindows,
  compareWindows,
  hours,
  OVERLAY_DASHES,
  overlayLabel,
  overlayShortLabel,
  parseCompare,
  parseState,
  PARTIAL_GAP_MS,
  rangeLabel,
  stateHash,
  targetText,
  type BurndownState,
  type CompareMode,
  type SeriesPoint,
  type Span,
  type WindowSummary,
} from './past-weeks-logic.ts';
import './plans.css';

const PLAN_KEY = 'mm.burndown.plan';
const SHORT_KEY = 'mm.burndown.shortProjections';

/** Which 1 h / 2 h projection lines are shown; both by default. */
function savedShort(): Record<string, boolean> {
  try {
    const v = JSON.parse(localStorage.getItem(SHORT_KEY) ?? '{}') as unknown;
    return v && typeof v === 'object' ? (v as Record<string, boolean>) : {};
  } catch {
    return {};
  }
}

function saveShort(key: string, shown: boolean): void {
  try {
    localStorage.setItem(SHORT_KEY, JSON.stringify({ ...savedShort(), [key]: shown }));
  } catch {
    /* storage unavailable */
  }
}
const HOUR = 3600_000;

function savedPlan(): string | null {
  try {
    return localStorage.getItem(PLAN_KEY);
  } catch {
    return null;
  }
}

function savePlan(id: string): void {
  try {
    localStorage.setItem(PLAN_KEY, id);
  } catch {
    /* storage unavailable */
  }
}

const toPoints = (rs: Reading[]): ChartPoint[] =>
  rs.map((r) => ({
    t: new Date(r.read_at).getTime(),
    used: r.used_pct,
    note: [r.machine_id, r.how].filter(Boolean).join(' · '),
  }));

function pacingTable(pace: PaceResponse, tz: string | undefined, now: number): HTMLElement {
  const head = [
    'Plan',
    'Mode',
    'Used',
    'Even pace',
    'Recent rate',
    'Needed rate',
    'Projected',
    'Suggested model',
    'Resets',
    'Last reading',
  ];
  const rows = pace.plans.map((p) => {
    const w = p.weekly;
    if (!w) {
      return h(
        'tr',
        {},
        h('th', { scope: 'row' }, p.name),
        h('td', { colspan: head.length - 1, class: 'muted' }, 'No weekly readings yet'),
      );
    }
    return h(
      'tr',
      { 'data-plan': p.plan },
      h('th', { scope: 'row' }, p.name),
      h('td', {}, modeBadge(w.mode)),
      h('td', { class: 'num' }, pct(w.used_pct, 1)),
      h('td', { class: 'num' }, pct(w.even_pace_pct)),
      h('td', { class: 'num' }, recentRateLabel(w)),
      h('td', { class: 'num' }, rate(w.need_pct_per_h)),
      h('td', { class: 'num' }, pct(w.projected_pct), burnForecastLine(w)),
      h('td', {}, w.suggested_model ?? (w.mode === 'stop' ? 'none new' : '—')),
      h('td', { title: fmtDate(w.reset_at, tz) }, w.current ? until(w.reset_at, now) : 'passed'),
      h('td', { title: fmtDate(w.last_reading_at, tz) }, readingAge(w, now)),
    );
  });
  return h(
    'section',
    { class: 'box', 'aria-labelledby': 'pacing-title' },
    h('h2', { id: 'pacing-title', class: 'box-h' }, 'Pacing'),
    h(
      'div',
      { class: 'table-scroll', tabindex: '0', 'aria-labelledby': 'pacing-title' },
      h(
        'table',
        { class: 'data pacing' },
        h(
          'thead',
          {},
          h(
            'tr',
            {},
            ...head.map((x, i) =>
              h('th', { scope: 'col', class: i >= 2 && i <= 6 ? 'num' : null }, x),
            ),
          ),
        ),
        h('tbody', {}, ...rows),
      ),
    ),
    h(
      'p',
      { class: 'muted small' },
      'Target: each plan runs out just before its reset (reset minus the buffer). Burn = recent rate under 75% of needed; conserve = over 125%; stop = 97% used. Burn suggests the top model rung, conserve the bottom.',
    ),
  );
}

async function fiveHourBox(
  p: PlanPace,
  tz: string | undefined,
  now: number,
): Promise<HTMLElement | null> {
  const r = p.five_hour;
  if (!r) return null;
  const box = h(
    'section',
    { class: 'box five-hour', 'aria-labelledby': 'five-title' },
    h('h2', { id: 'five-title', class: 'box-h' }, '5-hour window'),
  );
  const reset = r.resets_at ? new Date(r.resets_at).getTime() : null;
  const live = reset !== null && reset > now;
  box.append(
    h(
      'p',
      { class: 'pg-big' },
      h('b', {}, pct(live ? r.used_pct : 0)),
      h(
        'span',
        { class: 'muted' },
        live && r.resets_at ? ` used, resets ${until(r.resets_at, now)}` : ' (window has reset)',
      ),
    ),
  );
  if (live && reset !== null) {
    const start = reset - 5 * HOUR;
    const rs = await getReadings(p.plan, {
      window: 'five_hour',
      since: new Date(start).toISOString(),
    }).catch(() => ({ readings: [] as Reading[] }));
    const pts = toPoints(
      rs.readings.filter(
        (x) => x.resets_at && Math.abs(new Date(x.resets_at).getTime() - reset) < HOUR,
      ),
    );
    if (pts.length >= 2) {
      box.append(
        windowChart({
          label: `${p.name} 5-hour window: ${pct(r.used_pct)} used`,
          start,
          end: reset,
          now,
          points: pts,
          ticks: 'hour',
          timeZone: tz,
          height: 110,
        }),
      );
    } else {
      const even = Math.min(100, Math.max(0, ((now - start) / (5 * HOUR)) * 100));
      box.append(
        gauge({
          used: r.used_pct,
          evenPace: even,
          projected: r.used_pct,
          label: `${pct(r.used_pct)} used, even pace ${pct(even)}`,
        }),
      );
    }
  }
  box.append(h('p', { class: 'muted small' }, `Reading ${fmtTime(r.read_at, tz)}`));
  return box;
}

// ---- Weeks: picking a window, comparing with other weeks, the past-weeks table ----

const COMPARE_KEY = 'mm.burndown.compare';

function savedCompare(): { compare: CompareMode; avg: boolean } {
  try {
    const v = JSON.parse(localStorage.getItem(COMPARE_KEY) ?? '{}') as {
      compare?: string;
      avg?: boolean;
    };
    return { compare: parseCompare(v.compare), avg: v.avg === true };
  } catch {
    return { compare: 'none', avg: false };
  }
}

function saveCompare(compare: CompareMode, avg: boolean): void {
  try {
    localStorage.setItem(COMPARE_KEY, JSON.stringify({ compare, avg }));
  } catch {
    /* storage unavailable */
  }
}

/** Finished windows never change, so their readings are fetched once per page load. */
const detailCache = new Map<string, Promise<WindowDetail>>();

function windowDetail(plan: string, w: WindowSummary): Promise<WindowDetail> {
  const key = `${plan}|${w.id}`;
  if (w.current) return getWindow(plan, w.id);
  let p = detailCache.get(key);
  if (!p) {
    p = getWindow(plan, w.id);
    p.catch(() => detailCache.delete(key));
    detailCache.set(key, p);
  }
  return p;
}

/** Legend toggles for overlays (by window id, or "avg"); kept while the page is open. */
const hiddenOverlays = new Set<string>();

interface WeekView {
  plan: PlanPace;
  windows: WindowSummary[];
  /** The shown window from the list (null for the current week before it is listed). */
  shown: WindowSummary | null;
  isCurrent: boolean;
  state: BurndownState;
  tz: string | undefined;
  now: number;
  /** Show a week; `focus` lists selectors to focus after the redraw (first enabled wins). */
  go: (week: string, focus?: [string, string]) => void;
  set: (patch: Partial<BurndownState>, focus?: [string, string]) => void;
}

const toSeries = (rs: { read_at: string; used_pct: number }[]): SeriesPoint[] =>
  rs.map((r) => ({ t: Date.parse(r.read_at), used: r.used_pct }));

const range = (w: WindowSummary, tz?: string, compact = false) =>
  rangeLabel(Date.parse(w.start), Date.parse(w.reset_at), tz, compact);

/** Prev / week picker / Next, and "Compare with" + the average toggle. */
function weekControls(v: WeekView): HTMLElement {
  const past = v.windows.filter((w) => !w.current);
  const current = v.windows.find((w) => w.current);
  const order = ['current', ...past.map((w) => w.id)];
  const at = Math.max(0, order.indexOf(v.isCurrent ? 'current' : (v.shown?.id ?? 'current')));
  const older = order[at + 1];
  const newer = at > 0 ? order[at - 1] : undefined;

  const pick = h(
    'select',
    { id: 'week-pick', 'aria-label': 'Week to show' },
    h('option', { value: 'current' }, current ? `Current (${range(current, v.tz)})` : 'Current'),
    ...past.map((w) =>
      h('option', { value: w.id }, `${range(w, v.tz)}${w.partial ? ' (partial)' : ''}`),
    ),
  );
  pick.value = order[at] as string;
  pick.addEventListener('change', () => v.go(pick.value, ['#week-pick', '#week-pick']));

  const prev = h(
    'button',
    {
      type: 'button',
      class: 'week-prev',
      disabled: !older,
      'aria-keyshortcuts': '[',
      title: 'Previous week ([ key)',
    },
    '‹ Prev week',
  );
  const next = h(
    'button',
    {
      type: 'button',
      class: 'week-next',
      disabled: !newer,
      'aria-keyshortcuts': ']',
      title: 'Next week (] key)',
    },
    'Next week ›',
  );
  prev.addEventListener('click', () => older && v.go(older, ['.week-prev', '.week-next']));
  next.addEventListener('click', () => newer && v.go(newer, ['.week-next', '.week-prev']));

  const shownId = v.shown?.id ?? (v.isCurrent ? 'current' : '');
  const choices = v.windows.filter((w) => w.id !== shownId);
  const olderCount = compareWindows(v.windows, shownId, 'last4').length;
  const compare = h(
    'select',
    { id: 'week-compare' },
    h('option', { value: 'none' }, 'None'),
    h('option', { value: 'last', disabled: olderCount < 1 }, 'Last week'),
    ...[2, 3, 4].map((n) =>
      h('option', { value: `last${n}`, disabled: olderCount < n }, `Last ${n} weeks`),
    ),
    choices.length
      ? h(
          'optgroup',
          { label: 'A chosen week' },
          ...choices.map((w) =>
            h(
              'option',
              { value: `week:${w.id}` },
              w.current ? `Current (${range(w, v.tz)})` : range(w, v.tz),
            ),
          ),
        )
      : null,
  );
  compare.value = v.state.compare;
  if (compare.value !== v.state.compare) compare.value = 'none';
  compare.addEventListener('change', () =>
    v.set({ compare: parseCompare(compare.value) }, ['#week-compare', '#week-compare']),
  );

  const avgAvailable = averageWindows(v.windows, shownId).length >= 2;
  const avg = h('input', {
    type: 'checkbox',
    id: 'week-avg',
    checked: v.state.avg && avgAvailable,
    disabled: !avgAvailable,
  });
  avg.addEventListener('change', () => v.set({ avg: avg.checked }, ['#week-avg', '#week-avg']));

  return h(
    'div',
    { class: 'week-controls' },
    h('div', { class: 'week-nav', role: 'group', 'aria-label': 'Week' }, prev, pick, next),
    h(
      'div',
      { class: 'week-compare' },
      h('label', { for: 'week-compare' }, 'Compare with'),
      compare,
      h(
        'label',
        {
          class: 'check',
          title: avgAvailable
            ? 'Average of up to 4 finished weeks before this one'
            : 'Needs at least 2 finished weeks before this one',
        },
        avg,
        ' Average of past weeks',
      ),
    ),
  );
}

interface OverlayBuild {
  overlays: Overlay[];
  legend: LegendItem[];
  notes: string[];
}

/** The overlays for the shown window, aligned onto its time axis. */
async function buildOverlays(v: WeekView, dst: Span): Promise<OverlayBuild> {
  const out: OverlayBuild = { overlays: [], legend: [], notes: [] };
  const empty = () => {
    if (v.state.compare !== 'none' && !out.overlays.some((o) => o.key !== 'avg')) {
      out.notes.unshift('No other week to compare with yet.');
    }
    return out;
  };
  const shownId = v.shown?.id ?? (v.isCurrent ? 'current' : '');
  const picks = compareWindows(v.windows, shownId, v.state.compare);
  const avgFrom = v.state.avg ? averageWindows(v.windows, shownId) : [];
  const need = [...new Map([...picks, ...avgFrom].map((w) => [w.id, w])).values()];
  const details = new Map<string, WindowDetail>();
  await Promise.all(
    need.map(async (w) => {
      try {
        details.set(w.id, await windowDetail(v.plan.plan, w));
      } catch {
        /* a week that failed to load is left out */
      }
    }),
  );
  const aligned = (w: WindowSummary) => {
    const d = details.get(w.id);
    if (!d) return null;
    return alignSeries(
      toSeries(d.readings),
      { start: Date.parse(w.start), end: Date.parse(w.reset_at) },
      dst,
    );
  };
  const dstH = (dst.end - dst.start) / 3600_000;
  picks.forEach((w, i) => {
    const a = aligned(w);
    if (!a || !a.points.length) return;
    const label = overlayLabel(w, v.tz);
    const name = range(w, v.tz, true);
    out.overlays.push({
      key: w.id,
      label,
      short: overlayShortLabel(w, v.tz),
      name,
      points: a.points,
      dash: OVERLAY_DASHES[i % OVERLAY_DASHES.length] as string,
      slot: i,
    });
    out.legend.push(overlayLegend(`ov-${i}`, name, w.id));
    if (a.scaled) {
      out.notes.push(
        `${name} was ${Math.round(a.length_h)} h long; it is scaled to this ${Math.round(dstH)} h window by the share of the window gone.`,
      );
    }
    if (!a.fromZero)
      out.notes.push(
        `${name} has no readings from its first ${hours((a.points[0]!.t - dst.start) / 3600_000)}.`,
      );
  });
  if (avgFrom.length >= 2) {
    const series = avgFrom.map(aligned).filter((a): a is NonNullable<typeof a> => !!a);
    const pts = averageSeries(
      series.map((a) => a.points),
      dst,
    );
    const last = pts[pts.length - 1];
    if (last) {
      out.overlays.push({
        key: 'avg',
        label: `Avg of ${series.length} weeks: ${Math.round(last.used)}%`,
        short: `Avg: ${Math.round(last.used)}%`,
        name: `Average of ${series.length} weeks`,
        points: pts,
        dash: AVERAGE_DASH,
        slot: 'avg',
      });
      out.legend.push(overlayLegend('ov-avg', `Average of ${series.length} past weeks`, 'avg'));
      if (series.some((a) => a.scaled) && !out.notes.some((n) => n.includes('scaled'))) {
        out.notes.push('Weeks of a different length are scaled by the share of the window gone.');
      }
    }
  }
  return empty();
}

function overlayLegend(cls: string, label: string, key: string): LegendItem {
  return {
    cls,
    label,
    toggle: {
      pressed: !hiddenOverlays.has(key),
      onToggle: (on) => {
        if (on) hiddenOverlays.delete(key);
        else hiddenOverlays.add(key);
        document
          .querySelectorAll(`.weekly [data-overlay="${CSS.escape(key)}"]`)
          .forEach((el) => el.classList.toggle('ov-hidden', !on));
      },
    },
  };
}

function weeklyHeader(v: WeekView): HTMLElement {
  const w = v.plan.weekly;
  return h(
    'div',
    { class: 'row' },
    h(
      'h2',
      { id: 'weekly-title', class: 'box-h' },
      v.isCurrent
        ? `${v.plan.name} · weekly window`
        : `${v.plan.name} · week of ${range(v.shown as WindowSummary, v.tz)}`,
    ),
    v.isCurrent ? (w ? modeBadge(w.mode) : null) : h('span', { class: 'past-badge' }, 'past week'),
  );
}

async function currentWeekly(v: WeekView, box: HTMLElement): Promise<void> {
  const p = v.plan;
  const w = p.weekly as WeeklyPace;
  const { tz, now } = v;
  const start = new Date(w.start).getTime();
  const end = new Date(w.reset_at).getTime();
  const [rs, ov] = await Promise.all([
    getReadings(p.plan, {
      window: 'weekly',
      since: new Date(start - 3 * HOUR).toISOString(),
    }),
    buildOverlays(v, { start, end }),
  ]);
  const pts = toPoints(
    rs.readings.filter(
      (x) => x.resets_at && Math.abs(new Date(x.resets_at).getTime() - end) < 3 * HOUR,
    ),
  );
  const shorts = shortProjections(w);
  const shown = savedShort();
  for (const sp of shorts) {
    const key = `${sp.window_h}h`;
    if (shown[key] === false) box.classList.add(`hide-proj-${key}`);
  }
  box.append(
    h(
      'p',
      { class: 'summary' },
      `Used ${pct(w.used_pct, 1)} (even pace ${pct(w.even_pace_pct)}), ${recentRateLabel(w)}, projected `,
      h('b', {}, pct(w.projected_pct)),
      ` at the reset ${fmtTime(w.reset_at, tz)}.`,
      w.runs_out_at
        ? h('span', { class: 'warn' }, ` Would run out ${fmtTime(w.runs_out_at, tz)}.`)
        : '',
      ' ',
      readingAge(w, now),
      h(
        'span',
        { title: `Since ${fmtDate(w.rate_24h_since, tz)}` },
        ` · Last 24 h: ${rate(w.rate_24h)}.`,
      ),
      paceDifferenceLine(w),
      burnForecastLine(w),
      shortProjectionsLine(w, tz),
    ),
    chartLegend([
      { cls: 'used', label: 'Readings' },
      { cls: 'even', label: 'Even pace' },
      { cls: 'proj', label: `Projection (last ${w.rate_basis_h} h)` },
      ...shorts.map((sp) => {
        const key = `${sp.window_h}h`;
        return {
          cls: `proj-${key}`,
          label: `Last ${sp.window_h} h rate`,
          toggle: {
            pressed: shown[key] !== false,
            onToggle: (on: boolean) => {
              box.classList.toggle(`hide-proj-${key}`, !on);
              saveShort(key, on);
            },
          },
        };
      }),
      { cls: 'target', label: `Target empty (${p.empty_buffer_hours} h before reset)` },
      { cls: 'now', label: 'Now' },
      ...ov.legend,
    ]),
    windowChart({
      label: `${p.name} weekly burndown: ${pct(w.used_pct)} used, even pace ${pct(w.even_pace_pct)}, projected ${pct(w.projected_pct)} at reset${ov.overlays.length ? `, compared with ${ov.overlays.map((o) => o.label).join(', ')}` : ''}`,
      start,
      end,
      now,
      points: pts,
      projection: {
        t: w.runs_out_at ? Date.parse(w.runs_out_at) : end,
        used: w.projected_pct,
        runsOut: w.runs_out_at !== null,
        readout: `Projection (last ${w.rate_basis_h} h): ${w.runs_out_at ? `runs out ${fmtTime(w.runs_out_at, tz)}` : `${pct(w.projected_pct)} at reset`}`,
      },
      shortProjections: shorts
        .filter((sp) => sp.projected_pct !== null)
        .map((sp) => ({
          key: `${sp.window_h}h`,
          tag: `${sp.window_h} h`,
          t: sp.runs_out_at ? Date.parse(sp.runs_out_at) : end,
          used: sp.runs_out_at ? 100 : (sp.projected_pct as number),
          runsOut: sp.runs_out_at !== null,
          readout: `Last ${sp.window_h} h: ${shortOutcome(sp, (iso) => fmtTime(iso, tz))}`,
        })),
      targetEmpty: new Date(w.target_empty_at).getTime(),
      overlays: ov.overlays,
      hidden: hiddenOverlays,
      ticks: 'day',
      timeZone: tz,
    }),
    ...overlayNotes(ov.notes),
  );
}

/** "On target." / "7 pts unused against the target (empty 1 h before the reset)." */
function targetSentence(w: WindowSummary, bufferH: number): string {
  const text = targetText(w);
  if (text === 'on target') return `On target (empty ${bufferH} h before the reset).`;
  return `${text[0]?.toUpperCase()}${text.slice(1)} against the target (empty ${bufferH} h before the reset).`;
}

function overlayNotes(notes: string[]): HTMLElement[] {
  return notes.length ? [h('p', { class: 'muted small overlay-note' }, notes.join(' '))] : [];
}

async function pastWeekly(v: WeekView, box: HTMLElement): Promise<void> {
  const w = v.shown as WindowSummary;
  const { tz } = v;
  const start = Date.parse(w.start);
  const end = Date.parse(w.reset_at);
  const [detail, ov] = await Promise.all([
    windowDetail(v.plan.plan, w),
    buildOverlays(v, { start, end }),
  ]);
  const pts: ChartPoint[] = detail.readings.map((r) => ({
    t: Date.parse(r.read_at),
    used: r.used_pct,
    note: [r.machine_id, r.how].filter(Boolean).join(' · '),
  }));
  const fromZero = Date.parse(w.first_reading_at) - start <= PARTIAL_GAP_MS;
  const ranOut = w.ran_out_at ? Date.parse(w.ran_out_at) : undefined;
  box.append(
    h(
      'p',
      { class: 'summary' },
      `Ended at `,
      h('b', {}, pct(w.final_pct, 1)),
      w.peak_pct > w.final_pct ? ` (peak ${pct(w.peak_pct, 1)})` : '',
      w.ran_out && w.ran_out_at
        ? h(
            'span',
            { class: 'warn' },
            ` Ran out ${fmtTime(w.ran_out_at, tz)}, ${hours(w.locked_out_h ?? 0)} before the reset.`,
          )
        : `, ${pct(w.unused_pct, 1)} left unused at the reset (about ${hours(w.unused_h)} of even-pace use).`,
      ` ${targetSentence(w, v.plan.empty_buffer_hours)}`,
      ` Reset ${fmtDate(w.reset_at, tz)} · ${w.readings} readings`,
      w.partial
        ? h(
            'span',
            { class: 'partial' },
            ` · partial: readings ${fmtDate(w.first_reading_at, tz)} to ${fmtDate(w.last_reading_at, tz)}`,
          )
        : '',
      '.',
    ),
    chartLegend([
      { cls: 'used', label: 'Readings' },
      { cls: 'even', label: 'Even pace' },
      { cls: 'final', label: 'Final value' },
      ...(ranOut !== undefined ? [{ cls: 'ran-out', label: 'Ran out' }] : []),
      { cls: 'target', label: `Target empty (${v.plan.empty_buffer_hours} h before reset)` },
      ...ov.legend,
    ]),
    windowChart({
      label: `${v.plan.name} week of ${range(w, tz)}: ended at ${pct(w.final_pct)}${w.ran_out && w.ran_out_at ? `, ran out ${fmtTime(w.ran_out_at, tz)}` : ''}${ov.overlays.length ? `, compared with ${ov.overlays.map((o) => o.label).join(', ')}` : ''}`,
      start,
      end,
      // A finished week has no "now" line and no projections.
      now: end + HOUR,
      points: pts,
      fromZero,
      final: { t: Date.parse(w.last_reading_at), used: w.final_pct },
      ranOut,
      targetEmpty: Date.parse(w.target_empty_at),
      overlays: ov.overlays,
      hidden: hiddenOverlays,
      ticks: 'day',
      timeZone: tz,
    }),
    ...overlayNotes(ov.notes),
  );
}

async function weeklyBox(v: WeekView): Promise<HTMLElement> {
  const p = v.plan;
  const box = h('section', { class: 'box weekly', 'aria-labelledby': 'weekly-title' });
  box.append(weeklyHeader(v));
  if (!p.weekly && !v.windows.length) {
    box.append(
      h(
        'p',
        { class: 'muted' },
        p.provider === 'manual'
          ? `No weekly readings yet. Post them to /api/v1/plans/${p.plan}/readings or import a CSV.`
          : `No weekly readings yet. Run: middle-manager import ${p.plan}`,
      ),
    );
    return box;
  }
  box.append(weekControls(v));
  if (v.isCurrent) {
    if (p.weekly) await currentWeekly(v, box);
    else box.append(h('p', { class: 'muted' }, 'No reading in the current week yet.'));
  } else await pastWeekly(v, box);
  return box;
}

/** Finished weeks, newest first: did each run out, how much was left, how close to the target. */
function pastWeeksTable(v: WeekView): HTMLElement {
  const weeks = v.windows.filter((w) => !w.current);
  const { tz } = v;
  return h(
    'section',
    { class: 'box past-weeks', 'aria-labelledby': 'past-title' },
    h('h2', { id: 'past-title', class: 'box-h' }, 'Past weeks'),
    weeks.length
      ? h(
          'div',
          { class: 'table-scroll list-scroll', tabindex: '0', 'aria-labelledby': 'past-title' },
          h(
            'table',
            { class: 'data' },
            h(
              'thead',
              {},
              h(
                'tr',
                {},
                h('th', { scope: 'col' }, 'Week'),
                h('th', { scope: 'col', class: 'num' }, 'Final'),
                h('th', { scope: 'col' }, 'Ran out'),
                h('th', { scope: 'col', class: 'num' }, 'Unused at reset'),
                h('th', { scope: 'col' }, 'vs target'),
                h(
                  'th',
                  {
                    scope: 'col',
                    class: 'num',
                    title:
                      'Average distance from the even-pace line over the week (lower is steadier)',
                  },
                  'Off even pace',
                ),
                h('th', { scope: 'col', class: 'num' }, 'Readings'),
              ),
            ),
            h(
              'tbody',
              {},
              ...weeks.map((w) => {
                const b = h('button', { type: 'button', class: 'linkish' }, range(w, tz));
                b.addEventListener('click', () => v.go(w.id, ['#week-pick', '#week-pick']));
                const shown = !v.isCurrent && v.shown?.id === w.id;
                return h(
                  'tr',
                  { 'data-week': w.id, 'aria-current': shown ? 'true' : null },
                  h(
                    'td',
                    { title: `Reset ${fmtDate(w.reset_at, tz)}` },
                    b,
                    w.partial ? h('span', { class: 'muted small' }, ' partial') : '',
                  ),
                  h('td', { class: 'num' }, pct(w.final_pct, 1)),
                  h(
                    'td',
                    {},
                    w.ran_out && w.ran_out_at
                      ? h('span', { class: 'warn' }, `Yes, ${fmtTime(w.ran_out_at, tz)}`)
                      : 'No',
                  ),
                  h(
                    'td',
                    { class: 'num', title: `${pct(w.unused_pct, 1)} of the allowance` },
                    h('span', {
                      class: 'unused-bar',
                      style: `--w:${Math.min(100, w.unused_pct).toFixed(1)}`,
                    }),
                    w.ran_out
                      ? `0 h (${hours(w.locked_out_h ?? 0)} locked out)`
                      : hours(w.unused_h),
                  ),
                  h('td', {}, targetText(w)),
                  h(
                    'td',
                    { class: 'num' },
                    w.mean_abs_vs_even_pct === null
                      ? '—'
                      : `${w.mean_abs_vs_even_pct.toFixed(1)} pts`,
                  ),
                  h('td', { class: 'num' }, String(w.readings)),
                );
              }),
            ),
          ),
        )
      : h('p', { class: 'muted' }, 'No finished weeks yet.'),
    weeks.length
      ? h(
          'p',
          { class: 'muted small' },
          'Unused at reset: the allowance left, in hours of even-pace use. vs target: points left unused, or how early it ran out against the target-empty time. Off even pace: the average gap between the readings and the even-pace line; lower means steadier pacing.',
        )
      : null,
  );
}

/** A selector that finds the focused control again after the body is rebuilt, if it is in it. */
function focusSelector(body: HTMLElement): string | null {
  const el = document.activeElement;
  if (!(el instanceof HTMLElement) || !body.contains(el)) return null;
  if (el.id) return `#${CSS.escape(el.id)}`;
  if (el.classList.contains('week-prev')) return '.week-prev';
  if (el.classList.contains('week-next')) return '.week-next';
  const week = el.closest('tr[data-week]')?.getAttribute('data-week');
  if (week && el.tagName === 'BUTTON') return `tr[data-week="${CSS.escape(week)}"] button`;
  return null;
}

export function burndownPage(timeZone?: string): HTMLElement {
  const picker = h('div', { class: 'plan-picker', role: 'group', 'aria-label': 'Plan' });
  const body = h(
    'div',
    { class: 'bd-body', 'aria-live': 'polite' },
    h('p', { class: 'muted' }, 'Loading…'),
  );
  const page = h('div', { class: 'bd' }, picker, body);
  const fromUrl = parseState(location.hash);
  const stored = savedCompare();
  const state: BurndownState = {
    plan: fromUrl.plan ?? savedPlan(),
    week: fromUrl.week ?? 'current',
    compare: fromUrl.compare ?? stored.compare,
    avg: fromUrl.avg ?? stored.avg,
  };
  let busy = false;
  let again = false;
  let firstPlan: string | null = null;
  let nav: { older?: string; newer?: string } = {};
  /** After a redraw from a control, focus it again (or the other nav button at either end). */
  let focusAfter: [string, string] | null = null;

  function writeUrl() {
    if (!location.hash.startsWith('#/burndown')) return;
    const plain = state.week === 'current' && state.compare === 'none' && !state.avg;
    const want = stateHash({
      ...state,
      plan: plain && state.plan === firstPlan ? null : state.plan,
    });
    if (location.hash !== want) history.replaceState(null, '', want);
  }

  function go(week: string, focus?: [string, string]) {
    if (focus) focusAfter = focus;
    state.week = week;
    writeUrl();
    void load();
  }

  function set(patch: Partial<BurndownState>, focus?: [string, string]) {
    if (focus) focusAfter = focus;
    Object.assign(state, patch);
    saveCompare(state.compare, state.avg);
    writeUrl();
    void load();
  }

  // [ and ] anywhere on the page (outside form fields); arrows on the Prev / Next buttons.
  const onKey = (ev: KeyboardEvent) => {
    if (!page.isConnected) {
      document.removeEventListener('keydown', onKey);
      return;
    }
    const t = ev.target as HTMLElement;
    if (ev.altKey || ev.ctrlKey || ev.metaKey) return;
    if (t.closest?.('input, select, textarea, [contenteditable="true"], dialog')) return;
    const inNav = !!t.closest?.('.week-nav');
    if ((ev.key === '[' || (inNav && ev.key === 'ArrowLeft')) && nav.older) {
      ev.preventDefault();
      go(nav.older, ['.week-prev', '.week-next']);
    } else if ((ev.key === ']' || (inNav && ev.key === 'ArrowRight')) && nav.newer) {
      ev.preventDefault();
      go(nav.newer, ['.week-next', '.week-prev']);
    }
  };
  document.addEventListener('keydown', onKey);

  async function load() {
    if (busy) {
      again = true;
      return;
    }
    busy = true;
    try {
      const pace = await getPace();
      const now = Date.now();
      if (!pace.plans.length) {
        picker.replaceChildren();
        body.replaceChildren(
          h('p', { class: 'muted' }, 'No plans in the config. Add them under plans:.'),
        );
        return;
      }
      firstPlan = pace.plans[0]?.plan ?? null;
      if (!pace.plans.some((p) => p.plan === state.plan)) state.plan = firstPlan;
      picker.replaceChildren(
        ...(pace.plans.length > 1
          ? pace.plans.map((p) => {
              const b = h(
                'button',
                {
                  type: 'button',
                  'aria-pressed': String(p.plan === state.plan),
                  'data-plan': p.plan,
                },
                p.name,
              );
              b.addEventListener('click', () => {
                state.plan = p.plan;
                state.week = 'current';
                savePlan(p.plan);
                writeUrl();
                void load();
              });
              return b;
            })
          : []),
      );
      const plan = pace.plans.find((p) => p.plan === state.plan) as PlanPace;
      const list = await getWindows(plan.plan).catch(() => ({
        windows: [] as WindowSummary[],
      }));
      const windows = list.windows;
      let shown: WindowSummary | null = null;
      if (state.week !== 'current') {
        shown = windows.find((w) => w.id === state.week && !w.current) ?? null;
        // A week that has expired (or the current one by id) falls back to the current week.
        if (!shown) state.week = 'current';
      }
      const isCurrent = state.week === 'current';
      if (isCurrent) {
        // After a reset with no new reading yet, the chart still shows the window that just
        // ended; name it so "Compare with" does not lay that same week over itself.
        const reset = plan.weekly ? Date.parse(plan.weekly.reset_at) : NaN;
        shown =
          windows.find((w) => w.current) ??
          windows.find((w) => Math.abs(Date.parse(w.reset_at) - reset) < 3 * HOUR) ??
          null;
      }
      writeUrl();
      const order = ['current', ...windows.filter((w) => !w.current).map((w) => w.id)];
      const at = isCurrent ? 0 : order.indexOf(state.week);
      nav = { older: order[at + 1], newer: at > 0 ? order[at - 1] : undefined };
      const view: WeekView = {
        plan,
        windows,
        shown,
        isCurrent,
        state,
        tz: timeZone,
        now,
        go,
        set,
      };
      const [weekly, five] = await Promise.all([
        weeklyBox(view),
        isCurrent ? fiveHourBox(plan, timeZone, now) : Promise.resolve(null),
      ]);
      // A timed refresh rebuilds the body; keep keyboard focus on the control it was on.
      if (!focusAfter) {
        const sel = focusSelector(body);
        if (sel) focusAfter = [sel, sel];
      }
      body.replaceChildren(
        h(
          'div',
          { class: `bd-grid${five ? '' : ' bd-wide'}` },
          weekly,
          five ? h('div', { class: 'side' }, five) : null,
        ),
        pastWeeksTable(view),
        pacingTable(pace, timeZone, now),
      );
      if (focusAfter) {
        const [first, other] = focusAfter;
        const el = [first, other]
          .map((sel) => body.querySelector<HTMLButtonElement>(sel))
          .find((b) => b && !b.disabled);
        el?.focus();
        focusAfter = null;
      }
    } catch (err) {
      body.replaceChildren(
        h('p', { class: 'error' }, `Could not load plans: ${(err as Error).message}`),
      );
    } finally {
      busy = false;
      if (again) {
        again = false;
        void load();
      }
    }
  }
  void load();
  refreshWhileShown(page, () => {
    // A redraw would close an open week or compare list under the reader.
    const active = document.activeElement;
    if (active instanceof HTMLSelectElement && body.contains(active)) return;
    void load();
  });
  return page;
}
