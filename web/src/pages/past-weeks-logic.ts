// Past weeks on the Burndown page: aligning other weeks onto the shown week's time axis, the
// average of past weeks, what "Compare with" picks, labels, and the page state kept in the URL
// and localStorage. Pure (no DOM), so it is unit tested.

const HOUR = 3600_000;
/** A week whose first reading is further than this from its start does not begin at 0%. */
export const PARTIAL_GAP_MS = 6 * HOUR;
/** Windows whose lengths differ by more than this are scaled, not just shifted. */
const SAME_LENGTH_MS = 60_000;
export const MAX_COMPARE = 4;

/** One weekly window as listed by GET /plans/:id/windows (server/plans/service.ts). */
export interface WindowSummary {
  id: string;
  current: boolean;
  start: string;
  reset_at: string;
  length_h: number;
  readings: number;
  first_reading_at: string;
  last_reading_at: string;
  final_pct: number;
  peak_pct: number;
  ran_out: boolean;
  ran_out_at: string | null;
  unused_pct: number;
  unused_h: number;
  locked_out_h: number | null;
  target_empty_at: string;
  target_gap_pct: number;
  ran_out_early_h: number | null;
  mean_vs_even_pct: number | null;
  mean_abs_vs_even_pct: number | null;
  partial: boolean;
}

export interface SeriesPoint {
  t: number;
  used: number;
}

export interface Span {
  start: number;
  end: number;
}

export interface AlignedSeries {
  /** Points on the target window's time axis, oldest first. */
  points: SeriesPoint[];
  /** The line starts at 0% at the window start (the readings begin near it). */
  fromZero: boolean;
  /** The source window had a different length, so time was scaled by elapsed fraction. */
  scaled: boolean;
  /** Source length in hours. */
  length_h: number;
}

/**
 * Moves a week's readings onto another window's time axis by time since window start. When the
 * two windows have different lengths, each reading keeps its elapsed fraction instead (so the
 * reset lines up with the reset). Readings outside the source window are clamped to it.
 */
export function alignSeries(points: SeriesPoint[], src: Span, dst: Span): AlignedSeries {
  const srcLen = src.end - src.start;
  const dstLen = dst.end - dst.start;
  const scaled = Math.abs(srcLen - dstLen) > SAME_LENGTH_MS;
  const k = scaled && srcLen > 0 ? dstLen / srcLen : 1;
  const sorted = [...points].sort((a, b) => a.t - b.t);
  const first = sorted[0];
  const fromZero = !!first && first.t - src.start <= PARTIAL_GAP_MS;
  const moved = sorted.map((p) => {
    const elapsed = Math.min(Math.max(p.t - src.start, 0), srcLen);
    return { t: dst.start + elapsed * k, used: p.used };
  });
  if (fromZero && (moved[0]?.t ?? 0) > dst.start) moved.unshift({ t: dst.start, used: 0 });
  return { points: moved, fromZero, scaled, length_h: srcLen / HOUR };
}

/**
 * Used % at time t on a series, linear between readings; null before its first point or after
 * its last (no guessing past the data).
 */
export function valueAt(points: SeriesPoint[], t: number): number | null {
  const first = points[0];
  const last = points[points.length - 1];
  if (!first || !last || t < first.t || t > last.t) return null;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1] as SeriesPoint;
    const b = points[i] as SeriesPoint;
    if (t <= b.t) {
      if (b.t === a.t) return Math.max(a.used, b.used);
      return a.used + ((b.used - a.used) * (t - a.t)) / (b.t - a.t);
    }
  }
  return last.used;
}

/**
 * The average of several aligned weeks, sampled across the window. A sample needs at least two
 * weeks with data there (one week alone is not an average); the result is the longest run of
 * such samples, so it never jumps across a hole.
 */
export function averageSeries(series: SeriesPoint[][], dst: Span, samples = 168): SeriesPoint[] {
  if (series.length < 2) return [];
  const runs: SeriesPoint[][] = [];
  let run: SeriesPoint[] = [];
  for (let i = 0; i <= samples; i++) {
    const t = dst.start + ((dst.end - dst.start) * i) / samples;
    const vals = series.map((s) => valueAt(s, t)).filter((v): v is number => v !== null);
    if (vals.length >= 2) run.push({ t, used: vals.reduce((a, b) => a + b, 0) / vals.length });
    else if (run.length) {
      runs.push(run);
      run = [];
    }
  }
  if (run.length) runs.push(run);
  return runs.reduce<SeriesPoint[]>((best, r) => (r.length > best.length ? r : best), []);
}

// ---- What "Compare with" picks ----

export type CompareMode = 'none' | 'last' | 'last2' | 'last3' | 'last4' | `week:${string}`;

export function parseCompare(v: string | null | undefined): CompareMode {
  if (!v) return 'none';
  if (v === 'none' || v === 'last' || /^last[234]$/.test(v)) return v as CompareMode;
  if (/^week:\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(v)) return v as CompareMode;
  return 'none';
}

/**
 * The windows to overlay on the shown one, newest first. "Last N weeks" means the N windows just
 * before the shown one (so they move with Prev / Next); a chosen week stays fixed.
 */
export function compareWindows<W extends { id: string }>(
  windows: W[],
  shownId: string,
  mode: CompareMode,
): W[] {
  if (mode === 'none') return [];
  const at = windows.findIndex((w) => w.id === shownId);
  if (mode.startsWith('week:')) {
    const id = mode.slice(5);
    const w = windows.find((x) => x.id === id);
    return w && w.id !== shownId ? [w] : [];
  }
  const n = mode === 'last' ? 1 : Number(mode.slice(4));
  // Not in the list (the current week before its first window entry): all windows are older.
  return windows.slice(at + 1, at + 1 + Math.min(n, MAX_COMPARE));
}

/** Finished windows for the average line: up to four just before the shown one. */
export function averageWindows<W extends { id: string; current: boolean }>(
  windows: W[],
  shownId: string,
): W[] {
  const at = windows.findIndex((w) => w.id === shownId);
  return windows
    .slice(at + 1)
    .filter((w) => !w.current)
    .slice(0, MAX_COMPARE);
}

/** Dash patterns for overlays, newest first; the average gets its own. */
export const OVERLAY_DASHES = ['7 4', '2 3', '10 3 2 3', '1 4'] as const;
export const AVERAGE_DASH = '12 4';

// ---- Labels ----

function parts(t: number, tz?: string): { month: string; day: string; year: string } {
  const p = new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: tz,
  }).formatToParts(new Date(t));
  const get = (type: string) => p.find((x) => x.type === type)?.value ?? '';
  return { month: get('month'), day: get('day'), year: get('year') };
}

/**
 * A window's dates: "Nov 13 – Nov 20" in full, "Nov 6–13" compact (month once when it does not
 * change), in the given time zone.
 */
export function rangeLabel(start: number, end: number, tz?: string, compact = false): string {
  const a = parts(start, tz);
  const b = parts(end, tz);
  if (!compact) return `${a.month} ${a.day} – ${b.month} ${b.day}`;
  return a.month === b.month
    ? `${a.month} ${a.day}–${b.day}`
    : `${a.month} ${a.day}–${b.month} ${b.day}`;
}

/** "Nov 6–13: 91%" ("ran out", "85% so far") for an overlay's end label. */
export function overlayLabel(w: WindowSummary, tz?: string): string {
  const range = rangeLabel(Date.parse(w.start), Date.parse(w.reset_at), tz, true);
  const value = w.ran_out ? 'ran out' : `${Math.round(w.final_pct)}%`;
  return `${range}: ${value}${w.current && !w.ran_out ? ' so far' : ''}`;
}

/** Compact end label for narrow charts: "Nov 6: 91%" (start date), "Nov 6: out". */
export function overlayShortLabel(w: WindowSummary, tz?: string): string {
  const a = parts(Date.parse(w.start), tz);
  return `${a.month} ${a.day}: ${w.ran_out ? 'out' : `${Math.round(w.final_pct)}%`}`;
}

/** Signed hours, "12 h" / "1.5 h". */
export function hours(v: number): string {
  const a = Math.abs(v);
  return `${a >= 10 ? Math.round(a) : Math.round(a * 10) / 10} h`;
}

/** The "vs target" cell: how far the week ended from running out at the target time. */
export function targetText(w: WindowSummary): string {
  if (w.ran_out && w.ran_out_early_h !== null) {
    if (Math.abs(w.ran_out_early_h) < 0.5) return 'on target';
    return w.ran_out_early_h > 0
      ? `ran out ${hours(w.ran_out_early_h)} early`
      : `${hours(w.ran_out_early_h)} after target`;
  }
  const gap = Math.round(w.target_gap_pct);
  return gap === 0 ? 'on target' : `${Math.abs(gap)} pts unused`;
}

/** Spaces label positions (pixel y, any order) at least `gap` apart inside [top, bottom]. */
export function spreadLabels(ys: number[], gap: number, top: number, bottom: number): number[] {
  const order = ys.map((y, i) => ({ y: Math.min(Math.max(y, top), bottom), i }));
  order.sort((a, b) => a.y - b.y);
  for (let k = 1; k < order.length; k++) {
    const prev = order[k - 1] as { y: number };
    const cur = order[k] as { y: number };
    if (cur.y - prev.y < gap) cur.y = prev.y + gap;
  }
  // Pushed past the bottom: shift the stack back up.
  const over = (order[order.length - 1]?.y ?? 0) - bottom;
  if (over > 0) {
    for (const o of order) o.y -= over;
    for (let k = order.length - 2; k >= 0; k--) {
      const next = order[k + 1] as { y: number };
      const cur = order[k] as { y: number };
      if (next.y - cur.y < gap) cur.y = next.y - gap;
    }
  }
  const out: number[] = new Array<number>(ys.length);
  for (const o of order) out[o.i] = o.y;
  return out;
}

// ---- Page state: URL (#/burndown?plan=&week=&compare=&avg=&view=) and localStorage ----

export interface BurndownState {
  /** "stretch" (last 2 h + next 2 h) or "week" when chosen; null = not chosen (automatic). */
  view?: 'week' | 'stretch' | null;
  plan: string | null;
  /** "current" or a window id (reset time ISO). */
  week: string;
  compare: CompareMode;
  avg: boolean;
}

export function parseState(hash: string): Partial<BurndownState> {
  const q = hash.includes('?') ? new URLSearchParams(hash.slice(hash.indexOf('?') + 1)) : null;
  if (!q) return {};
  const out: Partial<BurndownState> = {};
  const plan = q.get('plan');
  if (plan && /^[\w.-]{1,64}$/.test(plan)) out.plan = plan;
  const week = q.get('week');
  if (week === 'current' || (week && /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(week))) out.week = week;
  if (q.has('compare')) out.compare = parseCompare(q.get('compare'));
  if (q.has('avg')) out.avg = q.get('avg') === '1';
  const view = q.get('view');
  if (view === 'week' || view === 'stretch') out.view = view;
  return out;
}

/** The hash for a state; defaults are left out so the plain page stays "#/burndown". */
export function stateHash(s: BurndownState): string {
  const q = new URLSearchParams();
  if (s.plan) q.set('plan', s.plan);
  if (s.week !== 'current') q.set('week', s.week);
  if (s.compare !== 'none') q.set('compare', s.compare);
  if (s.avg) q.set('avg', '1');
  if (s.view) q.set('view', s.view);
  const text = q.toString();
  return text ? `#/burndown?${text}` : '#/burndown';
}
