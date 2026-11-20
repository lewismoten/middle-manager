// Synthetic plan readings for the e2e server, relative to now: plan-a has a live week with
// readings every 2 h, then every 20 min for the last couple of hours as the burn picks up (so the
// 1 h and 2 h projections differ from the longer one), two finished weeks (the older one runs out
// before its reset) and a 5-hour window;
// plan-b has a stale reading. nearReset() is plan-d (on the board server only): a reading every
// 5 minutes all week, resetting about 1 h 40 min from now, the burn speeding up over the last 2 h.

import type { Db } from '../server/db/index.ts';
import { insertReadings, type NewReading } from '../server/plans/store.ts';

const HOUR = 3600_000;

export function seedPlanReadings(db: Db, now = Date.now()): void {
  const iso = (t: number) => new Date(t).toISOString();
  const rows: NewReading[] = [];
  const reset = Math.ceil((now + 62 * HOUR) / HOUR) * HOUR;
  for (let week = 2; week >= 0; week--) {
    const end = reset - week * 7 * 24 * HOUR;
    const start = end - 7 * 24 * HOUR;
    const stop = week === 0 ? now - 2.5 * HOUR : end - HOUR;
    let used = 0;
    let t = start + 2 * HOUR;
    for (let i = 0; t < stop; t += 2 * HOUR, i++) {
      // Week 2 burns fast and runs out on its last day (for the ran-out marker).
      const extra = week === 1 ? 0.15 : week === 2 ? 0.7 : 0;
      used = Math.min(100, used + 0.35 + ((i * 7) % 5) * 0.12 + extra);
      rows.push({
        plan_id: 'plan-a',
        window: 'weekly',
        used_pct: Math.round(used * 10) / 10,
        resets_at: iso(end),
        read_at: iso(t),
        machine_id: i % 3 ? 'server-1' : 'laptop-1',
        how: 'seed',
      });
    }
    if (week === 0) {
      // Speeding up: readings every 20 minutes after the last 2-hour one (2.5 h+ ago).
      for (
        let at = t - 2 * HOUR + 20 * 60_000, k = 1;
        at < now - 5 * 60_000;
        at += 20 * 60_000, k++
      ) {
        used = Math.min(100, used + 0.12 + k * 0.02);
        rows.push({
          plan_id: 'plan-a',
          window: 'weekly',
          used_pct: Math.round(used * 10) / 10,
          resets_at: iso(end),
          read_at: iso(at),
          machine_id: 'server-1',
          how: 'seed',
        });
      }
    }
  }
  const fiveReset = now + 2 * HOUR;
  [4, 3, 2, 1].forEach((h, i) =>
    rows.push({
      plan_id: 'plan-a',
      window: 'five_hour',
      used_pct: 8 + i * 9,
      resets_at: iso(fiveReset),
      read_at: iso(fiveReset - 5 * HOUR + (5 - h) * HOUR - 0.5 * HOUR),
      machine_id: 'server-1',
      how: 'seed',
    }),
  );
  rows.push(
    {
      plan_id: 'plan-b',
      window: 'weekly',
      used_pct: 12,
      resets_at: iso(now + 100 * HOUR),
      read_at: iso(now - 40 * HOUR),
      machine_id: 'server-1',
      how: 'seed',
    },
    {
      plan_id: 'plan-b',
      window: 'weekly',
      used_pct: 30,
      resets_at: iso(now + 100 * HOUR),
      read_at: iso(now - 6 * HOUR),
      machine_id: 'server-1',
      how: 'seed',
    },
  );
  insertReadings(db, rows);
}

/** plan-d: every 5 minutes since its window start, resetting ~1 h 40 min from now. */
export function nearReset(now: number): NewReading[] {
  const FIVE = 5 * 60_000;
  const reset = Math.ceil((now + 100 * 60_000) / FIVE) * FIVE;
  const start = reset - 7 * 24 * HOUR;
  const last = now - 3 * 60_000;
  const slowUntil = now - 2 * HOUR;
  const rows: NewReading[] = [];
  for (let t = start + FIVE, i = 0; t <= last; t += FIVE, i++) {
    // 88% by two hours ago, then 1.8%/h, then 2.6%/h over the last hour.
    let used = (88 * (Math.min(t, slowUntil) - start)) / (slowUntil - start);
    if (t > slowUntil) used += (1.8 * (Math.min(t, now - HOUR) - slowUntil)) / HOUR;
    if (t > now - HOUR) used += (2.6 * (t - (now - HOUR))) / HOUR;
    rows.push({
      plan_id: 'plan-d',
      window: 'weekly',
      used_pct: Math.round((used + ((i * 7) % 3) * 0.01) * 100) / 100,
      resets_at: new Date(reset + (i % 2 ? 60_000 : 0)).toISOString(),
      read_at: new Date(t).toISOString(),
      machine_id: i % 2 ? 'laptop-1' : 'server-1',
      how: 'seed',
    });
  }
  return rows;
}
