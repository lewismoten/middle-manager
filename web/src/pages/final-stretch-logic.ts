// The Burndown "final stretch" view: the last 2 h of readings and the next 2 h of projections,
// zoomed so the approach to target empty and the reset is readable. Pure (no DOM), so it is
// unit tested: the time range, clipping a line to it, the y-axis zoom, where each projection
// is at a given time, the 15-minute ticks, and which view to open.

const HOUR = 3600_000;
const MINUTE = 60_000;

export type BurndownView = 'week' | 'stretch';
/** Hours of readings before now and of projections after now in the zoomed view. */
export const STRETCH_BEFORE_H = 2;
export const STRETCH_AFTER_H = 2;
/** Open the zoomed view by itself when the reset is closer than this (no choice made yet). */
export const AUTO_STRETCH_H = 3;
/** In the zoomed view a reading older than this gets a warning badge. */
export const STRETCH_STALE_MIN = 15;

export interface Span {
  from: number;
  to: number;
}

export interface SeriesPoint {
  t: number;
  used: number;
}

/**
 * The zoomed view's time range: now - 2 h to now + 2 h, clipped to the window's start and its
 * reset. After the reset it shows the last 4 h of the window; before the start, the first 4 h.
 */
export function stretchRange(
  now: number,
  start: number,
  reset: number,
  beforeH = STRETCH_BEFORE_H,
  afterH = STRETCH_AFTER_H,
): Span {
  const at = Math.min(Math.max(now, start), reset);
  let from = Math.max(start, at - beforeH * HOUR);
  let to = Math.min(reset, at + afterH * HOUR);
  // Clipped on one side: keep the full width by showing more of the other side.
  const want = (beforeH + afterH) * HOUR;
  if (to - from < want) {
    if (from === start) to = Math.min(reset, from + want);
    else if (to === reset) from = Math.max(start, to - want);
  }
  return { from, to };
}

/** Used % at time t on a line, linear between points; null outside it. */
export function valueOn(points: SeriesPoint[], t: number): number | null {
  const first = points[0];
  const last = points[points.length - 1];
  if (!first || !last || t < first.t || t > last.t) return null;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1] as SeriesPoint;
    const b = points[i] as SeriesPoint;
    if (t <= b.t) {
      return b.t === a.t ? b.used : a.used + ((b.used - a.used) * (t - a.t)) / (b.t - a.t);
    }
  }
  return last.used;
}

/**
 * The part of a line (oldest first) inside the span, with points added where it crosses either
 * edge, so a line that starts before the range enters at its true height, not clamped.
 */
export function clipLine(points: SeriesPoint[], span: Span): SeriesPoint[] {
  const sorted = [...points].sort((a, b) => a.t - b.t);
  const out: SeriesPoint[] = [];
  const atFrom = valueOn(sorted, span.from);
  if (atFrom !== null && !sorted.some((p) => p.t === span.from)) {
    out.push({ t: span.from, used: atFrom });
  }
  for (const p of sorted) if (p.t >= span.from && p.t <= span.to) out.push(p);
  const atTo = valueOn(sorted, span.to);
  if (atTo !== null && !sorted.some((p) => p.t === span.to)) out.push({ t: span.to, used: atTo });
  return out;
}

/** The even-pace line: 0% at the start, the target % at target empty, flat to the reset. */
export function evenLine(
  start: number,
  targetEmpty: number,
  reset: number,
  targetPct: number,
): SeriesPoint[] {
  const pts = [
    { t: start, used: 0 },
    { t: targetEmpty, used: targetPct },
  ];
  if (reset > targetEmpty) pts.push({ t: reset, used: targetPct });
  return pts;
}

export interface ProjectedPoint {
  t: number;
  used: number;
  /** The allowance runs out (100%) at t, before the time asked for. */
  runsOut: boolean;
}

/**
 * Where a projection from `used` at `now`, at `rate` %/h, is at time t: capped at 100%, and
 * ending early (runsOut) when it reaches 100% before t. A time before now stays at now.
 */
export function projectTo(used: number, rate: number, now: number, t: number): ProjectedPoint {
  const at = Math.max(t, now);
  const value = used + (Math.max(0, rate) * (at - now)) / HOUR;
  if (used >= 100) return { t: now, used: 100, runsOut: true };
  if (value >= 100 && rate > 0) {
    return { t: now + ((100 - used) / rate) * HOUR, used: 100, runsOut: true };
  }
  return { t: at, used: value, runsOut: false };
}

export interface YZoom {
  lo: number;
  hi: number;
  /** The axis does not run from 0 to 100%. */
  zoomed: boolean;
  /** Gridline step in % points. */
  step: number;
}

const stepFor = (span: number) => (span <= 12 ? 2 : span <= 30 ? 5 : span <= 60 ? 10 : 25);

/**
 * A y range that fits the values with a little room, snapped to whole gridline steps, at least
 * `minSpan` points tall, inside 0-100. A range that reaches near 100 is pulled up to 100 so the
 * cap and the reserve stay in view.
 */
export function yZoom(values: number[], minSpan = 10): YZoom {
  const vs = values.filter((v) => Number.isFinite(v)).map((v) => Math.min(100, Math.max(0, v)));
  if (!vs.length) return { lo: 0, hi: 100, zoomed: false, step: 25 };
  let lo = Math.min(...vs) - 1;
  let hi = Math.max(...vs) + 1;
  if (hi > 100 - minSpan / 2) hi = 100;
  if (hi - lo < minSpan) lo = hi - minSpan;
  if (lo < 0) {
    hi = Math.min(100, hi - lo);
    lo = 0;
  }
  let step = stepFor(hi - lo);
  lo = Math.max(0, Math.floor(lo / step) * step);
  hi = Math.min(100, Math.ceil(hi / step) * step);
  step = stepFor(hi - lo);
  lo = Math.max(0, Math.floor(lo / step) * step);
  hi = Math.min(100, Math.ceil(hi / step) * step);
  return { lo, hi, zoomed: lo > 0 || hi < 100, step };
}

/** Gridline values for a y range. */
export function yTicks(z: Pick<YZoom, 'lo' | 'hi' | 'step'>): number[] {
  const out: number[] = [];
  for (let v = z.lo; v <= z.hi + 1e-9; v += z.step) out.push(Math.round(v * 10) / 10);
  return out;
}

/** Every quarter hour strictly inside the span (every zone's offset is a multiple of 15 min). */
export function quarterTicks(span: Span): number[] {
  const step = 15 * MINUTE;
  const out: number[] = [];
  for (let t = Math.ceil(span.from / step) * step; t < span.to; t += step) {
    if (t > span.from) out.push(t);
  }
  return out;
}

/** "read 4 min ago", "read 2 h 5 min ago", "read just now". */
export function readAgo(ageMs: number): string {
  const m = Math.round(ageMs / MINUTE);
  if (m < 1) return 'read just now';
  if (m < 60) return `read ${m} min ago`;
  const h = Math.floor(m / 60);
  return `read ${h} h${m % 60 ? ` ${m % 60} min` : ''} ago`;
}

/** The zoomed view warns when the newest reading is older than 15 minutes. */
export const stretchStale = (ageMs: number) => ageMs > STRETCH_STALE_MIN * MINUTE;

/**
 * Which view to open. A choice in the URL wins, then one the reader made before (stored);
 * otherwise the zoomed view opens by itself when the current week's reset is under 3 h away.
 */
export function pickView(opts: {
  url?: BurndownView | null;
  stored?: BurndownView | null;
  /** The current week's reset, or null when there is none (past week, no readings). */
  reset: number | null;
  now: number;
}): { view: BurndownView; source: 'url' | 'stored' | 'auto' } {
  if (opts.url) return { view: opts.url, source: 'url' };
  if (opts.stored) return { view: opts.stored, source: 'stored' };
  const near =
    opts.reset !== null && opts.reset > opts.now && opts.reset - opts.now < AUTO_STRETCH_H * HOUR;
  return { view: near ? 'stretch' : 'week', source: 'auto' };
}

export function parseView(v: string | null | undefined): BurndownView | null {
  return v === 'week' || v === 'stretch' ? v : null;
}
