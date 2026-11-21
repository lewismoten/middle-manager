// The final-stretch view's pure logic (range, clipping, y zoom, projections, view choice), the
// pacing policy matrix (phases, finish / stop / launch cutoff / reserve, recovery need) and the
// readings thinning for the week view.

import { describe, expect, it } from 'vitest';
import {
  analyse,
  evenLine as serverEvenLine,
  HOUR_MS,
  pace,
  suggestedModel,
  type Point,
} from '../server/plans/pacing.ts';
import { downsample, insertReadings, listReadings } from '../server/plans/store.ts';
import {
  clipLine,
  evenLine,
  parseView,
  pickView,
  projectTo,
  quarterTicks,
  readAgo,
  stretchRange,
  stretchStale,
  valueOn,
  yTicks,
  yZoom,
} from '../web/src/pages/final-stretch-logic.ts';
import { parseState, stateHash } from '../web/src/pages/past-weeks-logic.ts';
import { memoryDb, testConfig } from './helpers.ts';

const H = HOUR_MS;
const MIN = 60_000;
const RESET = Date.UTC(2026, 10, 23, 15, 0);
const START = RESET - 168 * H;

describe('stretchRange', () => {
  it('spans now - 2 h to now + 2 h in the middle of the week', () => {
    const now = RESET - 50 * H;
    expect(stretchRange(now, START, RESET)).toEqual({ from: now - 2 * H, to: now + 2 * H });
  });

  it('clips at the reset and keeps 4 h by showing more of the past', () => {
    const now = RESET - 30 * MIN;
    expect(stretchRange(now, START, RESET)).toEqual({ from: RESET - 4 * H, to: RESET });
  });

  it('clips at the window start and shows more of the future', () => {
    const now = START + 40 * MIN;
    expect(stretchRange(now, START, RESET)).toEqual({ from: START, to: START + 4 * H });
  });

  it('shows the last 4 h of the window after the reset', () => {
    expect(stretchRange(RESET + 5 * H, START, RESET)).toEqual({ from: RESET - 4 * H, to: RESET });
  });

  it('never leaves a window shorter than 4 h', () => {
    const short = { start: RESET - 3 * H, end: RESET };
    expect(stretchRange(RESET - H, short.start, short.end)).toEqual({
      from: short.start,
      to: short.end,
    });
  });
});

describe('clipLine and valueOn', () => {
  const pts = [
    { t: 0, used: 10 },
    { t: 10, used: 20 },
    { t: 20, used: 40 },
  ];

  it('interpolates where the line enters and leaves the range', () => {
    expect(clipLine(pts, { from: 5, to: 15 })).toEqual([
      { t: 5, used: 15 },
      { t: 10, used: 20 },
      { t: 15, used: 30 },
    ]);
  });

  it('stops at the newest point (no guessing past the data)', () => {
    expect(clipLine(pts, { from: 15, to: 99 })).toEqual([
      { t: 15, used: 30 },
      { t: 20, used: 40 },
    ]);
  });

  it('does not duplicate a point on the edge, and sorts its input', () => {
    expect(clipLine([...pts].reverse(), { from: 10, to: 20 })).toEqual(pts.slice(1));
  });

  it('is null outside the line', () => {
    expect(valueOn(pts, -1)).toBeNull();
    expect(valueOn(pts, 21)).toBeNull();
    expect(valueOn([], 0)).toBeNull();
  });

  it('matches the server even-pace line', () => {
    const line = evenLine(START, RESET - H, RESET, 97);
    for (const t of [START, START + 50 * H, RESET - 2 * H, RESET - H, RESET - 10 * MIN]) {
      expect(valueOn(line, t)).toBeCloseTo(serverEvenLine(START, RESET - H, t, 97), 9);
    }
    expect(valueOn(line, RESET)).toBe(97);
  });
});

describe('yZoom', () => {
  it('zooms to the visible readings near the end of the week and keeps the top in view', () => {
    const z = yZoom([88.2, 90.1, 92.4, 95.8, 96.4]);
    expect(z).toEqual({ lo: 85, hi: 100, zoomed: true, step: 5 });
    expect(yTicks(z)).toEqual([85, 90, 95, 100]);
    expect(yTicks(yZoom([93.5, 96]))).toEqual([90, 92, 94, 96, 98, 100]);
  });

  it('is at least 10 points tall', () => {
    const z = yZoom([50.1, 50.4]);
    expect(z.hi - z.lo).toBeGreaterThanOrEqual(10);
    expect(z.lo).toBeLessThanOrEqual(49.1);
    expect(z.hi).toBeGreaterThanOrEqual(51.4);
    expect(z.zoomed).toBe(true);
  });

  it('stays inside 0-100 and falls back to the full range', () => {
    expect(yZoom([0.2, 3])).toMatchObject({ lo: 0, zoomed: true });
    expect(yZoom([])).toEqual({ lo: 0, hi: 100, zoomed: false, step: 25 });
    expect(yZoom([2, 99])).toEqual({ lo: 0, hi: 100, zoomed: false, step: 25 });
    expect(yZoom([NaN, 120, -4])).toMatchObject({ lo: 0, hi: 100 });
  });

  it('snaps to whole gridline steps', () => {
    const z = yZoom([61.3, 77.9]);
    expect(z.lo % z.step).toBe(0);
    expect(z.hi % z.step).toBe(0);
    expect(z.lo).toBeLessThanOrEqual(60.3);
    expect(z.hi).toBeGreaterThanOrEqual(78.9);
  });
});

describe('projectTo', () => {
  const now = RESET - 2 * H;
  it('projects linearly to a time', () => {
    expect(projectTo(90, 2, now, now + 2 * H)).toEqual({
      t: now + 2 * H,
      used: 94,
      runsOut: false,
    });
  });
  it('ends at 100% when it runs out first', () => {
    expect(projectTo(96, 4, now, now + 2 * H)).toEqual({ t: now + H, used: 100, runsOut: true });
  });
  it('treats a falling rate as flat and a past time as now', () => {
    expect(projectTo(50, -1, now, now + H)).toEqual({ t: now + H, used: 50, runsOut: false });
    expect(projectTo(50, 1, now, now - H)).toEqual({ t: now, used: 50, runsOut: false });
  });
  it('is spent already at 100%', () => {
    expect(projectTo(100, 0, now, now + H)).toEqual({ t: now, used: 100, runsOut: true });
  });
});

describe('ticks, reading age and the view choice', () => {
  it('ticks every quarter hour inside the range', () => {
    const from = Date.UTC(2026, 10, 23, 12, 7);
    const ticks = quarterTicks({ from, to: from + 4 * H });
    expect(ticks).toHaveLength(16);
    expect(new Date(ticks[0]!).toISOString()).toBe('2026-11-23T12:15:00.000Z');
    expect(ticks.every((t) => t % (15 * MIN) === 0)).toBe(true);
  });

  it('says how old the reading is and warns past 15 minutes', () => {
    expect(readAgo(20_000)).toBe('read just now');
    expect(readAgo(4 * MIN)).toBe('read 4 min ago');
    expect(readAgo(125 * MIN)).toBe('read 2 h 5 min ago');
    expect(readAgo(2 * H)).toBe('read 2 h ago');
    expect(stretchStale(15 * MIN)).toBe(false);
    expect(stretchStale(16 * MIN)).toBe(true);
  });

  it('opens zoomed by itself under 3 h to the reset, until a choice is made', () => {
    const now = RESET - 2.5 * H;
    expect(pickView({ reset: RESET, now })).toEqual({ view: 'stretch', source: 'auto' });
    expect(pickView({ reset: RESET, now: RESET - 3.5 * H })).toEqual({
      view: 'week',
      source: 'auto',
    });
    expect(pickView({ reset: null, now })).toEqual({ view: 'week', source: 'auto' });
    expect(pickView({ reset: RESET, now: RESET + MIN })).toMatchObject({ view: 'week' });
    expect(pickView({ stored: 'week', reset: RESET, now })).toEqual({
      view: 'week',
      source: 'stored',
    });
    expect(pickView({ url: 'stretch', stored: 'week', reset: null, now })).toEqual({
      view: 'stretch',
      source: 'url',
    });
  });

  it('round-trips the view through the URL and ignores bad values', () => {
    const s = parseState('#/burndown?plan=plan-d&view=stretch');
    expect(s).toMatchObject({ plan: 'plan-d', view: 'stretch' });
    expect(
      stateHash({ plan: 'plan-d', week: 'current', compare: 'none', avg: false, view: 'stretch' }),
    ).toBe('#/burndown?plan=plan-d&view=stretch');
    expect(parseState('#/burndown?view=zoom').view).toBeUndefined();
    expect(stateHash({ plan: null, week: 'current', compare: 'none', avg: false })).toBe(
      '#/burndown',
    );
    expect(parseView('week')).toBe('week');
    expect(parseView('<x>')).toBeNull();
  });
});

// ---- Pacing policy matrix (matches the reference pace(); see test/pacing.test.ts) ----

/** A window with readings at the given hours before the reset (used % each). */
function at(points: [hoursBeforeReset: number, used: number][], nowBeforeResetH: number) {
  const pts: Point[] = points.map(([hb, used]) => ({
    t: RESET - hb * H,
    used,
    machine: 'm',
    how: 'x',
  }));
  const now = RESET - nowBeforeResetH * H;
  return { a: analyse({ start: START, end: RESET, points: pts }, now), now };
}

describe('pacing policy', () => {
  it('needs the rate that gets back onto the even line within 24 h during the week', () => {
    // 100 h before the reset, 40% used; even pace in 24 h is 97 x (68 + 24) / 167.
    const { a, now } = at(
      [
        [104, 37],
        [100, 40],
      ],
      100,
    );
    const p = pace(a, now);
    expect(p.phase).toBe('week');
    const evenIn24 = (97 * (68 + 24)) / 167;
    expect(p.need).toBeCloseTo((evenIn24 - 40) / 24, 9);
    expect(p.even_pace).toBeCloseTo((97 * 68) / 167, 9);
    expect(p.off_pace).toBeCloseTo(40 - (97 * 68) / 167, 9);
    expect(p.empty_target_pct).toBe(97);
    expect(p.launch_cutoff_at).toBe(RESET - 30 * MIN);
    expect(p.target_empty_at).toBe(RESET - H);
  });

  it('is 0 needed (steady/conserve) when already above where the line will be', () => {
    const { a, now } = at(
      [
        [104, 59],
        [100, 60],
      ],
      100,
    );
    const p = pace(a, now);
    expect(p.need).toBe(0);
    expect(p.ratio).toBeNull();
    // Above where the line is in 24 h (53.4%) and 20 points ahead of it now (39.5%).
    expect(p.mode).toBe('conserve');
  });

  it('conserves 5+ points ahead of even pace only during the week', () => {
    const even = (97 * 68) / 167;
    const ahead = at(
      [
        [103, even + 5.5 - 0.3],
        [100, even + 5.5],
      ],
      100,
    );
    expect(pace(ahead.a, ahead.now).mode).toBe('conserve');
    const near = at(
      [
        [103, even + 4.5 - 1],
        [100, even + 4.5],
      ],
      100,
    );
    expect(pace(near.a, near.now).mode).not.toBe('conserve');
  });

  it('aims straight at 97% by target empty in the last 24 h', () => {
    const { a, now } = at(
      [
        [13, 85],
        [10, 88],
      ],
      10,
    );
    const p = pace(a, now);
    expect(p.phase).toBe('final');
    expect(p.need).toBeCloseTo((97 - 88) / 9, 9);
    expect(p.mode).toBe('steady'); // 1%/h against 1%/h needed
  });

  it('switches to finish in the final hour and stop from the launch cutoff', () => {
    const pts: [number, number][] = [
      [4, 90],
      [1.5, 94],
    ];
    const finish = at(pts, 50 / 60);
    expect(pace(finish.a, finish.now)).toMatchObject({
      phase: 'final-hour',
      mode: 'finish',
      need: 0,
      ratio: null,
    });
    const cutoff = at(pts, 30 / 60);
    expect(pace(cutoff.a, cutoff.now)).toMatchObject({ phase: 'final-hour', mode: 'stop' });
    const before = at(pts, 31 / 60);
    expect(pace(before.a, before.now).mode).toBe('finish');
  });

  it('stops at 99% used at any time, and at 97% before target empty', () => {
    const hard = at([[60, 99.1]], 60);
    expect(pace(hard.a, hard.now)).toMatchObject({ phase: 'week', mode: 'stop' });
    const reserve = at([[5, 97]], 5);
    expect(pace(reserve.a, reserve.now)).toMatchObject({ phase: 'final', mode: 'stop' });
    // In the final hour 97-98.9% is still finish: the reserve is for exactly this hour.
    const lastHour = at([[0.9, 98]], 0.8);
    expect(pace(lastHour.a, lastHour.now).mode).toBe('finish');
  });

  it('respects a configured target %, buffer and launch cutoff', () => {
    const { a, now } = at([[5, 93]], 5);
    expect(pace(a, now, { emptyTargetPct: 92 }).mode).toBe('stop');
    expect(pace(a, now, { emptyTargetPct: 100 }).mode).not.toBe('stop');
    const late = at([[2, 80]], 1.5);
    expect(pace(late.a, late.now, { emptyBufferHours: 1 }).phase).toBe('final');
    expect(pace(late.a, late.now, { emptyBufferHours: 2 }).phase).toBe('final-hour');
    expect(pace(late.a, late.now, { launchCutoffMin: 120 }).mode).toBe('stop');
    expect(pace(late.a, late.now, 2).target_empty_at).toBe(RESET - 2 * H);
  });

  it('suggests the cheapest rung for finish and none for stop', () => {
    expect(suggestedModel('finish', ['s', 'm', 'l'])).toBe('s');
    expect(suggestedModel('stop', ['s', 'm', 'l'])).toBeNull();
  });
});

describe('readings for long charts', () => {
  const rows = (n: number, stepMin = 5) =>
    Array.from({ length: n }, (_, i) => ({
      read_at: new Date(START + i * stepMin * MIN).toISOString(),
      used_pct: i / 30 + (i === 1000 ? 5 : 0),
    }));

  it('thins 5-minute readings to the cap, keeping the ends and the peaks', () => {
    const all = rows(2016);
    const thin = downsample(all, 400);
    expect(thin.length).toBeLessThanOrEqual(400);
    // A rising line keeps one reading per bucket (its highest is its newest).
    expect(thin.length).toBeGreaterThan(190);
    expect(thin[0]).toBe(all[0]);
    expect(thin[thin.length - 1]).toBe(all[all.length - 1]);
    expect(thin).toContain(all[1000]); // the spike survives
    const ts = thin.map((r) => Date.parse(r.read_at));
    expect(ts).toEqual([...ts].sort((a, b) => a - b));
  });

  it('leaves a short list alone', () => {
    const few = rows(50);
    expect(downsample(few, 400)).toBe(few);
  });

  it('filters by window reset and thins only when asked, using the indexes', () => {
    const config = testConfig({ plans: [{ id: 'p', name: 'P', provider: 'manual' }] });
    const db = memoryDb(config);
    const reset = new Date(RESET).toISOString();
    const other = new Date(RESET - 168 * H).toISOString();
    insertReadings(db, [
      ...rows(2016).map((r, i) => ({
        plan_id: 'p',
        window: 'weekly' as const,
        used_pct: Math.min(100, r.used_pct),
        read_at: r.read_at,
        resets_at: i % 2 ? reset : new Date(RESET + 60_000).toISOString(),
        machine_id: null,
        how: null,
      })),
      {
        plan_id: 'p',
        window: 'weekly',
        used_pct: 99,
        read_at: new Date(START + MIN).toISOString(),
        resets_at: other,
        machine_id: null,
        how: null,
      },
    ]);
    const all = listReadings(db, 'p', { window: 'weekly', reset: RESET, limit: 10_000 });
    expect(all).toHaveLength(2016);
    expect(all.every((r) => r.resets_at !== other)).toBe(true);
    const thin = listReadings(db, 'p', {
      window: 'weekly',
      reset: RESET,
      limit: 10_000,
      maxPoints: 800,
    });
    expect(thin.length).toBeLessThanOrEqual(800);
    const plan = (sql: string) =>
      (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as { detail: string }[])
        .map((r) => r.detail)
        .join(' | ');
    expect(
      plan(
        `SELECT * FROM plan_readings WHERE plan_id = 'p' AND "window" = 'weekly' AND resets_at > '2026' AND resets_at < '2027'`,
      ),
    ).toMatch(/USING INDEX plan_readings_plan_window_(reset|read)/);
    expect(
      plan(
        `SELECT * FROM plan_readings WHERE plan_id = 'p' AND "window" = 'weekly' AND read_at >= '2026' ORDER BY read_at DESC`,
      ),
    ).toMatch(/USING INDEX plan_readings_plan_window_read/);
    db.close();
  });
});

describe('window list cache', () => {
  it('reuses grouped windows until a reading is added', async () => {
    const { windowsOf } = await import('../server/plans/service.ts');
    const config = testConfig({ plans: [{ id: 'p', name: 'P', provider: 'manual' }] });
    const db = memoryDb(config);
    const plan = config.plans[0]!;
    const reading = (h: number, used: number) => ({
      plan_id: 'p',
      window: 'weekly' as const,
      used_pct: used,
      read_at: new Date(RESET - h * H).toISOString(),
      resets_at: new Date(RESET).toISOString(),
      machine_id: null,
      how: null,
    });
    insertReadings(db, [reading(50, 40)]);
    const now = RESET - 10 * H;
    const a = windowsOf(db, plan, now);
    expect(a[0]!.final).toBe(40);
    expect(windowsOf(db, plan, now)[0]!.points).toBe(a[0]!.points); // cached
    expect(windowsOf(db, plan, RESET + H)[0]!.current).toBe(false); // "now" still applies
    insertReadings(db, [reading(20, 70)]);
    expect(windowsOf(db, plan, now)[0]!.final).toBe(70);
    db.close();
  });
});
