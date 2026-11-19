// Burndown: per plan, the weekly chart (readings, even pace, projection, now, target empty),
// the 5-hour window when the plan reports one, past weeks, and a pacing table for every plan.

import { h } from '../dom.ts';
import { gauge } from '../charts/gauge.ts';
import { chartLegend, windowChart, type ChartPoint } from '../charts/window-chart.ts';
import {
  fmtDate,
  fmtTime,
  getPace,
  getPlans,
  getReadings,
  modeBadge,
  pct,
  rate,
  readingAge,
  refreshWhileShown,
  until,
  type PaceResponse,
  type PlanPace,
  type PlanSummary,
  type Reading,
} from '../plans.ts';
import './plans.css';

const PLAN_KEY = 'mm.burndown.plan';
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
      h('td', { class: 'num' }, `${rate(w.rate_pct_per_h)} (${w.rate_basis_h} h)`),
      h('td', { class: 'num' }, rate(w.need_pct_per_h)),
      h('td', { class: 'num' }, pct(w.projected_pct)),
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

function pastWeeksBox(plan: PlanSummary | undefined, tz: string | undefined): HTMLElement {
  const weeks = plan?.past_weeks ?? [];
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
                h('th', { scope: 'col' }, 'Reset'),
                h('th', { scope: 'col', class: 'num' }, 'Used'),
                h('th', { scope: 'col', class: 'num' }, 'Left unused'),
              ),
            ),
            h(
              'tbody',
              {},
              ...weeks.map((w) =>
                h(
                  'tr',
                  {},
                  h(
                    'td',
                    { title: `Last reading ${fmtDate(w.last_reading_at, tz)}` },
                    fmtDate(w.reset_at, tz),
                  ),
                  h('td', { class: 'num' }, pct(w.used_pct, 1)),
                  h(
                    'td',
                    { class: 'num' },
                    h('span', {
                      class: 'unused-bar',
                      style: `--w:${Math.min(100, w.unused_pct).toFixed(1)}`,
                    }),
                    pct(w.unused_pct, 1),
                  ),
                ),
              ),
            ),
          ),
        )
      : h('p', { class: 'muted' }, 'No finished weeks yet.'),
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

async function weeklyBox(p: PlanPace, tz: string | undefined, now: number): Promise<HTMLElement> {
  const w = p.weekly;
  const box = h('section', { class: 'box weekly', 'aria-labelledby': 'weekly-title' });
  box.append(
    h(
      'div',
      { class: 'row' },
      h('h2', { id: 'weekly-title', class: 'box-h' }, `${p.name} · weekly window`),
      w ? modeBadge(w.mode) : null,
    ),
  );
  if (!w) {
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
  const start = new Date(w.start).getTime();
  const end = new Date(w.reset_at).getTime();
  const rs = await getReadings(p.plan, {
    window: 'weekly',
    since: new Date(start - 3 * HOUR).toISOString(),
  });
  const pts = toPoints(
    rs.readings.filter(
      (x) => x.resets_at && Math.abs(new Date(x.resets_at).getTime() - end) < 3 * HOUR,
    ),
  );
  box.append(
    h(
      'p',
      { class: 'summary' },
      `Used ${pct(w.used_pct, 1)} (even pace ${pct(w.even_pace_pct)}), ${rate(w.rate_24h)} over the last 24 h, projected `,
      h('b', {}, pct(w.projected_pct)),
      ` at the reset ${fmtTime(w.reset_at, tz)}.`,
      w.runs_out_at
        ? h('span', { class: 'warn' }, ` Would run out ${fmtTime(w.runs_out_at, tz)}.`)
        : '',
      ' ',
      readingAge(w, now),
    ),
    chartLegend([
      { cls: 'used', label: 'Readings' },
      { cls: 'even', label: 'Even pace' },
      { cls: 'proj', label: 'Projection (24 h rate)' },
      { cls: 'target', label: `Target empty (${p.empty_buffer_hours} h before reset)` },
      { cls: 'now', label: 'Now' },
    ]),
    windowChart({
      label: `${p.name} weekly burndown: ${pct(w.used_pct)} used, even pace ${pct(w.even_pace_pct)}, projected ${pct(w.projected_pct)} at reset`,
      start,
      end,
      now,
      points: pts,
      projectionRate: w.rate_24h,
      targetEmpty: new Date(w.target_empty_at).getTime(),
      ticks: 'day',
      timeZone: tz,
    }),
  );
  return box;
}

export function burndownPage(timeZone?: string): HTMLElement {
  const picker = h('div', { class: 'plan-picker', role: 'group', 'aria-label': 'Plan' });
  const body = h(
    'div',
    { class: 'bd-body', 'aria-live': 'polite' },
    h('p', { class: 'muted' }, 'Loading…'),
  );
  const page = h('div', { class: 'bd' }, picker, body);
  let selected = savedPlan();
  let busy = false;

  async function load() {
    if (busy) return;
    busy = true;
    try {
      const [pace, plans] = await Promise.all([getPace(), getPlans()]);
      const now = Date.now();
      if (!pace.plans.length) {
        picker.replaceChildren();
        body.replaceChildren(
          h('p', { class: 'muted' }, 'No plans in the config. Add them under plans:.'),
        );
        return;
      }
      if (!pace.plans.some((p) => p.plan === selected)) selected = pace.plans[0]?.plan ?? null;
      picker.replaceChildren(
        ...(pace.plans.length > 1
          ? pace.plans.map((p) => {
              const b = h(
                'button',
                {
                  type: 'button',
                  'aria-pressed': String(p.plan === selected),
                  'data-plan': p.plan,
                },
                p.name,
              );
              b.addEventListener('click', () => {
                selected = p.plan;
                savePlan(p.plan);
                void load();
              });
              return b;
            })
          : []),
      );
      const plan = pace.plans.find((p) => p.plan === selected) as PlanPace;
      const [weekly, five] = await Promise.all([
        weeklyBox(plan, timeZone, now),
        fiveHourBox(plan, timeZone, now),
      ]);
      body.replaceChildren(
        h(
          'div',
          { class: 'bd-grid' },
          weekly,
          h(
            'div',
            { class: 'side' },
            five,
            pastWeeksBox(
              plans.plans.find((x) => x.id === selected),
              timeZone,
            ),
          ),
        ),
        pacingTable(pace, timeZone, now),
      );
    } catch (err) {
      body.replaceChildren(
        h('p', { class: 'error' }, `Could not load plans: ${(err as Error).message}`),
      );
    } finally {
      busy = false;
    }
  }
  void load();
  refreshWhileShown(page, () => void load());
  return page;
}
