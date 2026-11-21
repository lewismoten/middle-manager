// Where a projection line starts and ends on a window chart. Pure (no DOM) so it can be unit
// tested: the line starts at the newest reading's used % at "now" and ends at the reset, or at
// 100% when the allowance runs out first. Both ends are kept inside the window and 0-100%.

export interface ProjectionInput {
  /** Projected used % at the end point (100 when it runs out). */
  used: number;
  /** End time: the reset, or when the allowance runs out. */
  t: number;
  runsOut: boolean;
}

export interface ProjectionSegment {
  t0: number;
  used0: number;
  t1: number;
  used1: number;
  runsOut: boolean;
}

const clampPct = (v: number) => Math.min(100, Math.max(0, v));

export function projectionSegment(
  window: { start: number; end: number; now: number },
  lastUsed: number,
  p: ProjectionInput,
): ProjectionSegment | null {
  if (!Number.isFinite(p.t) || !Number.isFinite(p.used) || !Number.isFinite(lastUsed)) return null;
  const t0 = Math.min(Math.max(window.now, window.start), window.end);
  const used0 = clampPct(lastUsed);
  const runsOut = p.runsOut || p.used >= 100;
  // A run-out time in the past (already spent) pins the end to "now"; never past the reset.
  const t1 = Math.min(Math.max(p.t, t0), window.end);
  const used1 = runsOut ? 100 : clampPct(Math.max(p.used, used0));
  return { t0, used0, t1, used1, runsOut };
}
