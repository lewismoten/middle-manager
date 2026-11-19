// Connections (SPEC 8.8): for each plan and local model, whether the connection works right now
// and when it last produced a reading.
//
// Plans are checked on this host without calling the provider: the Claude credentials file is
// opened to see that a login is there and when it expires (the token itself is never returned,
// logged or kept), the Codex sessions folder is checked for recent session logs, and the newest
// stored readings say how fresh the data is. "Read now" on the page runs the real collector
// through POST /plans/collectors/:id/run.
//
// Local models get a live HTTP check (Ollama: /api/tags; OpenAI-compatible: /v1/models) with a
// short timeout. Results are cached briefly so page refreshes do not hammer the endpoint.
//
// File paths and URLs are only included for signed-in requests, like /config/public (SPEC 1.3).

import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { expandHome, type Config, type LocalModelConfig, type PlanConfig } from '../config.ts';
import type { Db } from '../db/index.ts';
import { STALE_AFTER_H } from '../plans/pacing.ts';
import { latestReading } from '../plans/store.ts';

export type Status = 'ok' | 'warn' | 'down' | 'manual';

const HOUR = 3600_000;
export const CHECK_TIMEOUT_MS = 3000;
export const LOCAL_CACHE_MS = 15_000;
/** ?refresh=1 is open to anyone, so it re-checks at most this often. */
const MIN_REFRESH_MS = 2000;
const MAX_BODY_BYTES = 1024 * 1024;
const MAX_MODELS = 50;
/** Codex only writes readings while it runs; older session logs mean "idle", not "broken". */
const CODEX_RECENT_H = 72;

export interface Check {
  /** What was looked at, e.g. "credentials file". */
  label: string;
  status: Status;
  detail: string;
}

export interface ReadingInfo {
  window: string;
  used_pct: number;
  read_at: string;
  age_h: number;
  stale: boolean;
  how: string | null;
  machine_id: string | null;
}

export interface PlanConnection {
  kind: 'plan';
  id: string;
  name: string;
  provider: PlanConfig['provider'];
  status: Status;
  summary: string;
  checks: Check[];
  readings: ReadingInfo[];
  last_reading_at: string | null;
  /** Only when signed in. */
  path?: string | null;
}

export interface LocalConnection {
  kind: 'local';
  id: string;
  name: string;
  model_kind: LocalModelConfig['kind'];
  status: Status;
  summary: string;
  latency_ms: number | null;
  models: string[];
  model_count: number;
  checked_at: string;
  /** Last time a check succeeded since the service started. */
  last_ok_at: string | null;
  /** Only when signed in. */
  url?: string;
}

const worst = (xs: Status[]): Status =>
  xs.includes('down') ? 'down' : xs.includes('warn') ? 'warn' : xs.includes('ok') ? 'ok' : 'manual';

function hoursAgo(iso: string, now: number): number {
  return Math.round(((now - Date.parse(iso)) / HOUR) * 10) / 10;
}

/** "12 min", "3 h", "2 days" for a span in hours. */
function span(h: number): string {
  if (h < 1) return `${Math.max(1, Math.round(h * 60))} min`;
  if (h < 48) return `${Math.round(h)} h`;
  return `${Math.round(h / 24)} days`;
}

function ageText(h: number): string {
  return h < 1 / 60 ? 'just now' : `${span(h)} ago`;
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const MANUAL_HOW = 'Readings arrive through the API, the CLI or a CSV import.';

// ---- Plan source checks (local only) ----

/** Looks at the Claude Code login file. Returns facts only; never the token. */
export function checkCredentials(file: string | undefined, now: number): Check {
  const label = 'Claude Code login';
  if (!file) return { label, status: 'down', detail: 'no credentials file in config' };
  let raw: string;
  try {
    raw = readFileSync(expandHome(file), 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return {
      label,
      status: 'down',
      detail:
        code === 'ENOENT'
          ? 'credentials file not found; log in with Claude Code on this host'
          : `credentials file could not be read (${code ?? 'error'})`,
    };
  }
  let o: { accessToken?: unknown; expiresAt?: unknown } | undefined;
  try {
    o = (JSON.parse(raw) as { claudeAiOauth?: typeof o }).claudeAiOauth;
  } catch {
    return { label, status: 'down', detail: 'credentials file is not valid JSON' };
  }
  if (typeof o?.accessToken !== 'string' || !o.accessToken)
    return { label, status: 'down', detail: 'credentials file has no Claude Code login' };
  if (typeof o.expiresAt === 'number') {
    const left = o.expiresAt - now;
    if (left <= 0)
      return {
        label,
        status: 'warn',
        detail: `login expired ${ageText(-left / HOUR)}; Claude Code refreshes it the next time it runs here`,
      };
    return {
      label,
      status: 'ok',
      detail: `logged in; the access token renews in ${span(left / HOUR)}`,
    };
  }
  return { label, status: 'ok', detail: 'logged in' };
}

/** Newest Codex session log in YYYY/MM/DD folders (last 7 days). */
export function newestSessionLog(dir: string, now: number): Date | null {
  let best: Date | null = null;
  for (let d = 0; d < 7; d++) {
    const day = new Date(now - d * 86_400_000);
    const sub = path.join(
      dir,
      String(day.getUTCFullYear()),
      String(day.getUTCMonth() + 1).padStart(2, '0'),
      String(day.getUTCDate()).padStart(2, '0'),
    );
    let names: string[];
    try {
      names = readdirSync(sub);
    } catch {
      continue;
    }
    for (const n of names) {
      if (!n.endsWith('.jsonl')) continue;
      try {
        const m = statSync(path.join(sub, n)).mtime;
        if (!best || m > best) best = m;
      } catch {
        /* vanished */
      }
    }
    if (best) break;
  }
  return best;
}

export function checkSessions(dir: string | undefined, now: number): Check {
  const label = 'Codex session logs';
  if (!dir) return { label, status: 'down', detail: 'no sessions_dir in config' };
  const abs = expandHome(dir);
  try {
    if (!statSync(abs).isDirectory()) throw new Error();
  } catch {
    return {
      label,
      status: 'down',
      detail: 'sessions folder not found; has Codex run on this host?',
    };
  }
  const newest = newestSessionLog(abs, now);
  if (!newest)
    return {
      label,
      status: 'warn',
      detail: 'no session logs in the last 7 days; readings arrive only while Codex runs',
    };
  const h = (now - newest.getTime()) / HOUR;
  return {
    label,
    status: h > CODEX_RECENT_H ? 'warn' : 'ok',
    detail: `newest session log ${ageText(h)}`,
  };
}

export function planConnection(
  db: Db,
  plan: PlanConfig,
  opts: { now?: number; signedIn?: boolean } = {},
): PlanConnection {
  const now = opts.now ?? Date.now();
  const checks: Check[] = [];
  let pathShown: string | null = null;
  if (plan.provider === 'anthropic-oauth') {
    checks.push(checkCredentials(plan.credentials, now));
    pathShown = plan.credentials ?? null;
  } else if (plan.provider === 'codex-sessions') {
    checks.push(checkSessions(plan.sessions_dir, now));
    pathShown = plan.sessions_dir ?? null;
  }

  const readings: ReadingInfo[] = [];
  for (const w of plan.windows) {
    const r = latestReading(db, plan.id, w);
    if (!r) continue;
    const age = hoursAgo(r.read_at, now);
    readings.push({
      window: w,
      used_pct: r.used_pct,
      read_at: r.read_at,
      age_h: age,
      stale: age > STALE_AFTER_H,
      how: r.how ?? null,
      machine_id: r.machine_id ?? null,
    });
  }
  const last = readings.reduce<string | null>(
    (a, r) => (!a || r.read_at > a ? r.read_at : a),
    null,
  );
  const weekly = readings.find((r) => r.window === 'weekly') ?? readings[0];
  if (plan.provider !== 'manual') {
    checks.push(
      !weekly
        ? { label: 'Readings', status: 'warn', detail: 'no readings stored yet' }
        : {
            label: 'Readings',
            status: weekly.stale ? 'warn' : 'ok',
            detail: `last ${weekly.window.replace('_', '-')} reading ${ageText(weekly.age_h)}${weekly.stale ? ' (stale)' : ''}`,
          },
    );
  } else {
    checks.push({
      label: 'Readings',
      status: 'manual',
      detail: weekly ? `last reading ${ageText(weekly.age_h)}` : 'no readings yet',
    });
  }

  const status = worst(checks.map((c) => c.status));
  const firstBad = checks.find((c) => c.status === status && status !== 'ok');
  const out: PlanConnection = {
    kind: 'plan',
    id: plan.id,
    name: plan.name,
    provider: plan.provider,
    status,
    summary:
      status === 'manual'
        ? MANUAL_HOW
        : status === 'ok'
          ? `Working; ${checks[checks.length - 1]?.detail ?? ''}`
          : cap(firstBad?.detail ?? ''),
    checks,
    readings,
    last_reading_at: last,
  };
  if (opts.signedIn) out.path = pathShown;
  return out;
}

// ---- Local models (live) ----

/** The URL to probe for a model endpoint. */
export function probeUrl(m: Pick<LocalModelConfig, 'url' | 'kind'>): string {
  const base = m.url.replace(/\/+$/, '');
  if (m.kind === 'ollama') return `${base}/api/tags`;
  return /\/v\d+$/.test(base) ? `${base}/models` : `${base}/v1/models`;
}

/** Model names from an Ollama /api/tags or OpenAI /models body. */
export function modelNames(kind: LocalModelConfig['kind'], body: unknown): string[] | null {
  const b = body as { models?: unknown; data?: unknown } | null;
  const list = kind === 'ollama' ? b?.models : b?.data;
  if (!Array.isArray(list)) return null;
  return list
    .map((x) => {
      const o = x as { name?: unknown; model?: unknown; id?: unknown };
      const v = kind === 'ollama' ? (o.name ?? o.model) : o.id;
      return typeof v === 'string' ? v.slice(0, 120) : null;
    })
    .filter((x): x is string => Boolean(x));
}

async function readCapped(res: Response): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > MAX_BODY_BYTES) {
      await reader.cancel();
      throw new Error('response is over 1 MB');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function errorText(err: unknown, timeoutMs: number): string {
  const e = err as { name?: string; message?: string; cause?: { code?: string; message?: string } };
  if (e.name === 'TimeoutError' || e.name === 'AbortError')
    return `no answer within ${timeoutMs / 1000} s`;
  const code = e.cause?.code;
  if (e.cause?.message === 'bad port') return 'port is blocked for HTTP clients; use another port';
  if (code === 'ECONNREFUSED') return 'connection refused (is it running?)';
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'host name not found';
  if (code === 'ECONNRESET') return 'connection reset';
  if (code) return `connection failed (${code})`;
  return e.message && e.message.length < 120 ? e.message : 'request failed';
}

export async function checkLocalModel(
  m: LocalModelConfig,
  opts: { fetch?: typeof fetch; now?: () => number; timeoutMs?: number } = {},
): Promise<Omit<LocalConnection, 'last_ok_at' | 'url'>> {
  const clock = opts.now ?? Date.now;
  const started = clock();
  const base = {
    kind: 'local' as const,
    id: m.id,
    name: m.name,
    model_kind: m.kind,
    models: [] as string[],
    model_count: 0,
    checked_at: new Date(started).toISOString(),
  };
  try {
    const res = await (opts.fetch ?? fetch)(probeUrl(m), {
      headers: { accept: 'application/json', 'user-agent': 'middle-manager' },
      redirect: 'error',
      signal: AbortSignal.timeout(opts.timeoutMs ?? CHECK_TIMEOUT_MS),
    });
    const latency = Math.max(0, Math.round(clock() - started));
    if (!res.ok) {
      await res.body?.cancel();
      return {
        ...base,
        status: 'down',
        summary: `Answered HTTP ${res.status}${res.status === 401 ? ' (needs a key)' : ''}`,
        latency_ms: latency,
      };
    }
    let names: string[] | null = null;
    try {
      names = modelNames(m.kind, JSON.parse(await readCapped(res)));
    } catch {
      names = null;
    }
    if (!names)
      return {
        ...base,
        status: 'warn',
        summary: `Reachable, but the reply is not ${m.kind === 'ollama' ? 'an Ollama' : 'a'} model list`,
        latency_ms: latency,
      };
    return {
      ...base,
      status: names.length ? 'ok' : 'warn',
      summary: names.length
        ? `Reachable; ${names.length} model${names.length === 1 ? '' : 's'}`
        : 'Reachable, but no models are installed',
      latency_ms: latency,
      models: names.slice(0, MAX_MODELS),
      model_count: names.length,
    };
  } catch (err) {
    return {
      ...base,
      status: 'down',
      summary: cap(errorText(err, opts.timeoutMs ?? CHECK_TIMEOUT_MS)),
      latency_ms: null,
    };
  }
}

interface CacheEntry {
  at: number;
  result: Omit<LocalConnection, 'last_ok_at' | 'url'>;
  last_ok_at: string | null;
}
const cache = new WeakMap<Config, Map<string, CacheEntry>>();

export async function localConnections(
  config: Config,
  opts: { refresh?: boolean; signedIn?: boolean; fetch?: typeof fetch; now?: () => number } = {},
): Promise<LocalConnection[]> {
  const clock = opts.now ?? Date.now;
  let c = cache.get(config);
  if (!c) cache.set(config, (c = new Map()));
  const entries = c;
  return Promise.all(
    config.local_models.map(async (m) => {
      const prev = entries.get(m.id);
      const age = prev ? clock() - prev.at : Infinity;
      let e = prev;
      if (!e || age > LOCAL_CACHE_MS || (opts.refresh && age > MIN_REFRESH_MS)) {
        const result = await checkLocalModel(m, { fetch: opts.fetch, now: clock });
        e = {
          at: clock(),
          result,
          last_ok_at: result.status === 'ok' ? result.checked_at : (prev?.last_ok_at ?? null),
        };
        entries.set(m.id, e);
      }
      const out: LocalConnection = { ...e.result, last_ok_at: e.last_ok_at };
      if (opts.signedIn) out.url = m.url;
      return out;
    }),
  );
}

export async function connections(
  db: Db,
  config: Config,
  opts: { refresh?: boolean; signedIn?: boolean; fetch?: typeof fetch; now?: number } = {},
) {
  const now = opts.now ?? Date.now();
  const plans = config.plans.map((p) => planConnection(db, p, { now, signedIn: opts.signedIn }));
  const local = await localConnections(config, {
    refresh: opts.refresh,
    signedIn: opts.signedIn,
    fetch: opts.fetch,
  });
  return {
    now: new Date(now).toISOString(),
    stale_after_h: STALE_AFTER_H,
    plans,
    local_models: local,
  };
}
