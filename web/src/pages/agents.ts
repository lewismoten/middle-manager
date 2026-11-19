// Agents page (SPEC 8.4): runs grouped by machine, sub-agents indented under their parents,
// live durations, filters, and a detail sheet with the full prompt.

import './agents.css';
import { api, ApiError, type PublicConfig } from '../api.ts';
import { append, h } from '../dom.ts';
import {
  baseName,
  buildGroups,
  cacheTokens,
  compact,
  DEFAULT_FILTERS,
  duration,
  elapsed,
  filtersToQuery,
  HOUR_CHOICES,
  ROLES,
  shortOrigin,
  statusTone,
  type Filters,
  type RunDetail,
  type RunView,
} from './agents-logic.ts';

const REFRESH_MS = 10_000;

// Survives leaving and coming back to the tab within one visit.
const filters: Filters = { ...DEFAULT_FILTERS };
const seenModels = new Set<string>();
const seenMachines = new Set<string>();

interface Ctx {
  config: PublicConfig | null;
  title: string;
}

function select(
  id: string,
  label: string,
  value: string,
  options: [string, string][],
  onChange: (v: string) => void,
): HTMLElement {
  const sel = h('select', { id, name: id });
  for (const [v, text] of options) {
    const o = h('option', { value: v }, text);
    if (v === value) o.selected = true;
    sel.append(o);
  }
  sel.addEventListener('change', () => onChange(sel.value));
  return h('div', { class: 'field' }, h('label', { for: id }, label), sel);
}

function tokensCell(r: RunView): HTMLElement {
  const cache = cacheTokens(r);
  if (r.tokens_in === null && r.tokens_out === null && cache === null)
    return h('span', { class: 'muted' }, '–');
  const title =
    `in ${r.tokens_in ?? 0}, out ${r.tokens_out ?? 0}, ` +
    `cache read ${r.tokens_cache_read ?? 0}, cache write ${r.tokens_cache_write ?? 0}`;
  return h(
    'span',
    { class: 'tokens', title },
    h('span', {}, h('i', {}, 'in '), compact(r.tokens_in)),
    h('span', {}, h('i', {}, 'out '), compact(r.tokens_out)),
    h('span', {}, h('i', {}, 'cache '), compact(cache)),
  );
}

function taskCell(r: RunView): HTMLElement | string {
  if (!r.task) return h('span', { class: 'muted' }, '–');
  return h(
    'a',
    { href: `#/board?task=${r.task.id}`, title: r.task.title ?? undefined },
    r.task.short_name ?? r.task.title ?? 'task',
    h('span', { class: 'id' }, ` #${r.task.id}`),
  );
}

function whereCell(r: RunView): HTMLElement {
  const origin = shortOrigin(r.origin);
  const wt = baseName(r.worktree);
  if (!origin && !r.branch && !wt) return h('span', { class: 'muted' }, '–');
  return h(
    'span',
    { class: 'where' },
    origin ? h('span', { title: r.origin ?? '' }, origin) : null,
    r.branch ? h('code', { title: 'branch' }, r.branch) : null,
    wt ? h('span', { class: 'muted', title: r.worktree ?? '' }, wt) : null,
  );
}

function statusChip(status: string): HTMLElement {
  return h('span', { class: `chip st-${statusTone(status)}` }, status);
}

function durationEl(r: RunView, now: number): HTMLElement {
  return h(
    'time',
    {
      class: 'dur',
      datetime: r.started_at,
      'data-start': r.started_at,
      'data-live': r.ended_at ? null : '1',
      title: `started ${new Date(r.started_at).toLocaleString()}`,
    },
    duration(elapsed(r, now)),
  );
}

export function mountAgents(main: HTMLElement, ctx: Ctx): () => void {
  let timer: number | undefined;
  let skew = 0; // server clock minus browser clock
  let stopped = false;
  let lastRuns: RunView[] = [];

  const summary = h('p', { class: 'arrives', id: 'agents-summary', 'aria-live': 'polite' });
  const refresh = h('button', { type: 'button', id: 'agents-refresh', class: 'ghost' }, 'Refresh');
  const head = h(
    'div',
    { class: 'page-head' },
    h('h1', { id: 'page-title', tabindex: '-1' }, ctx.title),
    summary,
    refresh,
  );
  const bar = h('form', { class: 'filters', role: 'search', 'aria-label': 'Filter runs' });
  const panel = h('section', { class: 'runs-panel', 'aria-labelledby': 'page-title' });
  const sheet = h('dialog', {
    id: 'run-sheet',
    class: 'sheet side-sheet',
    'aria-labelledby': 'run-sheet-title',
  });
  main.replaceChildren(head, bar, panel, sheet);
  bar.addEventListener('submit', (ev) => ev.preventDefault());

  const machinesFromConfig = () => ctx.config?.machines ?? [];

  function renderFilters(): void {
    const machines = new Map(machinesFromConfig().map((m) => [m.id, m.name]));
    for (const id of seenMachines) if (!machines.has(id)) machines.set(id, id);
    const models = new Set<string>(seenModels);
    for (const p of ctx.config?.plans ?? []) for (const m of p.models) models.add(m);
    const set = (k: keyof Filters) => (v: string) => {
      if (k === 'hours') filters.hours = Number(v);
      else filters[k] = v;
      void load();
    };
    bar.replaceChildren(
      select(
        'f-hours',
        'Show',
        String(filters.hours),
        [
          ['0', 'Active now'],
          ...HOUR_CHOICES.map((n): [string, string] => [
            String(n),
            `Active + finished in last ${n} h`,
          ]),
        ],
        set('hours'),
      ),
      select(
        'f-machine',
        'Machine',
        filters.machine,
        [['', 'All machines'], ...machines.entries()],
        set('machine'),
      ),
      select(
        'f-model',
        'Model',
        filters.model,
        [['', 'All models'], ...[...models].sort().map((m): [string, string] => [m, m])],
        set('model'),
      ),
      select(
        'f-project',
        'Project',
        filters.project,
        [
          ['', 'All projects'],
          ...(ctx.config?.projects ?? []).map((p): [string, string] => [p.id, p.name]),
        ],
        set('project'),
      ),
      select(
        'f-role',
        'Role',
        filters.role,
        [['', 'All roles'], ...ROLES.map((r): [string, string] => [r, r])],
        set('role'),
      ),
    );
  }

  function renderTable(runs: RunView[]): void {
    const now = Date.now() + skew;
    if (!runs.length) {
      const what = filters.hours ? `in the last ${filters.hours} h` : 'right now';
      panel.replaceChildren(
        h(
          'div',
          { class: 'runs-empty' },
          h('p', { class: 'lead' }, `No agent runs ${what}.`),
          h(
            'p',
            { class: 'muted' },
            'Agents show up here when they report themselves with one curl at start and end ',
            '(see docs/agents.md), or when a process-scan or systemd-workers collector finds them.',
          ),
        ),
      );
      return;
    }
    const groups = buildGroups(runs, machinesFromConfig());
    const table = h(
      'table',
      { class: 'runs' },
      h('caption', { class: 'sr-only' }, 'Agent runs grouped by machine'),
      h(
        'thead',
        {},
        h(
          'tr',
          {},
          ...['Agent', 'Model', 'Tokens', 'Task', 'Prompt', 'Duration', 'Where', 'Status'].map(
            (c) => h('th', { scope: 'col' }, c),
          ),
        ),
      ),
    );
    for (const g of groups) {
      const body = h(
        'tbody',
        { 'data-machine': g.machine ?? '' },
        h(
          'tr',
          { class: 'group' },
          h(
            'th',
            { colspan: 8, scope: 'colgroup' },
            g.name,
            h(
              'span',
              { class: 'muted' },
              ` · ${g.running} running${g.rows.length > g.running ? `, ${g.rows.length - g.running} finished` : ''}`,
            ),
          ),
        ),
      );
      for (const { run: r, depth, orphanOf } of g.rows) {
        const open = h(
          'button',
          {
            type: 'button',
            class: 'link run-open',
            'data-run': r.id,
            'aria-label': `Run ${r.id} details`,
          },
          `#${r.id}`,
        );
        open.addEventListener('click', () => void openSheet(r.id));
        const tr = h(
          'tr',
          {
            class: `run depth-${Math.min(depth, 4)}${r.ended_at ? ' finished' : ''}`,
            'data-run-id': r.id,
            'data-depth': depth,
          },
          h(
            'td',
            { 'data-label': 'Agent', class: 'agent' },
            h(
              'span',
              { class: 'agent-line' },
              depth ? h('span', { class: 'branch-mark', 'aria-hidden': 'true' }, '└') : null,
              open,
              h('b', {}, r.agent_kind),
              h('span', { class: `chip role role-${r.role}` }, r.role),
            ),
            orphanOf ? h('span', { class: 'muted small' }, `child of #${orphanOf}`) : null,
          ),
          h('td', { 'data-label': 'Model' }, r.model ?? h('span', { class: 'muted' }, '–')),
          h('td', { 'data-label': 'Tokens' }, tokensCell(r)),
          h('td', { 'data-label': 'Task' }, taskCell(r)),
          h(
            'td',
            { 'data-label': 'Prompt', class: 'prompt' },
            r.prompt_first_line
              ? h('span', { title: r.prompt_first_line }, r.prompt_first_line)
              : h('span', { class: 'muted' }, r.command ? r.command : '–'),
          ),
          h('td', { 'data-label': 'Duration' }, durationEl(r, now)),
          h('td', { 'data-label': 'Where' }, whereCell(r)),
          h('td', { 'data-label': 'Status' }, statusChip(r.status)),
        );
        body.append(tr);
      }
      table.append(body);
    }
    panel.replaceChildren(table);
  }

  function tick(): void {
    const now = Date.now() + skew;
    for (const el of main.querySelectorAll<HTMLElement>('time.dur[data-live]')) {
      const start = el.dataset.start;
      if (start) el.textContent = duration((now - Date.parse(start)) / 1000);
    }
  }

  async function load(): Promise<void> {
    window.clearTimeout(timer);
    try {
      const res = await api<{ now: string; runs: RunView[] }>(`/runs?${filtersToQuery(filters)}`);
      if (stopped) return;
      skew = Date.parse(res.now) - Date.now();
      lastRuns = res.runs;
      const before = seenModels.size + seenMachines.size;
      for (const r of res.runs) {
        if (r.model) seenModels.add(r.model);
        if (r.machine_id) seenMachines.add(r.machine_id);
      }
      if (seenModels.size + seenMachines.size > before) renderFilters();
      renderTable(res.runs);
      const running = res.runs.filter((r) => !r.ended_at).length;
      const machines = new Set(res.runs.filter((r) => !r.ended_at).map((r) => r.machine_id)).size;
      summary.textContent =
        `${running} running on ${machines} machine${machines === 1 ? '' : 's'}` +
        (res.runs.length > running ? `, ${res.runs.length - running} finished` : '') +
        ` · updated ${new Date().toLocaleTimeString()}`;
    } catch (err) {
      if (stopped) return;
      summary.textContent = `Could not load runs: ${(err as Error).message}`;
      if (!lastRuns.length) panel.replaceChildren(h('p', { class: 'muted' }, 'No data.'));
    }
    if (!stopped) timer = window.setTimeout(() => void load(), REFRESH_MS);
  }

  async function openSheet(id: number): Promise<void> {
    const body = h('div', { class: 'body' });
    sheet.replaceChildren(body);
    body.append(h('p', { class: 'muted' }, 'Loading…'));
    if (!sheet.open) sheet.showModal();
    try {
      const r = await api<RunDetail>(`/runs/${id}`);
      const kv = h('dl', { class: 'kv' });
      const add = (k: string, v: Node | string | number | null | undefined) => {
        if (v === null || v === undefined || v === '') return;
        kv.append(h('dt', {}, k), h('dd', {}, v instanceof Node ? v : String(v)));
      };
      const runLink = (x: RunView) => {
        const b = h(
          'button',
          { type: 'button', class: 'link' },
          `#${x.id} ${x.agent_kind} · ${x.role} · ${x.status}`,
        );
        b.addEventListener('click', () => void openSheet(x.id));
        return b;
      };
      add('Status', statusChip(r.status));
      add('Machine', r.machine_id);
      add('Model', r.model);
      add('Provider', r.provider);
      add('Harness', r.harness);
      add('Task', r.task ? taskCell(r) : null);
      add('Project', r.project_id);
      add('Started', new Date(r.started_at).toLocaleString());
      add('Ended', r.ended_at ? new Date(r.ended_at).toLocaleString() : null);
      add('Duration', durationEl(r, Date.now() + skew));
      const n = (v: number | null) => (v ?? 0).toLocaleString();
      add(
        'Tokens',
        `in ${n(r.tokens_in)} · out ${n(r.tokens_out)} · cache read ${n(r.tokens_cache_read)} · cache write ${n(r.tokens_cache_write)}`,
      );
      add('Origin', r.origin);
      add('Branch', r.branch);
      add('Worktree', r.worktree);
      add('PID', r.pid);
      add('Unit', r.unit);
      add('Command', r.command);
      add('Log', r.log_ref);
      add('Prompt ref', r.prompt_ref);
      add('Cost note', r.cost_note);
      add('Source', r.source);
      add('Last seen', r.seen_at ? new Date(r.seen_at).toLocaleString() : null);
      add('Parent', r.parent ? runLink(r.parent) : null);
      const close = h('button', { type: 'button', id: 'run-sheet-close' }, 'Close');
      close.addEventListener('click', () => sheet.close());
      body.replaceChildren();
      append(body, [
        h(
          'div',
          { class: 'row sheet-head' },
          h('h2', { id: 'run-sheet-title' }, `Run #${r.id} · ${r.agent_kind} · ${r.role}`),
          close,
        ),
        kv,
        h('h3', {}, 'Prompt'),
        r.prompt
          ? h('pre', { class: 'prompt-full', tabindex: '0' }, r.prompt)
          : h('p', { class: 'muted' }, 'No prompt reported.'),
        r.summary ? h('h3', {}, 'Summary') : null,
        r.summary ? h('pre', { class: 'prompt-full', tabindex: '0' }, r.summary) : null,
        r.children.length ? h('h3', {}, `Sub-agents (${r.children.length})`) : null,
        r.children.length
          ? h('ul', { class: 'children' }, ...r.children.map((c) => h('li', {}, runLink(c))))
          : null,
      ]);
      close.focus();
    } catch (err) {
      body.replaceChildren(
        h(
          'p',
          { class: 'error' },
          err instanceof ApiError ? err.message : 'Could not load the run.',
        ),
        (() => {
          const b = h('button', { type: 'button' }, 'Close');
          b.addEventListener('click', () => sheet.close());
          return b;
        })(),
      );
    }
  }

  sheet.addEventListener('click', (ev) => {
    if (ev.target === sheet) sheet.close(); // click on the backdrop
  });
  refresh.addEventListener('click', () => void load());

  renderFilters();
  panel.replaceChildren(h('p', { class: 'muted' }, 'Loading runs…'));
  void load();
  const ticker = window.setInterval(tick, 1000);

  return () => {
    stopped = true;
    window.clearTimeout(timer);
    window.clearInterval(ticker);
    if (sheet.open) sheet.close();
  };
}
