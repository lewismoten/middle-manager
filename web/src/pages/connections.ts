// Connections page (SPEC 8.8): how each plan and local model is connected, a status check for
// each, and the last reading time. Plans are checked on the host without calling the provider;
// "Read now" (signed in) runs the real collector. Local models are probed live.

import './agents.css'; // shared: chips, sr-only
import './connections.css';
import { api, ApiError, getToken, type PublicConfig, type WhoAmI } from '../api.ts';
import { h } from '../dom.ts';
import {
  codeParts,
  headline,
  howTo,
  modelSummary,
  providerLabel,
  STATUS_TEXT,
  statusTone,
  windowLabel,
  type ConnectionsResponse,
  type ConnStatus,
  type LocalConn,
  type PlanConn,
} from './connections-logic.ts';
import { relTime } from './schedules-logic.ts';

const REFRESH_MS = 30_000;

interface Ctx {
  config: PublicConfig | null;
  title: string;
}

const chip = (s: ConnStatus) =>
  h('span', { class: `chip st-${statusTone(s)} conn-status` }, STATUS_TEXT[s]);

function withCode(text: string): HTMLElement {
  const span = h('span', {});
  for (const p of codeParts(text)) span.append(p.code ? h('code', {}, p.text) : p.text);
  return span;
}

function when(iso: string | null, now: number): HTMLElement {
  if (!iso) return h('span', { class: 'muted' }, 'never');
  return h(
    'time',
    { datetime: iso, 'data-rel': iso, title: new Date(iso).toLocaleString() },
    relTime(iso, now),
  );
}

export function mountConnections(main: HTMLElement, ctx: Ctx): () => void {
  let stopped = false;
  let timer: number | undefined;
  let canWrite = false;
  let signedIn = false;
  let skew = 0;
  const now = () => Date.now() + skew;
  const notes = new Map<string, { ok: boolean; text: string }>();

  const summary = h('p', { class: 'arrives', id: 'connections-summary', 'aria-live': 'polite' });
  const refresh = h(
    'button',
    { type: 'button', id: 'connections-refresh', class: 'ghost' },
    'Check again',
  );
  const head = h(
    'div',
    { class: 'page-head' },
    h('h1', { id: 'page-title', tabindex: '-1' }, ctx.title),
    summary,
    h('span', { class: 'head-actions' }, refresh),
  );
  const plans = h('div', { class: 'conn-grid', id: 'conn-plans' });
  const locals = h('div', { class: 'conn-grid', id: 'conn-local' });
  const body = h(
    'div',
    { class: 'conn-page' },
    h(
      'section',
      { 'aria-labelledby': 'conn-plans-title' },
      h('h2', { id: 'conn-plans-title' }, 'Plans'),
      plans,
    ),
    h(
      'section',
      { 'aria-labelledby': 'conn-local-title' },
      h('h2', { id: 'conn-local-title' }, 'Local models'),
      locals,
    ),
  );
  main.replaceChildren(head, body);

  function howToBlock(kind: PlanConn['provider'] | LocalConn['model_kind']) {
    const t = howTo(kind);
    return h(
      'details',
      { class: 'conn-how' },
      h('summary', {}, 'How to connect'),
      h('p', {}, withCode(t.reads)),
      h('ol', {}, ...t.steps.map((s) => h('li', {}, withCode(s)))),
      t.note ? h('p', { class: 'conn-note' }, t.note) : null,
    );
  }

  function planCard(p: PlanConn, n: number): HTMLElement {
    const t = howTo(p.provider);
    const readings = p.readings.length
      ? h(
          'ul',
          { class: 'conn-readings' },
          ...p.readings.map((r) =>
            h(
              'li',
              { 'data-window': r.window },
              h('span', { class: 'win' }, windowLabel(r.window)),
              h('b', {}, `${Math.round(r.used_pct)}% used`),
              when(r.read_at, n),
              r.stale ? h('span', { class: 'stale' }, 'stale') : null,
              r.how ? h('span', { class: 'muted how' }, r.how) : null,
            ),
          ),
        )
      : h('p', { class: 'muted conn-none' }, 'No readings yet.');
    const note = notes.get(p.id);
    const readNow =
      p.provider !== 'manual' && canWrite
        ? h('button', { type: 'button', class: 'read-now', 'data-plan': p.id }, 'Read now')
        : null;
    readNow?.addEventListener('click', () => void collect(p.id, readNow));
    return h(
      'article',
      { class: `conn-card is-${p.status}`, 'data-conn': p.id, 'aria-labelledby': `conn-${p.id}` },
      h(
        'header',
        {},
        h('h3', { id: `conn-${p.id}` }, p.name),
        chip(p.status),
        h('p', { class: 'conn-kind' }, providerLabel(p.provider)),
      ),
      h('p', { class: 'conn-summary' }, p.summary),
      h(
        'ul',
        { class: 'conn-checks' },
        ...p.checks.map((c) =>
          h(
            'li',
            { class: `is-${c.status}` },
            h('span', { class: 'dot', 'aria-hidden': 'true' }),
            h('span', { class: 'sr-only' }, `${STATUS_TEXT[c.status]}: `),
            h('b', {}, c.label),
            ' ',
            h('span', {}, c.detail),
          ),
        ),
      ),
      h('h4', {}, 'Last readings'),
      readings,
      signedIn && p.path
        ? h(
            'p',
            { class: 'conn-path' },
            h('span', { class: 'muted' }, `${t.config}: `),
            h('code', {}, p.path),
          )
        : null,
      readNow || note
        ? h(
            'div',
            { class: 'conn-actions' },
            readNow,
            note
              ? h('span', { class: note.ok ? 'conn-ok' : 'conn-bad', role: 'status' }, note.text)
              : null,
          )
        : null,
      howToBlock(p.provider),
    );
  }

  function localCard(m: LocalConn, n: number): HTMLElement {
    const kv = h('dl', { class: 'kv' });
    const add = (k: string, v: Node | string) => kv.append(h('dt', {}, k), h('dd', {}, v));
    add('Response', m.latency_ms === null ? '–' : `${m.latency_ms} ms`);
    add('Models', modelSummary(m.models, m.model_count));
    add('Checked', when(m.checked_at, n));
    add('Last working', when(m.last_ok_at, n));
    if (signedIn && m.url) add('URL', h('code', {}, m.url));
    return h(
      'article',
      { class: `conn-card is-${m.status}`, 'data-conn': m.id, 'aria-labelledby': `conn-${m.id}` },
      h(
        'header',
        {},
        h('h3', { id: `conn-${m.id}` }, m.name),
        chip(m.status),
        h('p', { class: 'conn-kind' }, providerLabel(m.model_kind)),
      ),
      h('p', { class: 'conn-summary' }, m.summary),
      kv,
      howToBlock(m.model_kind),
    );
  }

  function render(r: ConnectionsResponse): void {
    const n = now();
    summary.textContent = headline(r);
    plans.replaceChildren(
      ...(r.plans.length
        ? r.plans.map((p) => planCard(p, n))
        : [h('p', { class: 'muted conn-none' }, 'No plans in the config.')]),
    );
    locals.replaceChildren(
      ...(r.local_models.length
        ? r.local_models.map((m) => localCard(m, n))
        : [
            h(
              'p',
              { class: 'muted conn-none' },
              'No local models in the config. Add Ollama or an OpenAI-compatible server under ',
              h('code', {}, 'local_models'),
              '.',
            ),
          ]),
    );
  }

  async function load(force = false): Promise<void> {
    window.clearTimeout(timer);
    refresh.disabled = true;
    try {
      await whoami();
      const r = await api<ConnectionsResponse>(`/connections${force ? '?refresh=1' : ''}`);
      if (stopped) return;
      skew = Date.parse(r.now) - Date.now();
      render(r);
    } catch (err) {
      if (stopped) return;
      summary.textContent = `Could not load connections: ${(err as Error).message}`;
    } finally {
      refresh.disabled = false;
      if (!stopped) timer = window.setTimeout(() => void load(), REFRESH_MS);
    }
  }

  async function collect(planId: string, button: HTMLButtonElement): Promise<void> {
    button.disabled = true;
    button.textContent = 'Reading…';
    try {
      const r = await api<{ added: number; readings: number }>(
        `/plans/collectors/${encodeURIComponent(planId)}/run`,
        { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' },
      );
      notes.set(planId, {
        ok: true,
        text: r.readings
          ? `Read ${r.readings} window${r.readings === 1 ? '' : 's'}`
          : 'Nothing new',
      });
    } catch (err) {
      notes.set(planId, {
        ok: false,
        text: err instanceof ApiError ? err.message : 'Could not reach the server',
      });
    }
    if (!stopped) await load();
  }

  let checkedToken: string | null | undefined;
  async function whoami(): Promise<void> {
    const token = getToken();
    if (token === checkedToken) return;
    checkedToken = token;
    canWrite = false;
    signedIn = false;
    if (!token) return;
    try {
      const me = await api<WhoAmI>('/auth/whoami');
      const scopes = me.token?.scopes ?? [];
      signedIn = Boolean(me.token);
      canWrite = scopes.includes('write') || scopes.includes('admin');
    } catch {
      /* reads still work */
    }
  }

  // Keep "x min ago" current between refreshes.
  const ticker = window.setInterval(() => {
    for (const t of main.querySelectorAll<HTMLElement>('time[data-rel]'))
      t.textContent = relTime(t.dataset.rel ?? null, now());
  }, 15_000);

  refresh.addEventListener('click', () => void load(true));
  plans.replaceChildren(h('p', { class: 'muted conn-none' }, 'Checking…'));
  void load();

  return () => {
    stopped = true;
    window.clearTimeout(timer);
    window.clearInterval(ticker);
  };
}
