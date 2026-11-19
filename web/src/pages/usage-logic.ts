// Pure helpers for the Usage page: measures, stacking, folding into "Other", labels.

export const TOKEN_KINDS = ['in', 'out', 'cache_read', 'cache_write'] as const;
export type TokenKind = (typeof TOKEN_KINDS)[number];
export type Tokens = Record<TokenKind, number>;

export interface SeriesInfo {
  key: string;
  plan_id: string | null;
  plan_name: string;
  model: string;
  runs: number;
  tokens: Tokens;
}

export interface BucketSeries extends Record<TokenKind, number[]> {
  key: string;
}

export interface Usage {
  now: string;
  timezone: string;
  days: number;
  hours: number;
  series: SeriesInfo[];
  hourly: { buckets: string[]; series: BucketSeries[] };
  daily: { buckets: string[]; series: BucketSeries[] };
  runs_per_day: { buckets: string[]; by_kind: { agent_kind: string; counts: number[] }[] };
  cost_notes: {
    run_id: number;
    started_at: string;
    agent_kind: string;
    model: string | null;
    plan_id: string | null;
    note: string;
  }[];
  runs_without_tokens: number;
}

/** What the bars count. Cache reads dwarf everything else, so they are opt-in. */
export type Measure = 'io' | 'all';
export const MEASURES: [Measure, string][] = [
  ['io', 'In + out'],
  ['all', 'All, with cache'],
];
const MEASURE_KINDS: Record<Measure, readonly TokenKind[]> = {
  io: ['in', 'out'],
  all: TOKEN_KINDS,
};

export function measureOf(t: Tokens, m: Measure): number {
  return MEASURE_KINDS[m].reduce((a, k) => a + t[k], 0);
}

export function measureSeries(s: BucketSeries, m: Measure): number[] {
  const n = s.in.length;
  return Array.from({ length: n }, (_, i) =>
    MEASURE_KINDS[m].reduce((a, k) => a + (s[k][i] ?? 0), 0),
  );
}

/** Categorical slots in the CSS (--series-1..8); the eighth is reserved for "Other". */
export const MAX_SLOTS = 8;
export const OTHER_KEY = '__other__';

export interface Layer {
  key: string;
  label: string;
  slot: number;
  values: number[];
  total: number;
}

/**
 * Up to seven named layers plus "Other". Which series are named depends on the totals; the slot
 * (color) of a named series depends only on its key, sorted, so switching measure or range does
 * not repaint a series that stays.
 */
export function layers(
  info: { key: string; label: string }[],
  series: { key: string; values: number[] }[],
  buckets: number,
): Layer[] {
  const byKey = new Map(series.map((s) => [s.key, s.values]));
  const all = info.map((i) => {
    const values = byKey.get(i.key) ?? new Array<number>(buckets).fill(0);
    return { ...i, values, total: values.reduce((a, b) => a + b, 0) };
  });
  const live = all.filter((t) => t.total > 0);
  live.sort((a, b) => b.total - a.total || a.key.localeCompare(b.key));
  const fits = live.length <= MAX_SLOTS;
  const named = fits ? live : live.slice(0, MAX_SLOTS - 1);
  const rest = fits ? [] : live.slice(MAX_SLOTS - 1);
  const order = [...named].sort((a, b) => a.key.localeCompare(b.key));
  const out: Layer[] = order.map((t, i) => ({
    key: t.key,
    label: t.label,
    slot: i + 1,
    values: t.values,
    total: t.total,
  }));
  if (rest.length) {
    const values = new Array<number>(buckets).fill(0);
    for (const r of rest) r.values.forEach((v, i) => (values[i] = (values[i] ?? 0) + v));
    out.push({
      key: OTHER_KEY,
      label: `Other (${rest.length})`,
      slot: MAX_SLOTS,
      values,
      total: rest.reduce((a, r) => a + r.total, 0),
    });
  }
  return out;
}

export interface Segment {
  key: string;
  slot: number;
  y0: number;
  y1: number;
}

/** Per bucket, the layers stacked bottom-up in layer order (zero layers are skipped). */
export function stack(ls: Layer[], buckets: number): { total: number; segments: Segment[] }[] {
  return Array.from({ length: buckets }, (_, i) => {
    let y = 0;
    const segments: Segment[] = [];
    for (const l of ls) {
      const v = l.values[i] ?? 0;
      if (v <= 0) continue;
      segments.push({ key: l.key, slot: l.slot, y0: y, y1: y + v });
      y += v;
    }
    return { total: y, segments };
  });
}

/** A round axis maximum (1, 2 or 5 times a power of ten) at or above `n`, with its step. */
export function niceMax(n: number, ticks = 4, minStep = 0): { max: number; step: number } {
  if (!(n > 0)) return { max: Math.max(ticks * minStep, 1), step: minStep || 0.25 };
  const raw = n / ticks;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const nice = [1, 2, 2.5, 5, 10].map((m) => m * pow).find((s) => s >= raw) ?? 10 * pow;
  const step = Math.max(nice, minStep);
  return { max: Math.ceil(n / step) * step, step };
}

/** 950, 1.2k, 34k, 1.5M, 2.1B. */
export function fmtTokens(n: number): string {
  const a = Math.abs(n);
  const unit = (d: number, s: string) => {
    const v = n / d;
    const digits = Math.abs(v) < 10 ? 1 : 0;
    return `${v.toFixed(digits).replace(/\.0$/, '')}${s}`;
  };
  if (a >= 1e9) return unit(1e9, 'B');
  if (a >= 1e6) return unit(1e6, 'M');
  if (a >= 1e3) return unit(1e3, 'k');
  return String(Math.round(n));
}

/** Full number with thousands separators, for tables and tooltips. */
export const fmtFull = (n: number) => Math.round(n).toLocaleString('en-US');

export function seriesLabel(s: Pick<SeriesInfo, 'plan_name' | 'model'>): string {
  return `${s.plan_name} · ${s.model}`;
}

/** "Mon 17" for a YYYY-MM-DD local date (the date is already in the site zone). */
export function dayLabel(date: string, long = false): string {
  const d = new Date(`${date}T12:00:00Z`);
  const part = (o: Intl.DateTimeFormatOptions) =>
    new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', ...o }).format(d);
  const wd = part({ weekday: 'short' });
  const day = String(d.getUTCDate());
  return long ? `${wd}, ${part({ month: 'short' })} ${day}` : `${wd} ${day}`;
}

/** "14:00" in the site time zone, with the date when `long`. */
export function hourLabel(iso: string, timeZone: string, long = false): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    ...(long ? { weekday: 'short', day: 'numeric', month: 'short' } : {}),
  }).format(new Date(iso));
}

/** Show every nth axis label so labels about `minPx` wide do not collide. */
export function labelEvery(buckets: number, plotWidth: number, minPx: number): number {
  if (buckets <= 0) return 1;
  const per = plotWidth / buckets;
  return Math.max(1, Math.ceil(minPx / Math.max(per, 0.0001)));
}

export function summaryText(u: Usage, m: Measure): string {
  if (!u.series.length) return `No token counts in the last ${u.days} days`;
  const total = u.series.reduce((a, s) => a + measureOf(s.tokens, m), 0);
  const runs = u.runs_per_day.by_kind.reduce((a, k) => a + k.counts.reduce((x, y) => x + y, 0), 0);
  const plans = new Set(u.series.map((s) => s.plan_id ?? '-')).size;
  return `${fmtTokens(total)} tokens (${m === 'io' ? 'in + out' : 'with cache'}) · ${runs} run${
    runs === 1 ? '' : 's'
  } started · ${plans} plan${plans === 1 ? '' : 's'} · last ${u.days} days`;
}
