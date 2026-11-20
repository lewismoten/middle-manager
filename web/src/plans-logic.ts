export type Mode = 'burn' | 'steady' | 'conserve' | 'stop';

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
  used_pct: number;
  even_pace_pct: number;
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

export function paceDifference(
  w: Pick<WeeklyPace, 'even_pace_pct' | 'projected_pct'>,
): string | null {
  const gap = w.even_pace_pct - w.projected_pct;
  if (Math.abs(gap) < 1) return null;
  const points = Math.round(Math.abs(gap));
  return `${points} ${points === 1 ? 'pt' : 'pts'} ${gap > 0 ? 'behind' : 'ahead of'} even pace`;
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
