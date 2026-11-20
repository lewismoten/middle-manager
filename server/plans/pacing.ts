// Weekly burndown and pacing (SPEC 7). A line-for-line port of the reference Python
// implementation (window selection, 24 h rate, projection, recent rate, pacing policy), kept
// identical on the same readings; test/pacing.test.ts checks it against values produced by the
// reference. The product forecast in pace() uses the mode rate. analyse() retains the reference
// 24 h forecast.

export const HOUR_MS = 3600_000;
export const WEEK_MS = 7 * 24 * HOUR_MS;
/** Readings whose reset is within this of the window's reset belong to the same window. */
const SAME_RESET_MS = 3 * HOUR_MS;
export const BURN_BELOW = 0.75;
export const CONSERVE_ABOVE = 1.25;
/** A reading older than this is shown as stale. */
export const STALE_AFTER_H = 2;

// Pacing policy. The target at target empty (reset - empty_buffer_hours) is NEAR empty, not
// 100%: the last few % are a reserve for the lead agent and the final-hour jobs.
/** Used % to reach at target empty (config plans[].empty_target_pct). */
export const EMPTY_TARGET_PCT = 97;
/** No new workers at all past this used %. */
export const HARD_STOP_PCT = 99;
/** During the week, get back onto the even-pace line within this many hours. */
export const RECOVER_H = 24;
/** The last this-many hours before target empty aim straight at the target. */
export const FINAL_H = 24;
/** No new launches this many minutes before the reset (config plans[].launch_cutoff_min). */
export const LAUNCH_CUTOFF_MIN = 30;
/** Points ahead of the even-pace line (during the week) before the mode says conserve. */
export const AHEAD_BAND = 5;

/**
 * stop = no new workers (the lead keeps running); finish = final hour, short jobs only.
 */
export type Mode = 'burn' | 'steady' | 'conserve' | 'finish' | 'stop';
/** week = follow the even line; final = last FINAL_H h, aim at the target; final-hour = after it. */
export type Phase = 'week' | 'final' | 'final-hour';

export interface PacePolicy {
  /** Hours before the reset the plan should be near empty (default 1). */
  emptyBufferHours?: number;
  /** Used % to reach at target empty (default 97). */
  emptyTargetPct?: number;
  /** Minutes before the reset after which nothing new launches (default 30). */
  launchCutoffMin?: number;
}

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
  phase: Phase;
  used_pct: number;
  /** Even pace now: 0% at the window start to empty_target_pct at target empty. */
  even_pace: number;
  /** Used minus even pace, % points (+ = ahead of the line, using faster). */
  off_pace: number;
  empty_target_pct: number;
  launch_cutoff_at: number;
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
 * distinct readings that belong to it, oldest first. `windowMs` is the plan's window length.
 */
export function currentWindow(
  readings: Reading[],
  now: number,
  windowMs = WEEK_MS,
): WeekWindow | null {
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
  return { start: end - windowMs, end, points };
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
  const totalH = (end - start) / HOUR_MS;
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

/** The even-pace line at time t: 0% at `start` to `targetPct` at `targetEnd`, flat after. */
export function evenLine(
  start: number,
  targetEnd: number,
  t: number,
  targetPct = EMPTY_TARGET_PCT,
) {
  const span = targetEnd - start;
  const f = span > 0 ? Math.min(1, Math.max(0, (t - start) / span)) : 1;
  return targetPct * f;
}

/**
 * The mode for a plan now (reference pace()). During the week the target is the even-pace line,
 * recovered within RECOVER_H hours; the last FINAL_H hours before target empty aim straight at
 * empty_target_pct; the final hour (target empty to reset) is "finish". "stop" (no new workers;
 * never the lead) applies from the launch cutoff, at HARD_STOP_PCT used, or once the target is
 * reached before target empty. `policy` may be a number: the empty buffer in hours.
 */
export function pace(a: Analysis, now: number, policy: number | PacePolicy = {}): Pace {
  const pol = typeof policy === 'number' ? { emptyBufferHours: policy } : policy;
  const bufferH = pol.emptyBufferHours ?? 1;
  const emptyPct = pol.emptyTargetPct ?? EMPTY_TARGET_PCT;
  const cutoffMin = pol.launchCutoffMin ?? LAUNCH_CUTOFF_MIN;
  const end = a.end;
  const start = a.start;
  const targetEnd = end - bufferH * HOUR_MS;
  const used = a.used;
  const { rate, basis } = recentRate(a);
  const evenNow = evenLine(start, targetEnd, now, emptyPct);
  const toTargetH = (targetEnd - now) / HOUR_MS;
  let phase: Phase;
  let need: number;
  if (toTargetH <= 0) {
    phase = 'final-hour';
    need = 0;
  } else if (toTargetH <= FINAL_H) {
    phase = 'final';
    need = Math.max(0, (emptyPct - used) / Math.max(0.25, toTargetH));
  } else {
    phase = 'week';
    const h = Math.min(RECOVER_H, toTargetH);
    need = Math.max(0, (evenLine(start, targetEnd, now + h * HOUR_MS, emptyPct) - used) / h);
  }
  const ratio = need > 0 ? rate / need : Infinity;
  const cutoff = end - cutoffMin * 60_000;
  let mode: Mode;
  if (used >= HARD_STOP_PCT || now >= cutoff) mode = 'stop';
  else if (phase === 'final-hour') mode = 'finish';
  // The reserve reached early: keep it for the lead and the final hour.
  else if (used >= emptyPct) mode = 'stop';
  else if (phase === 'week' && used > evenNow + AHEAD_BAND) mode = 'conserve';
  else if (ratio > CONSERVE_ABOVE) mode = 'conserve';
  else if (ratio < BURN_BELOW) mode = 'burn';
  else mode = 'steady';
  const forecast = used + rate * a.left_h;
  return {
    projected: Math.min(100, forecast),
    hit: rate > 0 && forecast >= 100 ? now + (Math.max(0, 100 - used) / rate) * HOUR_MS : null,
    mode,
    phase,
    used_pct: used,
    even_pace: evenNow,
    off_pace: used - evenNow,
    empty_target_pct: emptyPct,
    launch_cutoff_at: cutoff,
    rate,
    rate_basis_h: basis,
    need,
    ratio: Number.isFinite(ratio) ? ratio : null,
    target_empty_at: targetEnd,
    reset_at: end,
    last_reading: a.last_t,
    reading_age_h: a.stale_h,
  };
}

// ---- Short-window rates (1 h and 2 h) ----
// Reported next to the mode rate so a change in burn shows up quickly. They never feed the mode.

export const SHORT_WINDOWS_H = [1, 2] as const;
export type ShortWindowH = (typeof SHORT_WINDOWS_H)[number];
/** The readings must cover at least this much of the short window. */
export const SHORT_MIN_SPAN_H = 0.5;

export type ShortReason = 'window_ended' | 'no_recent_readings' | 'short_span';

export interface ShortProjection {
  window_h: ShortWindowH;
  /** % per hour between the two readings used, never negative; null when not enough data. */
  rate: number | null;
  /** The older reading the rate starts from (the window start at 0% after a reset). */
  since: number | null;
  /** The newer reading the rate ends at. */
  until: number | null;
  /** Hours of the short window the readings cover. */
  covered_h: number;
  /** Used + rate x hours left, capped at 100. */
  projected: number | null;
  /** When the plan reaches 100% at this rate, if before the reset (or when it already did). */
  hit: number | null;
  reason: ShortReason | null;
  /** Plain-language reason when null, else null. */
  reason_text: string | null;
}

const minutes = (h: number) => `${Math.round(h * 60)} min`;

/**
 * Rate over the last `hours` hours: from the reading at or just before now - hours (the window
 * start at 0% if the week began inside the short window) to the newest reading. A reading more
 * than `hours` before the short window is too old to stand for it (a gap in readings); then the
 * first reading inside the window is used instead. The readings must cover at least 30 min of
 * the short window, else the rate is null with a reason. Projects to the reset from `now`, the
 * same way pace() does.
 */
export function shortProjection(a: Analysis, now: number, hours: ShortWindowH): ShortProjection {
  const out: ShortProjection = {
    window_h: hours,
    rate: null,
    since: null,
    until: null,
    covered_h: 0,
    projected: null,
    hit: null,
    reason: null,
    reason_text: null,
  };
  const fail = (reason: ShortReason, text: string) => ({ ...out, reason, reason_text: text });
  if (a.end <= now)
    return fail('window_ended', 'the weekly window has reset; waiting for a new reading');
  const from = now - hours * HOUR_MS;
  // Readings up to now, plus the window start at 0% when no reading predates it.
  const pts: { t: number; used: number }[] = a.points.filter((p) => p.t <= now);
  if (!pts.some((p) => p.t <= a.start)) pts.unshift({ t: a.start, used: 0 });
  const last = pts[pts.length - 1];
  if (!last || last.t <= from) {
    return fail('no_recent_readings', `no reading in the last ${hours} h`);
  }
  let anchor = pts.filter((p) => p.t <= from).pop();
  let gap = false;
  if (anchor && anchor.t < from - hours * HOUR_MS) {
    anchor = undefined;
    gap = true;
  }
  anchor ??= pts.find((p) => p.t > from);
  const covered = anchor ? (last.t - Math.max(anchor.t, from)) / HOUR_MS : 0;
  out.covered_h = Math.max(0, covered);
  if (!anchor || anchor === last || covered < SHORT_MIN_SPAN_H) {
    return fail(
      'short_span',
      `readings cover ${minutes(out.covered_h)} of the last ${hours} h (need ${minutes(SHORT_MIN_SPAN_H)})` +
        (gap ? '; gap in readings before that' : ''),
    );
  }
  const rate = Math.max(0, (last.used - anchor.used) / ((last.t - anchor.t) / HOUR_MS));
  const leftH = Math.max(0, (a.end - now) / HOUR_MS);
  const forecast = a.used + rate * leftH;
  let hit: number | null = null;
  if (a.used >= 100) {
    hit = (a.points.find((p) => p.used >= 100) as Point).t;
  } else if (rate > 0 && forecast >= 100) {
    hit = now + ((100 - a.used) / rate) * HOUR_MS;
  }
  return {
    ...out,
    rate,
    since: anchor.t,
    until: last.t,
    projected: Math.min(100, forecast),
    hit,
  };
}

/**
 * The model rung a mode suggests from a plan's ladder (cheapest first): burn = top rung,
 * conserve and finish (short jobs only) = bottom, steady = the middle (lower middle for an even
 * count), stop = none.
 */
export function suggestedModel(mode: Mode, ladder: string[]): string | null {
  if (!ladder.length || mode === 'stop') return null;
  if (mode === 'burn') return ladder[ladder.length - 1] ?? null;
  if (mode === 'conserve' || mode === 'finish') return ladder[0] ?? null;
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

// ---- Plan windows (current and past), for browsing and comparing weeks ----
// Readings report the reset time with jitter (milliseconds to minutes, and a few minutes between
// two sources), so windows are formed by chaining readings whose resets lie within SAME_RESET_MS
// of each other, never by exact resets_at.

export interface PlanWindow {
  /** Stable id: the window's reset time (median of its readings' resets_at), ISO. */
  id: string;
  start: number;
  end: number;
  /** Window length in hours (the plan's length, shorter when the previous reset came early). */
  length_h: number;
  current: boolean;
  points: Point[];
  final: number;
  peak: number;
  /** First reading at or over 100%, if any. */
  ran_out_at: number | null;
  /** Data starts well after the window start or stops well before the reset. */
  partial: boolean;
}

/** A window's readings are "partial" when they start or stop this far from its edges. */
export const PARTIAL_GAP_MS = 6 * HOUR_MS;

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor((s.length - 1) / 2)] as number;
}

/** A weekly window's readings, grouped and summarized (no "now" involved, so cacheable). */
export interface WindowGroup {
  end: number;
  start: number;
  /** The latest reported reset in the group. */
  last_reset: number;
  points: Point[];
  final: number;
  peak: number;
  ran_out_at: number | null;
}

/**
 * Groups readings into weekly windows, oldest first. `windowMs` is the plan's window length.
 * A window starts `windowMs` before its reset, or at the previous window's reset when that came
 * more than SAME_RESET_MS later and this window has no readings from before it (a shorter
 * window).
 */
export function groupWindows(readings: Reading[], windowMs = WEEK_MS): WindowGroup[] {
  const sorted = readings
    .filter((r) => r.resets_at && Number.isFinite(r.used_pct))
    .map((r) => ({ r, reset: ms(r.resets_at as string) }))
    .filter((x) => Number.isFinite(x.reset))
    .sort((a, b) => a.reset - b.reset);
  const groups: { last: number; items: typeof sorted }[] = [];
  for (const x of sorted) {
    const g = groups[groups.length - 1];
    if (g && x.reset - g.last < SAME_RESET_MS) {
      g.items.push(x);
      g.last = x.reset;
    } else groups.push({ last: x.reset, items: [x] });
  }
  const out: WindowGroup[] = [];
  let prevEnd: number | null = null;
  for (const g of groups) {
    const end = median(g.items.map((x) => x.reset));
    let start = end - windowMs;
    // A reset that follows the previous one too closely: either this window is shorter (its
    // readings begin after the previous reset) or the previous window was reset early and this
    // one already has readings from before that reset, so it keeps its full length.
    if (prevEnd !== null && prevEnd > start + SAME_RESET_MS) {
      let first = Infinity;
      for (const x of g.items) {
        const t = ms(x.r.read_at);
        if (t < first) first = t;
      }
      if (!Number.isFinite(first) || first >= prevEnd - SAME_RESET_MS) start = prevEnd;
    }
    prevEnd = end;
    const seen = new Set<string>();
    const points: Point[] = [];
    for (const { r } of g.items) {
      const p: Point = {
        t: ms(r.read_at),
        used: r.used_pct,
        machine: r.machine_id ?? '',
        how: r.how ?? '',
      };
      // machine and how never hold a NUL (store.ts allows [\w.:@-] only).
      const key = `${p.t}\0${p.used}\0${p.machine}\0${p.how}`;
      if (seen.has(key) || !Number.isFinite(p.t)) continue;
      seen.add(key);
      points.push(p);
    }
    points.sort(cmpPoint);
    if (!points.length) continue;
    let peak = -Infinity;
    for (const p of points) if (p.used > peak) peak = p.used;
    out.push({
      end,
      start,
      last_reset: g.last,
      points,
      // The newest reading wins; at the same instant the higher one (as pastWeeks does).
      final: (points[points.length - 1] as Point).used,
      peak,
      ran_out_at: points.find((p) => p.used >= 100)?.t ?? null,
    });
  }
  return out;
}

/**
 * The windows of groupWindows() as of `now`, newest first. Only the newest window can be
 * current (an early reset leaves the one before it with a reset time still ahead).
 */
export function windowsAt(groups: WindowGroup[], now: number): PlanWindow[] {
  return groups
    .map((g, i): PlanWindow => {
      const current = i === groups.length - 1 && g.last_reset > now;
      const first = (g.points[0] as Point).t;
      const last = (g.points[g.points.length - 1] as Point).t;
      return {
        id: new Date(g.end).toISOString(),
        start: g.start,
        end: g.end,
        length_h: (g.end - g.start) / HOUR_MS,
        current,
        points: g.points,
        final: g.final,
        peak: g.peak,
        ran_out_at: g.ran_out_at,
        partial:
          first - g.start > PARTIAL_GAP_MS ||
          (!current && g.ran_out_at === null && g.end - last > PARTIAL_GAP_MS),
      };
    })
    .reverse();
}

/** Every weekly window in the readings, newest first (groupWindows + windowsAt). */
export function planWindows(readings: Reading[], now: number, windowMs = WEEK_MS): PlanWindow[] {
  return windowsAt(groupWindows(readings, windowMs), now);
}

/** The window a time names: the one whose reset is within SAME_RESET_MS of it. */
export function findWindow(windows: PlanWindow[], reset: number): PlanWindow | null {
  let best: PlanWindow | null = null;
  for (const w of windows) {
    const d = Math.abs(w.end - reset);
    if (d < SAME_RESET_MS && (!best || d < Math.abs(best.end - reset))) best = w;
  }
  return best;
}

export interface WindowStats {
  /** 100 - final, or 0 when it ran out. */
  unused_pct: number;
  /** Unused share expressed as hours of even-pace use (unused % x window hours). */
  unused_h: number;
  /** Hours from running out to the reset (no allowance left), or null. */
  locked_out_h: number | null;
  target_empty_at: number;
  /** Final % minus the 100% target (0 when it ran out). Negative = left unused. */
  target_gap_pct: number;
  /** Hours it ran out before the target-empty time (negative = after), or null. */
  ran_out_early_h: number | null;
  /**
   * Time-weighted mean of (used - even pace) over the readings, % points (+ = ahead). Even pace
   * runs from 0% at the start to empty_target_pct at target empty.
   */
  mean_vs_even_pct: number | null;
  /** Time-weighted mean of |used - even pace|, % points: lower = steadier pacing. */
  mean_abs_vs_even_pct: number | null;
}

/**
 * Summary numbers for one window. Between readings the used % is taken as linear; the window
 * start counts as 0% only when the readings begin near it (not for a partial week).
 */
export function windowStats(
  w: PlanWindow,
  emptyBufferHours = 1,
  emptyTargetPct = EMPTY_TARGET_PCT,
): WindowStats {
  const ranOut = w.ran_out_at !== null;
  const unused = ranOut ? 0 : Math.max(0, 100 - w.final);
  const target = w.end - emptyBufferHours * HOUR_MS;
  // The same even-pace line as pace(): 0% at the start to the target % at target empty.
  const even = (t: number) => evenLine(w.start, target, t, emptyTargetPct);
  const pts: { t: number; used: number }[] = w.points
    .filter((p) => p.t >= w.start && p.t <= w.end)
    .map((p) => ({ t: p.t, used: p.used }));
  if (pts.length && (pts[0] as { t: number }).t - w.start <= PARTIAL_GAP_MS) {
    pts.unshift({ t: w.start, used: 0 });
  }
  let area = 0;
  let absArea = 0;
  let span = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1] as { t: number; used: number };
    const b = pts[i] as { t: number; used: number };
    const dt = b.t - a.t;
    if (dt <= 0) continue;
    // Difference is linear on the segment; integrate exactly, splitting at a sign change.
    const d0 = a.used - even(a.t);
    const d1 = b.used - even(b.t);
    area += ((d0 + d1) / 2) * dt;
    if (d0 * d1 >= 0) absArea += ((Math.abs(d0) + Math.abs(d1)) / 2) * dt;
    else {
      const f = Math.abs(d0) / (Math.abs(d0) + Math.abs(d1));
      absArea += (Math.abs(d0) / 2) * f * dt + (Math.abs(d1) / 2) * (1 - f) * dt;
    }
    span += dt;
  }
  return {
    unused_pct: unused,
    unused_h: (unused / 100) * w.length_h,
    locked_out_h: ranOut ? Math.max(0, (w.end - (w.ran_out_at as number)) / HOUR_MS) : null,
    target_empty_at: target,
    target_gap_pct: ranOut ? 0 : w.final - 100,
    ran_out_early_h: ranOut ? (target - (w.ran_out_at as number)) / HOUR_MS : null,
    mean_vs_even_pct: span > 0 ? area / span : null,
    mean_abs_vs_even_pct: span > 0 ? absArea / span : null,
  };
}
