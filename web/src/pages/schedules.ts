// Schedules page (SPEC 8.6): middle-manager's own jobs (create, edit, enable, run now, last runs
// with output) next to a read-only mirror of Hermes cron and systemd timers.

import './agents.css'; // shared: side sheet, status chips, link buttons, sr-only
import './schedules.css';
import { api, ApiError, getToken, type PublicConfig, type WhoAmI } from '../api.ts';
import { append, h } from '../dom.ts';
import {
  anyRunning,
  duration,
  externalTone,
  formBody,
  groupExternal,
  kindLabel,
  relTime,
  runTone,
  sourceLabel,
  summaryText,
  type ExternalJob,
  type Job,
  type JobRun,
  type JobsResponse,
  type RunStatus,
  type Tone,
} from './schedules-logic.ts';

const REFRESH_MS = 15_000;
const FAST_REFRESH_MS = 2_000;

interface Ctx {
  config: PublicConfig | null;
  title: string;
}

const chip = (tone: Tone, text: string, extra = '') =>
  h('span', { class: `chip st-${tone}${extra ? ` ${extra}` : ''}` }, text);

const muted = (text = '–') => h('span', { class: 'muted' }, text);

function when(iso: string | null, now: number, live = true): HTMLElement {
  if (!iso) return muted();
  return h(
    'time',
    {
      class: 'rel',
      datetime: iso,
      'data-rel': live ? iso : null,
      title: new Date(iso).toLocaleString(),
    },
    relTime(iso, now),
  );
}

export function mountSchedules(main: HTMLElement, ctx: Ctx): () => void {
  let stopped = false;
  let timer: number | undefined;
  let skew = 0;
  let jobs: Job[] = [];
  let external: ExternalJob[] = [];
  let collectors: JobsResponse['collectors'] = [];
  let siteTz = ctx.config?.site.timezone ?? 'UTC';
  let canWrite = false;
  let canShell = false;
  let openJobId: number | null = null;

  const now = () => Date.now() + skew;

  const summary = h('p', { class: 'arrives', id: 'schedules-summary', 'aria-live': 'polite' });
  const newJob = h(
    'button',
    { type: 'button', id: 'job-new', class: 'primary', hidden: true },
    'New job',
  );
  const refresh = h(
    'button',
    { type: 'button', id: 'schedules-refresh', class: 'ghost' },
    'Refresh',
  );
  const head = h(
    'div',
    { class: 'page-head' },
    h('h1', { id: 'page-title', tabindex: '-1' }, ctx.title),
    summary,
    h('span', { class: 'head-actions' }, newJob, refresh),
  );
  const ownList = h('div', { class: 'sched-scroll', id: 'own-jobs-list' });
  const extList = h('div', {
    class: 'sched-scroll',
    id: 'external-jobs-list',
    tabindex: '0',
    'aria-label': 'Mirrored schedules',
  });
  const priorities = ['failed', 'stuck', 'overdue'] as const;
  const order = [...priorities, null];
  function byAttention(a: Job | ExternalJob, b: Job | ExternalJob) {
    return order.indexOf(a.attention) - order.indexOf(b.attention);
  }
  function countText(items: (Job | ExternalJob)[]) {
    const counts = priorities.flatMap((key) => {
      const count = items.filter((j) => j.attention === key).length;
      return count ? [`${count} ${key === 'failed' ? 'failing' : key}`] : [];
    });
    return counts.length ? `${items.length} · ${counts.join(' - ')}` : String(items.length);
  }
  function pausedGroup(container: HTMLElement, count: number, ...children: HTMLElement[]) {
    return h(
      'details',
      { class: 'paused-jobs', open: !!container.querySelector('details[open]') },
      h('summary', {}, `Paused (${count})`),
      ...children,
    );
  }
  const ownCount = h('span', { class: 'muted count' });
  const extCount = h('span', { class: 'muted count' });
  const grid = h(
    'div',
    { class: 'sched-grid' },
    h(
      'section',
      { class: 'sched-panel', id: 'own-jobs', 'aria-labelledby': 'own-jobs-title' },
      h('h2', { id: 'own-jobs-title' }, 'Jobs', ownCount),
      ownList,
    ),
    h(
      'section',
      { class: 'sched-panel', id: 'external-jobs', 'aria-labelledby': 'external-jobs-title' },
      h(
        'h2',
        { id: 'external-jobs-title' },
        'Other schedulers',
        extCount,
        h('span', { class: 'chip ro' }, 'read-only'),
      ),
      extList,
    ),
  );
  const sheet = h('dialog', {
    id: 'job-sheet',
    class: 'sheet side-sheet',
    'aria-labelledby': 'job-sheet-title',
  });
  const formDialog = h('dialog', {
    id: 'job-form-dialog',
    class: 'sheet side-sheet',
    'aria-labelledby': 'job-form-title',
  });
  main.replaceChildren(head, grid, sheet, formDialog);

  // ---- Own jobs ----

  function runNowButton(job: Job): HTMLButtonElement {
    const b = h(
      'button',
      {
        type: 'button',
        class: 'run-now',
        'data-job': job.id,
        disabled: !canWrite || job.running,
        title: !canWrite
          ? 'Sign in with a token to run jobs'
          : job.running
            ? 'Already running'
            : `Run "${job.name}" now`,
        'aria-label': `Run now: ${job.name}`,
      },
      job.running ? 'Running…' : 'Run now',
    );
    b.addEventListener('click', () => void runNow(job, b));
    return b;
  }

  function lastRunCell(job: Job, n: number): HTMLElement {
    const r = job.last_run;
    if (!r) return muted('never run');
    const live = r.status === 'running';
    return h(
      'span',
      { class: 'last' },
      chip(runTone(r.status), r.status === 'failed' ? `failed · ${r.exit_code}` : r.status),
      when(r.started_at, n),
      live
        ? h(
            'time',
            { class: 'dur', 'data-start': r.started_at, 'data-live': '1' },
            duration((n - Date.parse(r.started_at)) / 1000),
          )
        : r.duration_s !== null
          ? h('span', { class: 'dur', title: 'duration' }, duration(r.duration_s))
          : null,
    );
  }

  function renderOwn(): void {
    const n = now();
    ownCount.textContent = countText(jobs);
    if (!jobs.length) {
      ownList.replaceChildren(
        h(
          'div',
          { class: 'sched-empty' },
          h('p', { class: 'lead' }, 'No jobs yet.'),
          h(
            'p',
            { class: 'muted' },
            canWrite
              ? 'Use New job to run a collector or a shell command on a cron schedule.'
              : 'Sign in with a token to create jobs. Collector jobs run built-in importers; shell jobs need the jobs:shell scope.',
          ),
        ),
      );
      return;
    }
    const table = h(
      'table',
      { class: 'jobs' },
      h('caption', { class: 'sr-only' }, 'middle-manager jobs'),
      h(
        'thead',
        {},
        h(
          'tr',
          {},
          ...['Job', 'Schedule', 'Next run', 'Last run', ''].map((c) =>
            h('th', { scope: 'col' }, c || h('span', { class: 'sr-only' }, 'Actions')),
          ),
        ),
      ),
    );
    const body = h('tbody', {});
    const paused = h('tbody', {});
    for (const job of [...jobs].sort(byAttention)) {
      const open = h(
        'button',
        { type: 'button', class: 'link job-open', 'data-job': job.id },
        job.name,
      );
      open.addEventListener('click', () => void openSheet(job.id));
      (job.enabled ? body : paused).append(
        h(
          'tr',
          { class: `job${job.enabled ? '' : ' disabled'}`, 'data-job-id': job.id },
          h(
            'td',
            { 'data-label': 'Job', class: 'name' },
            open,
            h(
              'span',
              { class: 'tags' },
              h('span', { class: 'chip' }, kindLabel(job)),
              job.attention && job.attention !== 'failed' ? chip('block', job.attention) : null,
              job.enabled ? null : h('span', { class: 'chip st-muted' }, 'disabled'),
            ),
          ),
          h(
            'td',
            { 'data-label': 'Schedule' },
            h('code', {}, job.schedule),
            h('span', { class: 'small muted' }, job.effective_timezone),
          ),
          h(
            'td',
            { 'data-label': 'Next run' },
            job.enabled ? when(job.next_run_at, n) : muted('disabled'),
          ),
          h('td', { 'data-label': 'Last run' }, lastRunCell(job, n)),
          h('td', { class: 'run-cell' }, runNowButton(job)),
        ),
      );
    }
    const pausedTable = table.cloneNode(true) as HTMLTableElement;
    pausedTable.append(paused);
    table.append(body);
    const group = pausedGroup(ownList, paused.childElementCount, pausedTable);
    ownList.replaceChildren(table, ...(paused.childElementCount ? [group] : []));
  }

  // ---- Mirror ----

  function renderExternal(): void {
    const n = now();
    extCount.textContent = countText(external);
    const mirrors = (ctx.config?.collectors ?? []).filter(
      (c) => c.kind === 'hermes-cron' || c.kind === 'systemd-timers',
    );
    if (!external.length) {
      extList.replaceChildren(
        h(
          'div',
          { class: 'sched-empty' },
          h(
            'p',
            { class: 'muted' },
            mirrors.length
              ? `Nothing read yet from ${mirrors.map((m) => m.id).join(', ')}.`
              : 'No mirrors configured. Add a collector of kind hermes-cron or systemd-timers to show their jobs here.',
          ),
        ),
      );
      return;
    }
    function sections(items: ExternalJob[]) {
      const nodes: HTMLElement[] = [];
      for (const g of groupExternal(items)) {
        const list = h('ul', { class: 'ext-list' });
        for (const j of g.jobs) {
          list.append(
            h(
              'li',
              { class: `ext${j.enabled ? '' : ' disabled'}`, 'data-external-id': j.external_id },
              h(
                'div',
                { class: 'ext-top' },
                h('b', { class: 'ext-name' }, j.name),
                j.enabled ? null : h('span', { class: 'chip st-muted' }, 'paused'),
                j.attention && j.attention !== 'failed' ? chip('block', j.attention) : null,
                j.last_status ? chip(externalTone(j.last_status), j.last_status) : null,
              ),
              h(
                'div',
                { class: 'ext-meta' },
                j.schedule ? h('code', {}, j.schedule) : muted('no schedule'),
                h('span', {}, 'next ', j.enabled ? when(j.next_run_at, n) : muted()),
                h('span', {}, 'last ', when(j.last_run_at, n)),
              ),
              j.command ? h('div', { class: 'ext-cmd muted', title: j.command }, j.command) : null,
              j.name !== j.external_id ? h('div', { class: 'small muted' }, j.external_id) : null,
            ),
          );
        }
        nodes.push(
          h(
            'section',
            { class: 'ext-group', 'data-source': g.source },
            h(
              'h3',
              {},
              sourceLabel(g.kind),
              h(
                'span',
                { class: 'muted' },
                ` · ${g.source}${g.machine_id ? ` on ${g.machine_id}` : ''}`,
              ),
              h('span', { class: 'read-at' }, ' read ', when(g.read_at, n)),
              g.stale ? h('span', { class: 'chip st-block stale' }, 'stale') : null,
            ),
            list,
          ),
        );
      }
      return nodes;
    }
    const nodes = sections(external.filter((j) => j.enabled).sort(byAttention));
    const paused = external.filter((j) => !j.enabled);
    if (paused.length) nodes.push(pausedGroup(extList, paused.length, ...sections(paused)));
    extList.replaceChildren(...nodes);
  }

  // ---- Loading ----

  async function load(): Promise<void> {
    window.clearTimeout(timer);
    try {
      await whoami();
      const [own, ext] = await Promise.all([
        api<JobsResponse>('/jobs'),
        api<{ now: string; jobs: ExternalJob[] }>('/external-jobs'),
      ]);
      if (stopped) return;
      skew = Date.parse(own.now) - Date.now();
      jobs = own.jobs;
      collectors = own.collectors;
      siteTz = own.site_timezone;
      external = ext.jobs;
      renderOwn();
      renderExternal();
      summary.textContent = `${summaryText(jobs, external)} · updated ${new Date().toLocaleTimeString()}`;
      if (openJobId !== null && sheet.open) void openSheet(openJobId, false);
    } catch (err) {
      if (stopped) return;
      summary.textContent = `Could not load schedules: ${(err as Error).message}`;
    }
    if (!stopped)
      timer = window.setTimeout(() => void load(), anyRunning(jobs) ? FAST_REFRESH_MS : REFRESH_MS);
  }

  function tick(): void {
    const n = now();
    for (const el of main.querySelectorAll<HTMLElement>('time[data-rel]'))
      el.textContent = relTime(el.dataset.rel ?? null, n);
    for (const el of main.querySelectorAll<HTMLElement>('time.dur[data-live]')) {
      const start = el.dataset.start;
      if (start) el.textContent = duration((n - Date.parse(start)) / 1000);
    }
  }

  async function runNow(job: Job, button: HTMLButtonElement): Promise<void> {
    button.disabled = true;
    button.textContent = 'Starting…';
    try {
      await api(`/jobs/${job.id}/run`, { method: 'POST' });
      summary.textContent = `Started "${job.name}".`;
    } catch (err) {
      summary.textContent = `Could not run "${job.name}": ${(err as Error).message}`;
    }
    await load();
  }

  // ---- Detail sheet ----

  function runItem(r: JobRun): HTMLElement {
    const label = [
      new Date(r.started_at).toLocaleString(),
      r.duration_s !== null ? duration(r.duration_s) : null,
      r.trigger === 'manual' ? `manual${r.actor ? ` by ${r.actor}` : ''}` : r.trigger,
      r.exit_code !== null ? `exit ${r.exit_code}` : null,
    ]
      .filter(Boolean)
      .join(' · ');
    return h(
      'li',
      { 'data-run-id': r.id },
      h(
        'details',
        {},
        h('summary', {}, chip(runTone(r.status as RunStatus), r.status), ' ', label),
        r.output
          ? h('pre', { class: 'prompt-full job-output', tabindex: '0' }, r.output)
          : h('p', { class: 'muted' }, 'No output.'),
        r.truncated ? h('p', { class: 'muted small' }, 'Output was cut at the size cap.') : null,
      ),
    );
  }

  async function openSheet(id: number, focus = true): Promise<void> {
    openJobId = id;
    const body = h('div', { class: 'body' });
    if (!sheet.open || focus) {
      sheet.replaceChildren(body);
      body.append(h('p', { class: 'muted' }, 'Loading…'));
      if (!sheet.open) sheet.showModal();
    }
    try {
      const [job, runs] = await Promise.all([
        api<Job>(`/jobs/${id}`),
        api<{ runs: JobRun[] }>(`/jobs/${id}/runs?limit=20`),
      ]);
      // Keep open <details> open across the live refresh.
      const opened = new Set(
        [...sheet.querySelectorAll<HTMLElement>('li[data-run-id] details[open]')].map(
          (d) => d.closest('li')?.dataset.runId,
        ),
      );
      const kv = h('dl', { class: 'kv' });
      const add = (k: string, v: Node | string | number | null | undefined) => {
        if (v === null || v === undefined || v === '') return;
        kv.append(h('dt', {}, k), h('dd', {}, v instanceof Node ? v : String(v)));
      };
      const n = now();
      add('Kind', kindLabel(job));
      add('Command', job.command ? h('code', {}, job.command) : null);
      add('Schedule', h('code', {}, job.schedule));
      add('Time zone', job.timezone ?? `${job.effective_timezone} (site)`);
      add('Enabled', job.enabled ? 'yes' : 'no');
      add('Next run', job.enabled ? when(job.next_run_at, n) : 'disabled');
      add('Timeout', duration(job.timeout_s));
      add('Notify', job.notify);
      add(
        'Created',
        `${new Date(job.created_at).toLocaleString()}${job.created_by ? ` by ${job.created_by}` : ''}`,
      );

      const close = h('button', { type: 'button', id: 'job-sheet-close' }, 'Close');
      close.addEventListener('click', () => sheet.close());
      const editable = canWrite && (job.kind !== 'shell' || canShell);
      const actions = h('div', { class: 'row' });
      actions.append(runNowButton(job));
      if (editable) {
        const edit = h('button', { type: 'button', id: 'job-edit' }, 'Edit');
        edit.addEventListener('click', () => openForm(job));
        const toggle = h(
          'button',
          { type: 'button', id: 'job-toggle' },
          job.enabled ? 'Disable' : 'Enable',
        );
        toggle.addEventListener('click', () => void patch(job, { enabled: !job.enabled }));
        const del = h('button', { type: 'button', id: 'job-delete', class: 'danger' }, 'Delete');
        del.addEventListener('click', () => void remove(job));
        actions.append(edit, toggle, del);
      } else if (canWrite) {
        actions.append(
          h('span', { class: 'muted small' }, 'Editing shell jobs needs the jobs:shell scope.'),
        );
      }
      const list = h('ul', { class: 'job-runs' }, ...runs.runs.map(runItem));
      for (const li of list.querySelectorAll<HTMLElement>('li[data-run-id]'))
        if (opened.has(li.dataset.runId)) li.querySelector('details')?.setAttribute('open', '');
      body.replaceChildren();
      append(body, [
        h('div', { class: 'row sheet-head' }, h('h2', { id: 'job-sheet-title' }, job.name), close),
        h('p', { class: 'error', id: 'job-sheet-error', role: 'alert' }),
        actions,
        kv,
        h('h3', {}, `Last runs (${runs.runs.length})`),
        runs.runs.length ? list : h('p', { class: 'muted' }, 'This job has not run yet.'),
      ]);
      sheet.replaceChildren(body);
      if (focus) close.focus();
    } catch (err) {
      if (!focus && sheet.open) return; // a background refresh failed; keep what is shown
      const close = h('button', { type: 'button' }, 'Close');
      close.addEventListener('click', () => sheet.close());
      body.replaceChildren(
        h(
          'p',
          { class: 'error' },
          err instanceof ApiError ? err.message : 'Could not load the job.',
        ),
        close,
      );
      sheet.replaceChildren(body);
    }
  }

  function sheetError(msg: string): void {
    const el = sheet.querySelector('#job-sheet-error');
    if (el) el.textContent = msg;
  }

  async function patch(job: Job, body: Record<string, unknown>): Promise<void> {
    try {
      await api(`/jobs/${job.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      await load();
      await openSheet(job.id, false);
    } catch (err) {
      sheetError((err as Error).message);
    }
  }

  async function remove(job: Job): Promise<void> {
    if (!window.confirm(`Delete the job "${job.name}" and its run history?`)) return;
    try {
      await api(`/jobs/${job.id}`, { method: 'DELETE' });
      sheet.close();
      await load();
    } catch (err) {
      sheetError((err as Error).message);
    }
  }

  // ---- Create / edit form ----

  function field(id: string, label: string, control: HTMLElement, help?: HTMLElement | string) {
    return h(
      'div',
      { class: 'form-field' },
      h('label', { for: id }, label),
      control,
      help ? h('p', { class: 'muted small', id: `${id}-help` }, help) : null,
    );
  }

  function openForm(job?: Job): void {
    if (sheet.open) sheet.close();
    const name = h('input', {
      type: 'text',
      id: 'jf-name',
      required: true,
      maxlength: 80,
      value: job?.name ?? '',
    });
    const kind = h('select', { id: 'jf-kind' });
    kind.append(
      h('option', { value: 'collector' }, 'Collector (built-in importer)'),
      h(
        'option',
        { value: 'shell', disabled: !canShell },
        canShell ? 'Shell command' : 'Shell command (needs jobs:shell)',
      ),
    );
    kind.value = job?.kind ?? 'collector';
    const collector = h('select', { id: 'jf-collector' });
    for (const c of collectors)
      collector.append(h('option', { value: c.id }, `${c.id} (${c.kind})`));
    if (job?.collector_id) collector.value = job.collector_id;
    const command = h('textarea', { id: 'jf-command', rows: 3, spellcheck: 'false' });
    command.value = job?.command ?? '';
    const schedule = h('input', {
      type: 'text',
      id: 'jf-schedule',
      required: true,
      spellcheck: 'false',
      placeholder: '0 * * * *',
      value: job?.schedule ?? '',
      'aria-describedby': 'jf-schedule-help',
    });
    const preview = h('span', { 'aria-live': 'polite', class: 'preview-line' });
    const tz = h('input', {
      type: 'text',
      id: 'jf-timezone',
      spellcheck: 'false',
      placeholder: siteTz,
      value: job?.timezone ?? '',
    });
    const timeout = h('input', {
      type: 'number',
      id: 'jf-timeout',
      min: 1,
      max: 86400,
      value: job?.timeout_s ?? 300,
    });
    const enabled = h('input', { type: 'checkbox', id: 'jf-enabled' });
    enabled.checked = job?.enabled ?? true;
    const error = h('p', { class: 'error', id: 'jf-error', role: 'alert' });
    const collectorField = field(
      'jf-collector',
      'Collector',
      collector,
      collectors.length ? undefined : 'No runnable collectors in the config.',
    );
    const commandField = field(
      'jf-command',
      'Command',
      command,
      'Runs with /bin/sh as the service user.',
    );
    const syncKind = () => {
      collectorField.hidden = kind.value !== 'collector';
      commandField.hidden = kind.value !== 'shell';
    };
    kind.addEventListener('change', syncKind);
    syncKind();

    let previewTimer: number | undefined;
    const updatePreview = () => {
      window.clearTimeout(previewTimer);
      previewTimer = window.setTimeout(() => {
        const q = new URLSearchParams({ schedule: schedule.value, timezone: tz.value.trim() });
        void api<{ ok: boolean; error?: string; next: string[]; timezone: string }>(
          `/jobs/preview?${q}`,
        )
          .then((p) => {
            preview.textContent = p.ok
              ? p.next.length
                ? `Next: ${p.next.map((d) => new Date(d).toLocaleString()).join(' · ')} (${p.timezone})`
                : 'Never fires again.'
              : (p.error ?? 'Not a valid schedule.');
            preview.classList.toggle('bad', !p.ok);
          })
          .catch(() => {
            preview.textContent = '';
          });
      }, 250);
    };
    schedule.addEventListener('input', updatePreview);
    tz.addEventListener('input', updatePreview);
    if (schedule.value) updatePreview();

    const cancel = h('button', { type: 'button' }, 'Cancel');
    cancel.addEventListener('click', () => formDialog.close());
    const form = h(
      'form',
      { class: 'body job-form', novalidate: true },
      h('h2', { id: 'job-form-title' }, job ? `Edit ${job.name}` : 'New job'),
      field('jf-name', 'Name', name),
      field('jf-kind', 'Kind', kind),
      collectorField,
      commandField,
      field(
        'jf-schedule',
        'Schedule (cron, 5 fields)',
        schedule,
        h(
          'span',
          {},
          'e.g. ',
          h('code', {}, '*/15 * * * *'),
          ', ',
          h('code', {}, '0 9 * * 1-5'),
          ', ',
          h('code', {}, '@daily'),
          '. ',
          preview,
        ),
      ),
      field('jf-timezone', 'Time zone', tz, `Blank uses the site time zone (${siteTz}).`),
      field('jf-timeout', 'Timeout (seconds)', timeout),
      h('label', { class: 'check' }, enabled, ' Enabled'),
      error,
      h(
        'div',
        { class: 'row end' },
        cancel,
        h('button', { type: 'submit', class: 'primary', id: 'jf-save' }, job ? 'Save' : 'Create'),
      ),
    );
    form.addEventListener('submit', (ev) => {
      ev.preventDefault();
      error.textContent = '';
      const body = formBody({
        name: name.value,
        kind: kind.value,
        collector_id: collector.value,
        command: command.value,
        schedule: schedule.value,
        timezone: tz.value,
        timeout_s: timeout.value,
        enabled: enabled.checked,
      });
      void api<Job>(job ? `/jobs/${job.id}` : '/jobs', {
        method: job ? 'PATCH' : 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
        .then(async (saved) => {
          formDialog.close();
          summary.textContent = `Saved "${saved.name}".`;
          await load();
          await openSheet(saved.id);
        })
        .catch((err: unknown) => {
          error.textContent = err instanceof ApiError ? err.message : 'Could not save the job.';
        });
    });
    formDialog.replaceChildren(form);
    formDialog.showModal();
    name.focus();
  }

  // ---- Wiring ----

  for (const d of [sheet, formDialog]) {
    d.addEventListener('click', (ev) => {
      if (ev.target === d) d.close(); // backdrop
    });
  }
  sheet.addEventListener('close', () => (openJobId = null));
  refresh.addEventListener('click', () => void load());
  newJob.addEventListener('click', () => openForm());

  // Signing in or out happens in the header; notice it on the next refresh.
  let checkedToken: string | null | undefined;
  async function whoami(): Promise<void> {
    const token = getToken();
    if (token === checkedToken) return;
    checkedToken = token;
    canWrite = false;
    canShell = false;
    if (token) {
      try {
        const me = await api<WhoAmI>('/auth/whoami');
        const scopes = me.token?.scopes ?? [];
        canWrite = scopes.includes('write') || scopes.includes('admin');
        canShell = scopes.includes('jobs:shell') || scopes.includes('admin');
      } catch {
        /* reads still work */
      }
    }
    newJob.hidden = !canWrite;
  }

  ownList.replaceChildren(h('p', { class: 'muted pad' }, 'Loading jobs…'));
  extList.replaceChildren(h('p', { class: 'muted pad' }, 'Loading…'));
  void load();
  const ticker = window.setInterval(tick, 1000);

  return () => {
    stopped = true;
    window.clearTimeout(timer);
    window.clearInterval(ticker);
    if (sheet.open) sheet.close();
    if (formDialog.open) formDialog.close();
  };
}
