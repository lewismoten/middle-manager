export type Mode = 'burn' | 'steady' | 'conserve' | 'finish' | 'stop';
/** week = follow the even-pace line; final = last 24 h before target empty; then final-hour. */
export type Phase = 'week' | 'final' | 'final-hour';

/** Projection at the rate over the last 1 or 2 hours (server/plans/service.ts). */
export interface ShortProjection {
  window_h: 1 | 2;
  rate_pct_per_h: number | null;
  since: string | null;
  until: string | null;
  covered_h: number;
  projected_pct: number | null;
  runs_out_at: string | null;
  reason: 'window_ended' | 'no_recent_readings' | 'short_span' | null;
  reason_text: string | null;
}

export interface WeeklyPace {
  current: boolean;
  start: string;
  reset_at: string;
  target_empty_at: string;
  /** No new launches from this time (older servers leave it out). */
  launch_cutoff_at?: string;
  /** Used % to reach at target empty; above it is the reserve. */
  empty_target_pct?: number;
  used_pct: number;
  /** Even pace now: 0% at the window start to empty_target_pct at target empty. */
  even_pace_pct: number;
  /** Used minus even pace, % points (+ = ahead). */
  off_pace_pts?: number;
  phase?: Phase;
  hours_left: number;
  rate_24h: number;
  rate_24h_since: string;
  projected_pct: number;
  unused_pct: number;
  runs_out_at: string | null;
  mode: Mode;
  rate_pct_per_h: number;
  rate_basis_h: number;
  need_pct_per_h: number;
  ratio: number | null;
  suggested_model: string | null;
  last_reading_at: string;
  reading_age_h: number;
  stale: boolean;
  readings: number;
  projection_1h?: ShortProjection;
  projection_2h?: ShortProjection;
}

export const pct = (v: number, digits = 0) => `${v.toFixed(digits)}%`;

/** The minus sign for signed numbers on screen (U+2212, not a hyphen). */
const MINUS = '\u2212';

/** "+3.2", "−10.8", "0.0": a signed number with one decimal. */
export function signed(v: number, digits = 1): string {
  const r = Number(v.toFixed(digits));
  if (r === 0) return (0).toFixed(digits);
  return `${r > 0 ? '+' : MINUS}${Math.abs(r).toFixed(digits)}`;
}

/** "Off pace: −10.8 pts" (behind the even-pace line) or "+3.2 pts" (ahead); null if unknown. */
export function offPace(w: Pick<WeeklyPace, 'off_pace_pts'>): string | null {
  if (w.off_pace_pts === undefined || !Number.isFinite(w.off_pace_pts)) return null;
  return `Off pace: ${signed(w.off_pace_pts)} pts`;
}

export function burnForecast(
  w: Pick<
    WeeklyPace,
    'mode' | 'current' | 'unused_pct' | 'rate_pct_per_h' | 'rate_basis_h' | 'need_pct_per_h'
  >,
): string | null {
  if (!w.current || w.mode !== 'burn') return null;
  if (w.rate_pct_per_h === 0) return `no use in the last ${w.rate_basis_h} h`;
  return `~${pct(w.unused_pct)} unused at this rate · need ${(w.need_pct_per_h / w.rate_pct_per_h).toFixed(1)}x pace`;
}

/** "97% at reset", "runs out Fri 5:10 PM" or "not enough readings"; `time` formats an ISO time. */
export function shortOutcome(p: ShortProjection, time: (iso: string) => string): string {
  if (p.runs_out_at) return `runs out ${time(p.runs_out_at)}`;
  if (p.projected_pct !== null) return `${pct(p.projected_pct)} at reset`;
  return p.reason === 'window_ended' ? 'window has reset' : 'not enough readings';
}

/** The 1 h and 2 h projections a weekly pace carries, longest window first. */
export function shortProjections(w: Pick<WeeklyPace, 'projection_1h' | 'projection_2h'>) {
  return [w.projection_2h, w.projection_1h].filter((p): p is ShortProjection => !!p);
}

/** "Last 2 h: 97% at reset · Last 1 h: runs out Fri 5:10 PM", or null when not reported. */
export function shortProjectionsText(
  w: Pick<WeeklyPace, 'projection_1h' | 'projection_2h'>,
  time: (iso: string) => string,
): string | null {
  const list = shortProjections(w);
  if (!list.length) return null;
  return list.map((p) => `Last ${p.window_h} h: ${shortOutcome(p, time)}`).join(' · ');
}
