// The pacing port must match the reference Python burndown on the same readings (SPEC 7).
// fixtures/plan-readings.csv is synthetic. fixtures/pacing-expected.json holds the reference
// implementation's output for that file at several "now" times. To re-check against the reference
// itself, point MM_REFERENCE_BURNDOWN at the folder holding burndown.py (local only, never
// committed); the last test then runs it live.

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { readingsFromCsv } from '../server/plans/csv.ts';
import {
  analyse,
  currentWindow,
  pace,
  pastWeeks,
  recentRate,
  roundTo,
  suggestedModel,
  type Reading,
} from '../server/plans/pacing.ts';
import { planPace } from '../server/plans/service.ts';
import { insertReadings } from '../server/plans/store.ts';
import { memoryDb, testConfig } from './helpers.ts';

const FIX = path.join(import.meta.dirname, 'fixtures');
const CSV = readFileSync(path.join(FIX, 'plan-readings.csv'), 'utf8');
const PLANS = ['plan-a', 'plan-b', 'plan-c', 'plan-d', 'plan-e'];

interface Expected {
  now: string;
  plan: string;
  start: number;
  end: number;
  points: number;
  used: number;
  last_t: number;
  pace: number;
  rate: number;
  since: number;
  left_h: number;
  projected: number;
  hit: number | null;
  need95: number;
  stale_h: number;
  mode: string;
  recent_rate: number;
  rate_basis_h: number;
  need: number;
  rate_pct_per_h: number;
  need_pct_per_h: number;
  ratio: number | null;
  reading_age_h: number;
}

const EXPECTED = JSON.parse(
  readFileSync(path.join(FIX, 'pacing-expected.json'), 'utf8'),
) as Expected[];
const NOWS = [...new Set(EXPECTED.map((e) => e.now))];

function weekly(planId: string): Reading[] {
  return readingsFromCsv(CSV, PLANS).readings.filter(
    (r) => r.plan_id === planId && r.window === 'weekly',
  );
}

function ours(planId: string, nowIso: string) {
  const now = new Date(nowIso).getTime();
  const w = currentWindow(weekly(planId), now);
  if (!w) throw new Error(`no window for ${planId}`);
  const a = analyse(w, now);
  const p = pace(a, now, 1);
  return { a, p, recent: recentRate(a) };
}

function compare(e: Expected) {
  const { a, p, recent } = ours(e.plan, e.now);
  const close = (x: number, y: number) => expect(x).toBeCloseTo(y, 9);
  expect(a.points.length).toBe(e.points);
  close(a.start, e.start);
  close(a.end, e.end);
  close(a.used, e.used);
  close(a.last_t, e.last_t);
  close(a.pace, e.pace);
  close(a.rate, e.rate);
  close(a.since, e.since);
  close(a.left_h, e.left_h);
  close(a.projected, e.projected);
  if (e.hit === null) expect(a.hit).toBeNull();
  else expect(Math.abs((a.hit as number) - e.hit)).toBeLessThan(1); // timedelta is in µs
  close(a.need95, e.need95);
  close(a.stale_h, e.stale_h);
  expect(p.mode).toBe(e.mode);
  close(recent.rate, e.recent_rate);
  expect(p.rate_basis_h).toBe(e.rate_basis_h);
  close(p.need, e.need);
  expect(roundTo(p.rate, 3)).toBe(e.rate_pct_per_h);
  expect(roundTo(p.need, 3)).toBe(e.need_pct_per_h);
  expect(p.ratio === null ? null : roundTo(p.ratio, 2)).toBe(e.ratio);
  expect(roundTo(p.reading_age_h, 1)).toBe(e.reading_age_h);
}

describe('pacing matches the reference implementation', () => {
  it('fixture covers every mode and both rate bases', () => {
    expect(new Set(EXPECTED.map((e) => e.mode))).toEqual(
      new Set(['burn', 'steady', 'conserve', 'stop']),
    );
    expect(new Set(EXPECTED.map((e) => e.rate_basis_h))).toEqual(new Set([3, 24]));
    expect(EXPECTED.some((e) => e.hit !== null)).toBe(true);
    expect(EXPECTED).toHaveLength(NOWS.length * PLANS.length);
  });

  for (const e of EXPECTED) {
    it(`${e.plan} at ${e.now}: ${e.mode}`, () => compare(e));
  }

  it('gives the same answer through the database', () => {
    const config = testConfig({
      plans: PLANS.map((id) => ({ id, name: id, provider: 'manual', windows: ['weekly'] })),
    });
    const db = memoryDb(config);
    const parsed = readingsFromCsv(CSV, PLANS);
    insertReadings(db, parsed.readings);
    for (const e of EXPECTED) {
      const plan = config.plans.find((p) => p.id === e.plan)!;
      const got = planPace(db, config, plan, new Date(e.now).getTime()).weekly!;
      expect(got.mode, `${e.plan} ${e.now}`).toBe(e.mode);
      expect(got.rate_pct_per_h).toBe(e.rate_pct_per_h);
      expect(got.need_pct_per_h).toBe(e.need_pct_per_h);
      expect(got.ratio).toBe(e.ratio);
      expect(got.projected_pct).toBe(roundTo(e.projected, 1));
      expect(got.used_pct).toBe(e.used);
      expect(new Date(got.reset_at).getTime()).toBe(e.end);
      expect(got.readings).toBe(e.points);
    }
  });

  it.skipIf(!process.env.MM_REFERENCE_BURNDOWN)('matches the reference run live', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'mm-ref-'));
    try {
      const driver = path.join(dir, 'driver.py');
      writeFileSync(driver, DRIVER);
      const ref = path.resolve(process.env.MM_REFERENCE_BURNDOWN as string);
      expect(existsSync(path.join(ref, 'burndown.py'))).toBe(true);
      const run = spawnSync(
        'python3',
        ['-I', driver, ref, path.join(FIX, 'plan-readings.csv'), ...NOWS],
        {
          encoding: 'utf8',
        },
      );
      expect(run.status, run.stderr).toBe(0);
      const live = JSON.parse(run.stdout) as Expected[];
      expect(live).toEqual(EXPECTED);
      live.forEach(compare);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('pacing helpers', () => {
  it('maps modes to model rungs, cheapest first', () => {
    const two = ['small', 'large'];
    const three = ['s', 'm', 'l'];
    expect(suggestedModel('burn', two)).toBe('large');
    expect(suggestedModel('steady', two)).toBe('small');
    expect(suggestedModel('conserve', two)).toBe('small');
    expect(suggestedModel('steady', three)).toBe('m');
    expect(suggestedModel('conserve', three)).toBe('s');
    expect(suggestedModel('stop', three)).toBeNull();
    expect(suggestedModel('burn', [])).toBeNull();
  });

  it('honours empty_buffer_hours for the target', () => {
    const { a } = ours('plan-e', NOWS[0] as string);
    const now = new Date(NOWS[0] as string).getTime();
    const one = pace(a, now, 1);
    const six = pace(a, now, 6);
    expect(one.target_empty_at - six.target_empty_at).toBe(5 * 3600_000);
    expect(six.need).toBeGreaterThan(one.need);
  });

  it('lists past weeks with the percent left unused at each reset', () => {
    const now = new Date('2026-11-20T12:00:00Z').getTime();
    const weeks = pastWeeks(weekly('plan-a'), now);
    expect(weeks).toHaveLength(1);
    const w = weeks[0]!;
    // Readings in the previous week reset at 15:00 or 15:40; the group takes the latest.
    expect(w.reset_at).toBe('2026-11-16T15:40:00.000Z');
    expect(w.unused_pct).toBeCloseTo(100 - w.used_pct, 9);
    expect(w.used_pct).toBeGreaterThan(50);
  });
});

// The live check's driver: loads the reference module, points it at the fixture and prints the
// same fields as pacing-expected.json.
const DRIVER = String.raw`
import json, sys, collections
from datetime import datetime
ref_dir, csv_path, *nows = sys.argv[1:]
sys.path.insert(0, ref_dir)
import burndown as b
b.SOURCES = [csv_path]
b.LADDER = collections.defaultdict(lambda: collections.defaultdict(str))
rows = b.load()
ms = lambda d: d.timestamp() * 1000
out = []
for now_s in nows:
    now = datetime.fromisoformat(now_s).astimezone(b.ET)
    for src in sorted({r[0] for r in rows}):
        w = b.window(rows, src, now)
        a = b.analyse(src, w[0], w[1], now)
        p = b.pace(a, now)
        rr, basis = b.recent_rate(a, now)
        tgt = a['end'] - b.timedelta(hours=1)
        need = max(0.0, (100 - a['used']) / max(0.25, (tgt - now).total_seconds() / 3600))
        out.append(dict(now=now_s, plan=src, start=ms(a['start']), end=ms(a['end']), points=len(a['points']),
            used=a['used'], last_t=ms(a['last_t']), pace=a['pace'], rate=a['rate'], since=ms(a['since']),
            left_h=a['left_h'], projected=a['projected'], hit=ms(a['hit']) if a['hit'] else None, need95=a['need'],
            stale_h=a['stale_h'], mode=p['mode'], recent_rate=rr, rate_basis_h=basis, need=need,
            rate_pct_per_h=p['rate_pct_per_h'], need_pct_per_h=p['need_pct_per_h'], ratio=p['ratio'],
            reading_age_h=p['reading_age_h']))
json.dump(out, sys.stdout, indent=1)
`;
