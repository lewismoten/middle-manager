// Usage (SPEC 8.5): tokens per hour and per day by plan and model, runs per day, cost notes.
// Built from the runs table. A run's tokens are totals for the whole run, so they are spread
// evenly over the hours the run was open (start to end, or to now while it runs).

import type { Config } from '../config.ts';
import type { Db } from '../db/index.ts';
import { HttpError } from '../http/app.ts';

const HOUR = 3600_000;

export const TOKEN_KINDS = ['in', 'out', 'cache_read', 'cache_write'] as const;
export type TokenKind = (typeof TOKEN_KINDS)[number];
export type Tokens = Record<TokenKind, number>;

export interface UsageQuery {
  /** Days of daily buckets, including today (site time zone). */
  days: number;
  /** Hourly buckets ending with the current hour. */
  hours: number;
}

export const USAGE_DEFAULTS: UsageQuery = { days: 14, hours: 48 };

export interface UsageRun {
  id: number;
  agent_kind: string;
  model: string | null;
  provider: string | null;
  status: string;
  started_at: string;
  ended_at: string | null;
  tokens_in: number | null;
  tokens_out: number | null;
  tokens_cache_read: number | null;
  tokens_cache_write: number | null;
  cost_note: string | null;
}

export interface SeriesInfo {
  key: string;
  plan_id: string | null;
  plan_name: string;
  model: string;
  runs: number;
  tokens: Tokens;
}

export interface BucketSeries {
  key: string;
  in: number[];
  out: number[];
  cache_read: number[];
  cache_write: number[];
}

export interface Usage {
  now: string;
  timezone: string;
  days: number;
  hours: number;
  /** One entry per plan/model pair with tokens in the window, largest first. */
  series: SeriesInfo[];
  /** Hour starts (ISO, UTC) for the last `hours` hours. */
  hourly: { buckets: string[]; series: BucketSeries[] };
  /** Local dates (YYYY-MM-DD in the site time zone) for the last `days` days. */
  daily: { buckets: string[]; series: BucketSeries[] };
  /** Runs started per local day, by agent kind. */
  runs_per_day: { buckets: string[]; by_kind: { agent_kind: string; counts: number[] }[] };
  /** The latest cost notes agents attached to runs in the window. */
  cost_notes: {
    run_id: number;
    started_at: string;
    agent_kind: string;
    model: string | null;
    plan_id: string | null;
    note: string;
  }[];
  /** Runs in the window that reported no token counts at all. */
  runs_without_tokens: number;
}

export function parseUsageQuery(q: URLSearchParams): UsageQuery {
  const num = (k: keyof UsageQuery, max: number) => {
    const raw = q.get(k);
    if (raw === null || raw === '') return USAGE_DEFAULTS[k];
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1 || n > max)
      throw new HttpError(400, 'invalid', `${k} must be a whole number from 1 to ${max}`);
    return n;
  };
  return { days: num('days', 90), hours: num('hours', 168) };
}

/**
 * Which configured plan a run counts against: the run's `provider` when it names a plan, else
 * the plan whose model ladder lists the run's model, else the only plan whose collector reads
 * that agent's logins (claude-code -> anthropic-oauth, codex -> codex-sessions). Null otherwise.
 */
export function planFor(run: Pick<UsageRun, 'provider' | 'model' | 'agent_kind'>, config: Config) {
  const plans = config.plans;
  if (run.provider) {
    const p = plans.find((x) => x.id === run.provider);
    if (p) return p;
  }
  if (run.model) {
    const p = plans.find((x) => config.models[x.id]?.includes(run.model as string));
    if (p) return p;
  }
  const provider =
    run.agent_kind === 'claude-code'
      ? 'anthropic-oauth'
      : run.agent_kind === 'codex'
        ? 'codex-sessions'
        : null;
  if (provider) {
    const matches = plans.filter((x) => x.provider === provider);
    if (matches.length === 1) return matches[0];
  }
  return null;
}

/** YYYY-MM-DD of an instant in a time zone. */
export function localDate(t: number, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(t));
}

const zero = (): Tokens => ({ in: 0, out: 0, cache_read: 0, cache_write: 0 });

function runTokens(r: UsageRun): Tokens {
  return {
    in: r.tokens_in ?? 0,
    out: r.tokens_out ?? 0,
    cache_read: r.tokens_cache_read ?? 0,
    cache_write: r.tokens_cache_write ?? 0,
  };
}

/** Fraction of [start, end) that falls in each hour bucket starting at `first`. */
export function spread(start: number, end: number, first: number, count: number): number[] {
  const out = new Array<number>(count).fill(0);
  if (end <= start) {
    const i = Math.floor((start - first) / HOUR);
    if (i >= 0 && i < count) out[i] = 1;
    return out;
  }
  const span = end - start;
  const lo = Math.max(0, Math.floor((start - first) / HOUR));
  const hi = Math.min(count - 1, Math.floor((end - 1 - first) / HOUR));
  for (let i = lo; i <= hi; i++) {
    const b0 = first + i * HOUR;
    const overlap = Math.min(end, b0 + HOUR) - Math.max(start, b0);
    if (overlap > 0) out[i] = overlap / span;
  }
  return out;
}

/** Pure aggregation over runs; `usage()` feeds it from the database. */
export function aggregateUsage(runs: UsageRun[], config: Config, q: UsageQuery, now: Date): Usage {
  const tz = config.site.timezone;
  const nowMs = now.getTime();
  const currentHour = Math.floor(nowMs / HOUR) * HOUR;
  // Enough hours to cover `days` local days (plus slack for the zone offset) and `hours`.
  const count = Math.max(q.hours, (q.days + 1) * 24 + 14);
  const first = currentHour - (count - 1) * HOUR;

  const dayBuckets: string[] = [];
  for (let d = q.days - 1; d >= 0; d--) {
    const label = localDate(nowMs - d * 24 * HOUR, tz);
    if (!dayBuckets.includes(label)) dayBuckets.push(label);
  }
  const dayIndex = new Map(dayBuckets.map((d, i) => [d, i]));
  const hourDay = Array.from({ length: count }, (_, i) =>
    dayIndex.get(localDate(first + i * HOUR, tz)),
  );

  const info = new Map<string, SeriesInfo>();
  const hourly = new Map<string, Tokens[]>();
  const kinds = new Map<string, number[]>();
  const notes: Usage['cost_notes'] = [];
  let withoutTokens = 0;

  for (const r of runs) {
    const start = Date.parse(r.started_at);
    const end = r.ended_at ? Date.parse(r.ended_at) : nowMs;
    if (!Number.isFinite(start) || start > nowMs || end < first) continue;

    const startDay = dayIndex.get(localDate(start, tz));
    if (startDay !== undefined) {
      const counts = kinds.get(r.agent_kind) ?? new Array<number>(dayBuckets.length).fill(0);
      counts[startDay] = (counts[startDay] ?? 0) + 1;
      kinds.set(r.agent_kind, counts);
    }
    const plan = planFor(r, config);
    if (r.cost_note?.trim()) {
      notes.push({
        run_id: r.id,
        started_at: r.started_at,
        agent_kind: r.agent_kind,
        model: r.model,
        plan_id: plan?.id ?? null,
        note: r.cost_note.trim(),
      });
    }

    const tokens = runTokens(r);
    const total = TOKEN_KINDS.reduce((a, k) => a + tokens[k], 0);
    if (total === 0) {
      withoutTokens++;
      continue;
    }
    const model = r.model ?? 'unknown model';
    const key = `${plan?.id ?? '-'}|${model}`;
    let s = info.get(key);
    if (!s) {
      s = {
        key,
        plan_id: plan?.id ?? null,
        plan_name: plan?.name ?? 'No plan',
        model,
        runs: 0,
        tokens: zero(),
      };
      info.set(key, s);
      hourly.set(
        key,
        Array.from({ length: count }, () => zero()),
      );
    }
    s.runs++;
    const buckets = hourly.get(key) as Tokens[];
    const share = spread(start, Math.min(end, nowMs), first, count);
    share.forEach((f, i) => {
      if (!f) return;
      const b = buckets[i] as Tokens;
      for (const k of TOKEN_KINDS) {
        b[k] += tokens[k] * f;
        s.tokens[k] += tokens[k] * f;
      }
    });
  }

  const ordered = [...info.values()]
    .map((s) => ({ ...s, tokens: roundTokens(s.tokens) }))
    .filter((s) => TOKEN_KINDS.some((k) => s.tokens[k] > 0))
    .sort((a, b) => sum(b.tokens) - sum(a.tokens) || a.key.localeCompare(b.key));

  const hourStart = count - q.hours;
  const hourSeries: BucketSeries[] = [];
  const daySeries: BucketSeries[] = [];
  for (const s of ordered) {
    const buckets = hourly.get(s.key) as Tokens[];
    const hs = emptySeries(s.key, q.hours);
    const ds = emptySeries(s.key, dayBuckets.length);
    buckets.forEach((b, i) => {
      const d = hourDay[i];
      for (const k of TOKEN_KINDS) {
        if (i >= hourStart) (hs[k][i - hourStart] as number) += b[k];
        if (d !== undefined) (ds[k][d] as number) += b[k];
      }
    });
    for (const k of TOKEN_KINDS) {
      hs[k] = hs[k].map(Math.round);
      ds[k] = ds[k].map(Math.round);
    }
    hourSeries.push(hs);
    daySeries.push(ds);
  }

  notes.sort((a, b) => b.started_at.localeCompare(a.started_at) || b.run_id - a.run_id);

  return {
    now: now.toISOString(),
    timezone: tz,
    days: q.days,
    hours: q.hours,
    series: ordered,
    hourly: {
      buckets: Array.from({ length: q.hours }, (_, i) =>
        new Date(first + (hourStart + i) * HOUR).toISOString(),
      ),
      series: hourSeries,
    },
    daily: { buckets: dayBuckets, series: daySeries },
    runs_per_day: {
      buckets: dayBuckets,
      by_kind: [...kinds.entries()]
        .map(([agent_kind, counts]) => ({ agent_kind, counts }))
        .sort((a, b) => a.agent_kind.localeCompare(b.agent_kind)),
    },
    cost_notes: notes.slice(0, 20),
    runs_without_tokens: withoutTokens,
  };
}

function emptySeries(key: string, n: number): BucketSeries {
  const z = () => new Array<number>(n).fill(0);
  return { key, in: z(), out: z(), cache_read: z(), cache_write: z() };
}

function roundTokens(t: Tokens): Tokens {
  return {
    in: Math.round(t.in),
    out: Math.round(t.out),
    cache_read: Math.round(t.cache_read),
    cache_write: Math.round(t.cache_write),
  };
}

const sum = (t: Tokens) => TOKEN_KINDS.reduce((a, k) => a + t[k], 0);

export function usage(db: Db, config: Config, q: UsageQuery, now = new Date()): Usage {
  // Same look-back as aggregateUsage, so runs that overlap the window are included.
  const count = Math.max(q.hours, (q.days + 1) * 24 + 14);
  const first = new Date(Math.floor(now.getTime() / HOUR) * HOUR - (count - 1) * HOUR);
  const rows = db
    .prepare(
      `SELECT id, agent_kind, model, provider, status, started_at, ended_at, tokens_in,
              tokens_out, tokens_cache_read, tokens_cache_write, cost_note
         FROM runs
        WHERE started_at <= ? AND (ended_at IS NULL OR ended_at >= ?)
        ORDER BY started_at, id`,
    )
    .all(now.toISOString(), first.toISOString()) as unknown as UsageRun[];
  return aggregateUsage(rows, config, q, now);
}
