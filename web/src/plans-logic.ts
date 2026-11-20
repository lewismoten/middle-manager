export type Mode = 'burn' | 'steady' | 'conserve' | 'stop';

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
}

export const pct = (v: number, digits = 0) => `${v.toFixed(digits)}%`;

export function burnForecast(
  w: Pick<WeeklyPace, 'mode' | 'current' | 'unused_pct' | 'rate_pct_per_h' | 'need_pct_per_h'>,
): string | null {
  if (!w.current || w.mode !== 'burn') return null;
  if (w.rate_pct_per_h === 0) return 'no use in the last 3 h';
  return `~${pct(w.unused_pct)} unused at this rate · need ${(w.need_pct_per_h / w.rate_pct_per_h).toFixed(1)}x pace`;
}
