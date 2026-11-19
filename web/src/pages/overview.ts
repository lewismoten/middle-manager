// Overview: one gauge per plan (used, even pace, projection, mode, reset countdown, reading age).
// Other slices add their panels below.

import { h } from '../dom.ts';
import { gauge } from '../charts/gauge.ts';
import {
  getPace,
  modeBadge,
  pct,
  readingAge,
  refreshWhileShown,
  until,
  type PlanPace,
} from '../plans.ts';
import './plans.css';

function card(p: PlanPace, now: number): HTMLElement {
  const w = p.weekly;
  const head = h(
    'div',
    { class: 'pg-head' },
    h('h3', {}, p.name),
    w ? modeBadge(w.mode) : h('span', { class: 'mode mode-none' }, 'no data'),
  );
  if (!w) {
    return h(
      'article',
      { class: 'plan-gauge', 'data-plan': p.plan },
      head,
      h(
        'p',
        { class: 'muted' },
        p.provider === 'manual'
          ? 'No readings yet. Post one to /api/v1/plans/' + p.plan + '/readings.'
          : `No readings yet. Run: middle-manager import ${p.plan}`,
      ),
    );
  }
  const label = `${p.name}: ${pct(w.used_pct)} used, even pace ${pct(w.even_pace_pct)}, projected ${pct(w.projected_pct)} at reset`;
  return h(
    'article',
    { class: 'plan-gauge', 'data-plan': p.plan },
    head,
    h(
      'div',
      { class: 'pg-big' },
      h('b', {}, pct(w.used_pct)),
      h('span', { class: 'muted' }, ' used this week'),
    ),
    gauge({
      used: w.used_pct,
      evenPace: w.even_pace_pct,
      projected: w.projected_pct,
      label,
    }),
    h(
      'dl',
      { class: 'pg-kv' },
      h('dt', {}, 'Even pace'),
      h('dd', {}, pct(w.even_pace_pct)),
      h('dt', {}, 'Projected'),
      h('dd', {}, `${pct(w.projected_pct)} at reset`),
      h('dt', {}, 'Resets'),
      h('dd', {}, w.current ? until(w.reset_at, now) : 'passed, waiting for a new reading'),
      h('dt', {}, 'Model'),
      h('dd', {}, w.suggested_model ?? (w.mode === 'stop' ? 'none new' : '—')),
    ),
    h('p', { class: 'pg-age' }, readingAge(w, now)),
  );
}

export function planGauges(): HTMLElement {
  const grid = h('div', { class: 'plan-gauges', 'aria-live': 'polite' });
  const section = h(
    'section',
    { class: 'box plans-panel', 'aria-labelledby': 'plans-title' },
    h(
      'div',
      { class: 'row' },
      h('h2', { id: 'plans-title', class: 'box-h' }, 'Plans'),
      h('a', { href: '#/burndown', class: 'more' }, 'Burndown'),
    ),
    grid,
  );
  const load = () =>
    getPace()
      .then((res) => {
        const now = Date.now();
        if (!res.plans.length) {
          grid.replaceChildren(
            h('p', { class: 'muted' }, 'No plans in the config. Add them under plans:.'),
          );
        } else grid.replaceChildren(...res.plans.map((p) => card(p, now)));
      })
      .catch((err: unknown) => {
        grid.replaceChildren(
          h('p', { class: 'error' }, `Could not load plans: ${(err as Error).message}`),
        );
      });
  void load();
  refreshWhileShown(section, () => void load());
  return section;
}
