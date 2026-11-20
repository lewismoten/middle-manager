// Regression: /plans/pace must match the reference burndown when the database holds CSV-imported
// readings interleaved with live collector readings (SPEC 7). Synthetic fixtures:
//   interleaved-history.csv  a laptop's sparse history, a 37 h gap, and the server's own CSV log,
//                            which mirrors some live reads (other time zone, reset 1 s off) and
//                            once disagrees with a live read taken at the same instant
//   interleaved-live.csv     what the live collector stored, every ~30 min
// plan-b stops before the 3 h window clears the gap, so its "3 h" rate reaches back 37 h, as the
// reference does. interleaved-expected.json is the reference's output for both files together
// (same driver as pacing.test.ts, with b.SOURCES set to the two files).

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { readingsFromCsv } from '../server/plans/csv.ts';
import { roundTo } from '../server/plans/pacing.ts';
import { importCsvText, planPace } from '../server/plans/service.ts';
import { insertReadings } from '../server/plans/store.ts';
import { memoryDb, testConfig } from './helpers.ts';

const FIX = path.join(import.meta.dirname, 'fixtures');
const read = (f: string) => readFileSync(path.join(FIX, f), 'utf8');
const HISTORY = read('interleaved-history.csv');
const LIVE = read('interleaved-live.csv');
const EXPECTED = JSON.parse(read('interleaved-expected.json')) as {
  now: string;
  plan: string;
  points: number;
  used: number;
  end: number;
  last_t: number;
  recent_rate: number;
  left_h: number;
  mode: string;
  rate_basis_h: number;
  rate_pct_per_h: number;
  need_pct_per_h: number;
  ratio: number | null;
}[];
const PLANS = ['plan-a', 'plan-b'];

describe('pace with CSV-imported and live readings interleaved', () => {
  const config = testConfig({
    plans: PLANS.map((id) => ({ id, name: id, provider: 'manual', windows: ['weekly'] })),
  });
  const db = memoryDb(config);
  // Live reads arrive one at a time (plan-a's, including the one the CSV later disagrees with);
  // the CSV import runs in the middle and again at the end (re-importing must change nothing).
  const live = readingsFromCsv(LIVE, PLANS).readings;
  for (const r of live.filter((x) => x.plan_id === 'plan-a')) insertReadings(db, [r]);
  importCsvText(db, config, HISTORY);
  for (const r of live.filter((x) => x.plan_id === 'plan-b')) insertReadings(db, [r]);
  const again = importCsvText(db, config, HISTORY).stored;

  it('re-importing the CSV adds nothing', () => {
    expect(again.added).toBe(0);
  });

  it('covers the reported symptom: 3 h basis reaching back across a gap', () => {
    expect(EXPECTED.find((e) => e.plan === 'plan-b')).toMatchObject({
      rate_basis_h: 3,
      rate_pct_per_h: 0.259,
    });
  });

  for (const e of EXPECTED) {
    it(`${e.plan} at ${e.now} matches the reference`, () => {
      const plan = config.plans.find((p) => p.id === e.plan)!;
      const got = planPace(db, config, plan, new Date(e.now).getTime()).weekly!;
      expect({
        readings: got.readings,
        used: got.used_pct,
        last: new Date(got.last_reading_at).getTime(),
        reset: new Date(got.reset_at).getTime(),
        rate: got.rate_pct_per_h,
        basis: got.rate_basis_h,
        need: got.need_pct_per_h,
        ratio: got.ratio,
        projected: got.projected_pct,
        mode: got.mode,
      }).toEqual({
        readings: e.points,
        used: e.used,
        last: e.last_t,
        reset: e.end,
        rate: e.rate_pct_per_h,
        basis: e.rate_basis_h,
        need: e.need_pct_per_h,
        ratio: e.ratio,
        projected: roundTo(Math.min(100, e.used + e.recent_rate * e.left_h), 1),
        mode: e.mode,
      });
    });
  }
});
