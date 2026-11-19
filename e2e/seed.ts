// Synthetic plan readings for the e2e server, relative to now: plan-a has a live week with
// hourly-ish readings, two finished weeks and a 5-hour window; plan-b has a stale reading.

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
    const stop = week === 0 ? now - 0.5 * HOUR : end - HOUR;
    let used = 0;
    for (let t = start + 2 * HOUR, i = 0; t < stop; t += 2 * HOUR, i++) {
      used = Math.min(100, used + 0.35 + ((i * 7) % 5) * 0.12 + (week === 1 ? 0.15 : 0));
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
