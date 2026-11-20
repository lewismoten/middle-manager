// Overview: one gauge per plan (used, even pace, projection, mode, reset countdown, reading age).
import { api, listTasks } from '../api.ts';
import { STATUSES, type Task } from './board-logic.ts';
import type { RunView } from './agents-logic.ts';
import type { ConnectionsResponse } from './connections-logic.ts';
import { externalTone, type JobsResponse, type ExternalJob } from './schedules-logic.ts';

import { h } from '../dom.ts';
import { gauge } from '../charts/gauge.ts';
import {
  burnForecastLine,
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
    burnForecastLine(w),
    h(
      'dl',
      { class: 'pg-kv' },
      h('dt', {}, 'Even pace'),
      h('dd', {}, pct(w.even_pace_pct)),
      h('dt', {}, 'Projected'),
      h('dd', {}, `${pct(w.projected_pct)} at reset`),
      h('dt', {}, 'Resets'),
      h('dd', {}, w.current ? until(w.reset_at, now) : 'passed, waiting for a new reading'),
      h('dt', {}, 'Suggested model'),
      h('dd', {}, w.suggested_model ?? (w.mode === 'stop' ? 'none new' : '—')),
    ),
    h('p', { class: 'pg-age' }, readingAge(w, now)),
  );
}

export function overviewPage(): HTMLElement {
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
  const panels = h('div', { class: 'overview-panels' });
  const root = h('div', {}, section, panels);
  function panel(title: string) {
    const body = h('div', { 'aria-live': 'polite' }, 'Loading…');
    panels.append(h('section', { class: 'box' }, h('h2', { class: 'box-h' }, title), body));
    return body;
  }
  const runsPanel = panel('Running now');
  const boardPanel = panel('Board counts');
  const failedPanel = panel('Failed jobs 24h');
  const attentionPanel = panel('Needs a person');

  function summary(count: number, details: [string, number][]) {
    return h(
      'div',
      {},
      h('strong', { class: 'overview-count' }, count),
      h(
        'dl',
        { class: 'pg-kv' },
        ...details.flatMap(([label, value]) => [h('dt', {}, label), h('dd', {}, value)]),
      ),
      h('small', { class: 'muted' }, 'Updated ', new Date().toLocaleTimeString()),
    );
  }
  async function show(target: HTMLElement, content: Promise<HTMLElement[]>) {
    try {
      target.replaceChildren(...(await content));
    } catch (err) {
      target.replaceChildren(
        h('p', { class: 'error' }, 'Could not load data: ' + (err as Error).message),
      );
    }
  }
  let loading = false;
  async function load() {
    if (loading) return;
    loading = true;
    const pace = getPace();
    const tasks = listTasks<Task>();
    const failures = Promise.all([
      api<JobsResponse>('/jobs'),
      api<{ now: string; jobs: ExternalJob[] }>('/external-jobs'),
    ]).then(([owned, mirror]) => {
      const now = Date.parse(mirror.now);
      const mirrored = mirror.jobs.filter((j) => {
        const age = now - Date.parse(j.last_run_at ?? '');
        return externalTone(j.last_status) === 'block' && age >= 0 && age <= 86400000;
      }).length;
      return { owned: owned.failed_24h, mirrored };
    });
    await Promise.all([
      show(
        grid,
        pace.then(({ plans }) =>
          plans.length
            ? plans.map((p) => card(p, Date.now()))
            : [h('p', { class: 'muted' }, 'No plans in the config. Add them under plans:.')],
        ),
      ),
      show(
        runsPanel,
        api<{ runs: RunView[] }>('/runs?active=1').then(({ runs }) => {
          const groups = new Map<string, number>();
          for (const run of runs) {
            const label =
              (run.machine_id ?? 'Unknown machine') + ' · ' + (run.model ?? 'Unknown model');
            groups.set(label, (groups.get(label) ?? 0) + 1);
          }
          return [summary(runs.length, [...groups])];
        }),
      ),
      show(
        boardPanel,
        tasks.then((rows) => [
          summary(
            rows.length,
            STATUSES.map((status) => [status, rows.filter((t) => t.status === status).length]),
          ),
        ]),
      ),
      show(
        failedPanel,
        failures.then((f) => [
          summary(f.owned + f.mirrored, [
            ['Scheduled', f.owned],
            ['Mirrored', f.mirrored],
          ]),
        ]),
      ),
      show(
        attentionPanel,
        Promise.all([tasks, failures, pace, api<ConnectionsResponse>('/connections')]).then(
          ([rows, f, { plans }, connections]) => {
            const reasons: [string, number][] = [
              ['Blocked tasks', rows.filter((t) => t.status === 'blocked').length],
              ['Failed jobs', f.owned + f.mirrored],
              ['Stale readings', plans.filter((p) => p.weekly?.stale).length],
              [
                'Connections',
                [...connections.plans, ...connections.local_models].filter(
                  (c) => c.status === 'warn' || c.status === 'down',
                ).length,
              ],
            ];
            return [
              summary(
                reasons.reduce((total, [, n]) => total + n, 0),
                reasons,
              ),
            ];
          },
        ),
      ),
    ]);
    loading = false;
  }
  void load();
  refreshWhileShown(root, () => void load());
  return root;
}
