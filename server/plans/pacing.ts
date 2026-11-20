// Weekly burndown and pacing (SPEC 7). A line-for-line port of the reference Python
// implementation (window selection, 24 h rate, projection, recent rate, mode), kept identical on
// the same readings; test/pacing.test.ts checks it against values produced by the reference.
// The product forecast in pace() uses the mode rate. analyse() retains the reference 24 h forecast.

export const HOUR_MS = 3600_000;
export const WEEK_MS = 7 * 24 * HOUR_MS;
/** Readings whose reset is within this of the window's reset belong to the same window. */
const SAME_RESET_MS = 3 * HOUR_MS;
export const STOP_AT_PCT = 97;
export const BURN_BELOW = 0.75;
export const CONSERVE_ABOVE = 1.25;
/** A reading older than this is shown as stale. */
export const STALE_AFTER_H = 2;

export type Mode = 'burn' | 'steady' | 'conserve' | 'stop';

export interface Reading {
  /** ISO time the number was read. */
  read_at: string;
  used_pct: number;
  /** ISO time the window resets; readings without one are ignored for pacing. */
  resets_at: string | null;
  machine_id?: string | null;
  how?: string | null;
}

export interface Point {
  t: number;
  used: number;
  machine: string;
  how: string;
}

export interface WeekWindow {
  start: number;
  end: number;
  points: Point[];
}

export interface Analysis {
  start: number;
  end: number;
  used: number;
  last_t: number;
  /** Even pace: the share of the week gone, 0-100. */
  pace: number;
  /** % per hour over the last 24 h of readings (falls back to the window start at 0%). */
  rate: number;
  since: number;
  left_h: number;
  /** Used + rate x hours left, capped at 100. */
  projected: number;
  /** When the plan would hit 100% at the 24 h rate, if before the reset. */
  hit: number | null;
  /** Rate needed to end the week near 95% (the reference's verdict line). */
  need95: number;
  stale_h: number;
  points: Point[];
}

export interface Pace {
  projected: number;
  hit: number | null;
  mode: Mode;
  used_pct: number;
  rate: number;
  rate_basis_h: 3 | 24;
  need: number;
  ratio: number | null;
  target_empty_at: number;
  reset_at: number;
  last_reading: number;
  reading_age_h: number;
}

const ms = (iso: string) => new Date(iso).getTime();

function cmpPoint(a: Point, b: Point): number {
  // Python sorts tuples (time, used, machine, how).
  if (a.t !== b.t) return a.t - b.t;
  if (a.used !== b.used) return a.used - b.used;
  if (a.machine !== b.machine) return a.machine < b.machine ? -1 : 1;
  if (a.how !== b.how) return a.how < b.how ? -1 : 1;
  return 0;
}

/**
 * The current weekly window: the latest future reset (else the latest reset seen) and the
 * distinct readings that belong to it, oldest first.
 */
export function currentWindow(readings: Reading[], now: number): WeekWindow | null {
  const mine = readings.filter((r) => r.resets_at && Number.isFinite(r.used_pct));
  if (!mine.length) return null;
  const resets = mine.map((r) => ms(r.resets_at as string));
  const future = resets.filter((t) => t > now);
  const end = future.length ? Math.max(...future) : Math.max(...resets);
  const seen = new Set<string>();
  const points: Point[] = [];
  mine.forEach((r, i) => {
    if (Math.abs((resets[i] as number) - end) >= SAME_RESET_MS) return;
    const p: Point = {
      t: ms(r.read_at),
      used: r.used_pct,
      machine: r.machine_id ?? '',
      how: r.how ?? '',
    };
    const key = JSON.stringify([p.t, p.used, p.machine, p.how]);
    if (seen.has(key)) return;
    seen.add(key);
    points.push(p);
  });
  points.sort(cmpPoint);
  return { start: end - WEEK_MS, end, points };
}

function ratePerHour(points: Point[], start: number): { rate: number; since: number } {
  const last = points[points.length - 1] as Point;
  const before = points.filter((p) => p.t <= last.t - 24 * HOUR_MS);
  const b = before[before.length - 1];
  const [t0, u0] = b ? [b.t, b.used] : [start, 0];
  const hours = (last.t - t0) / HOUR_MS;
  return { rate: hours > 0.5 ? Math.max(0, (last.used - u0) / hours) : 0, since: t0 };
}

export function analyse(w: WeekWindow, now: number): Analysis {
  const { start, end, points } = w;
  const last = points[points.length - 1] as Point;
  const used = last.used;
  const totalH = WEEK_MS / HOUR_MS;
  const leftH = Math.max(0, (end - now) / HOUR_MS);
  const pace = Math.min(100, Math.max(0, ((now - start) / HOUR_MS / totalH) * 100));
  const { rate, since } = ratePerHour(points, start);
  const projected = Math.min(100, used + rate * leftH);
  const hit =
    rate > 0 && used + rate * leftH >= 100 ? last.t + ((100 - used) / rate) * HOUR_MS : null;
  const need95 = leftH > 0 ? Math.max(0, (95 - used) / leftH) : 0;
  return {
    start,
    end,
    used,
    last_t: last.t,
    pace,
    rate,
    since,
    left_h: leftH,
    projected,
    hit,
    need95,
    stale_h: (now - last.t) / HOUR_MS,
    points,
  };
}

/** Rate over the last 3 h of readings, else 24 h, else the analysis's 24 h rate. */
export function recentRate(a: Analysis): { rate: number; basis: 3 | 24 } {
  const last = a.points[a.points.length - 1] as Point;
  for (const hours of [3, 24] as const) {
    const older = a.points.filter((p) => p.t <= last.t - hours * HOUR_MS);
    const o = older[older.length - 1];
    if (o) {
      const h = (last.t - o.t) / HOUR_MS;
      if (h > 0.5) return { rate: Math.max(0, (last.used - o.used) / h), basis: hours };
    }
  }
  return { rate: a.rate, basis: 24 };
}

export function pace(a: Analysis, now: number, emptyBufferHours = 1): Pace {
  const targetEnd = a.end - emptyBufferHours * HOUR_MS;
  const hours = Math.max(0.25, (targetEnd - now) / HOUR_MS);
  const need = Math.max(0, (100 - a.used) / hours);
  const { rate, basis } = recentRate(a);
  const ratio = need > 0 ? rate / need : Infinity;
  let mode: Mode;
  if (a.used >= STOP_AT_PCT || need === 0) mode = 'stop';
  else if (ratio > CONSERVE_ABOVE) mode = 'conserve';
  else if (ratio < BURN_BELOW) mode = 'burn';
  else mode = 'steady';
  const forecast = a.used + rate * a.left_h;
  return {
    projected: Math.min(100, forecast),
    hit: rate > 0 && forecast >= 100 ? now + (Math.max(0, 100 - a.used) / rate) * HOUR_MS : null,
    mode,
    used_pct: a.used,
    rate,
    rate_basis_h: basis,
    need,
    ratio: Number.isFinite(ratio) ? ratio : null,
    target_empty_at: targetEnd,
    reset_at: a.end,
    last_reading: a.last_t,
    reading_age_h: a.stale_h,
  };
}

/**
 * The model rung a mode suggests from a plan's ladder (cheapest first): burn = top rung,
 * conserve = bottom, steady = the middle (lower middle for an even count), stop = none.
 */
export function suggestedModel(mode: Mode, ladder: string[]): string | null {
  if (!ladder.length || mode === 'stop') return null;
  if (mode === 'burn') return ladder[ladder.length - 1] ?? null;
  if (mode === 'conserve') return ladder[0] ?? null;
  return ladder[Math.floor((ladder.length - 1) / 2)] ?? null;
}

/**
 * Python's round(x, digits): the exact binary value rounded half to even, so display fields such
 * as rate_pct_per_h match the reference to the last digit (toFixed rounds exact ties up).
 */
export function roundTo(x: number, digits: number): number {
  if (!Number.isFinite(x) || x === 0) return x;
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, Math.abs(x));
  const bits = view.getBigUint64(0);
  const expBits = Number((bits >> 52n) & 0x7ffn);
  const frac = bits & ((1n << 52n) - 1n);
  const mant = expBits === 0 ? frac : frac | (1n << 52n);
  const exp = (expBits === 0 ? 1 : expBits) - 1075; // |x| = mant * 2^exp
  if (exp >= 0) return x;
  const denom = 1n << BigInt(-exp);
  const num = mant * 10n ** BigInt(digits);
  let q = num / denom;
  const twice = 2n * (num % denom);
  if (twice > denom || (twice === denom && q % 2n === 1n)) q += 1n;
  return (Math.sign(x) * Number(q)) / 10 ** digits;
}

export interface PastWeek {
  reset_at: string;
  last_reading_at: string;
  used_pct: number;
  unused_pct: number;
  readings: number;
}

/**
 * Past weekly windows (reset before `now`), newest first: the last reading in each window and
 * how much was left unused at its reset. Readings are grouped by reset like currentWindow.
 */
export function pastWeeks(readings: Reading[], now: number): PastWeek[] {
  const groups: { end: number; pts: Reading[] }[] = [];
  const sorted = readings
    .filter((r) => r.resets_at && Number.isFinite(r.used_pct))
    .sort((a, b) => ms(a.resets_at as string) - ms(b.resets_at as string));
  for (const r of sorted) {
    const t = ms(r.resets_at as string);
    const g = groups[groups.length - 1];
    if (g && t - g.end < SAME_RESET_MS) {
      g.pts.push(r);
      g.end = Math.max(g.end, t);
    } else groups.push({ end: t, pts: [r] });
  }
  return groups
    .filter((g) => g.end <= now)
    .map((g) => {
      const last = g.pts.reduce((a, b) =>
        ms(b.read_at) > ms(a.read_at) || (b.read_at === a.read_at && b.used_pct > a.used_pct)
          ? b
          : a,
      );
      return {
        reset_at: new Date(g.end).toISOString(),
        last_reading_at: new Date(ms(last.read_at)).toISOString(),
        used_pct: last.used_pct,
        unused_pct: Math.max(0, 100 - last.used_pct),
        readings: g.pts.length,
      };
    })
    .reverse();
}
