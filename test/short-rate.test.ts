// Short-window (1 h / 2 h) rates and projections: server math, card text and chart geometry.
import { describe, expect, it } from 'vitest';
import {
  analyse,
  currentWindow,
  HOUR_MS,
  pace,
  shortProjection,
  type Reading,
} from '../server/plans/pacing.ts';
import { shortProjectionView } from '../server/plans/service.ts';
import { shortOutcome, shortProjectionsText } from '../web/src/plans-logic.ts';
import { projectionSegment } from '../web/src/charts/projection-geometry.ts';

const NOW = Date.parse('2026-11-20T15:00:00Z');
const RESET = NOW + 50 * HOUR_MS;
const iso = (t: number) => new Date(t).toISOString();

/** Readings at [hours before now, used %], all in the window that resets at RESET. */
function readings(list: [number, number][], reset = RESET): Reading[] {
  return list.map(([ago, used]) => ({
    read_at: iso(NOW - ago * HOUR_MS),
    used_pct: used,
    resets_at: iso(reset),
  }));
}

function analysis(list: [number, number][], reset = RESET, now = NOW) {
  const w = currentWindow(readings(list, reset), now);
  if (!w) throw new Error('no window');
  return analyse(w, now);
}

describe('shortProjection', () => {
  it('uses the reading at or just before now - window and projects to the reset', () => {
    // Steady 1%/h for a day, then 3%/h for the last two hours.
    const a = analysis([
      [24, 30],
      [12, 42],
      [3, 51],
      [2, 52],
      [1.5, 53.5],
      [1, 55],
      [0.5, 56.5],
      [0.25, 57.25],
    ]);
    const one = shortProjection(a, NOW, 1);
    expect(one.since).toBe(NOW - HOUR_MS);
    expect(one.until).toBe(NOW - 0.25 * HOUR_MS);
    expect(one.rate).toBeCloseTo(3, 9);
    expect(one.covered_h).toBeCloseTo(0.75, 9);
    // 57.25 + 3 x 50 h runs out long before the reset.
    expect(one.projected).toBe(100);
    expect(one.hit).toBe(NOW + ((100 - 57.25) / 3) * HOUR_MS);
    expect(one.reason).toBeNull();

    const two = shortProjection(a, NOW, 2);
    expect(two.since).toBe(NOW - 2 * HOUR_MS);
    expect(two.rate).toBeCloseTo((57.25 - 52) / 1.75, 9);
    // The existing projection is untouched: the mode still uses the 3 h rate.
    expect(pace(a, NOW).rate_basis_h).toBe(3);
  });

  it('projects a % at reset when the allowance lasts', () => {
    const a = analysis([
      [2, 40],
      [1, 40.5],
      [0, 41],
    ]);
    const p = shortProjection(a, NOW, 1);
    expect(p.rate).toBeCloseTo(0.5, 9);
    expect(p.projected).toBeCloseTo(41 + 0.5 * 50, 9);
    expect(p.hit).toBeNull();
  });

  it('works with sparse readings: the anchor may predate the window by up to its length', () => {
    // Readings every 1.5 h: for the 1 h rate the anchor is 1.5 h back (0.5 h before the window).
    const a = analysis([
      [3, 20],
      [1.5, 23],
      [0, 26],
    ]);
    const p = shortProjection(a, NOW, 1);
    expect(p.since).toBe(NOW - 1.5 * HOUR_MS);
    expect(p.rate).toBeCloseTo(2, 9);
    expect(p.covered_h).toBe(1);
  });

  it('treats a long gap before the window as missing data', () => {
    // Nothing between 5 h ago and 20 min ago: too old to stand for the last hour.
    const a = analysis([
      [5, 20],
      [0.33, 30],
      [0, 30.5],
    ]);
    const p = shortProjection(a, NOW, 1);
    expect(p.rate).toBeNull();
    expect(p.projected).toBeNull();
    expect(p.reason).toBe('short_span');
    expect(p.reason_text).toMatch(/gap in readings/);
    // The 2 h window allows a 2 h older anchor: 5 h ago is still too old.
    expect(shortProjection(a, NOW, 2).reason).toBe('short_span');
  });

  it('uses a gap-free reading inside the window when it covers 30 min', () => {
    const a = analysis([
      [6, 20],
      [0.75, 30],
      [0, 31.5],
    ]);
    const p = shortProjection(a, NOW, 1);
    expect(p.since).toBe(NOW - 0.75 * HOUR_MS);
    expect(p.rate).toBeCloseTo(2, 9);
  });

  it('needs readings spanning at least 30 min of the window', () => {
    const a = analysis([
      [1.2, 10],
      [0.9, 11],
      [0.7, 12],
    ]);
    // The newest reading is 42 min old: only 18 min of the last hour is covered.
    const p = shortProjection(a, NOW, 1);
    expect(p.rate).toBeNull();
    expect(p.covered_h).toBeCloseTo(0.3, 9);
    expect(p.reason_text).toBe('readings cover 18 min of the last 1 h (need 30 min)');
  });

  it('reports no recent readings when the newest is older than the window', () => {
    const a = analysis([
      [6, 10],
      [3, 12],
    ]);
    const p = shortProjection(a, NOW, 2);
    expect(p.reason).toBe('no_recent_readings');
    expect(p.reason_text).toBe('no reading in the last 2 h');
    expect(shortProjectionView(p)).toMatchObject({
      rate_pct_per_h: null,
      projected_pct: null,
      runs_out_at: null,
      since: null,
    });
  });

  it('starts from the week start at 0% when the reset happened inside the window', () => {
    // The week began 40 min ago; the previous week's readings belong to another window.
    const reset = NOW - (40 / 60) * HOUR_MS + 7 * 24 * HOUR_MS;
    const list = [
      ...readings([[3, 95]], NOW - (40 / 60) * HOUR_MS),
      ...readings(
        [
          [0.5, 1],
          [0, 2],
        ],
        reset,
      ),
    ];
    const w = currentWindow(list, NOW);
    if (!w) throw new Error('no window');
    expect(w.points).toHaveLength(2);
    const a = analyse(w, NOW);
    const p = shortProjection(a, NOW, 1);
    expect(p.since).toBe(w.start);
    expect(p.rate).toBeCloseTo(3, 9);
    expect(p.covered_h).toBeCloseTo(40 / 60, 9);
  });

  it('reports a window that has already reset', () => {
    const a = analysis(
      [
        [3, 90],
        [2, 95],
      ],
      NOW - HOUR_MS,
    );
    const p = shortProjection(a, NOW, 1);
    expect(p.reason).toBe('window_ended');
    expect(p.rate).toBeNull();
  });

  it('keeps 100% at 100 and reports when it ran out', () => {
    const a = analysis([
      [3, 96],
      [1.5, 100],
      [0.5, 100],
      [0, 100],
    ]);
    const p = shortProjection(a, NOW, 1);
    expect(p.rate).toBe(0);
    expect(p.projected).toBe(100);
    expect(p.hit).toBe(NOW - 1.5 * HOUR_MS);
  });

  it('clamps a falling reading (two machines disagreeing) to a zero rate', () => {
    const a = analysis([
      [1, 50],
      [0.5, 49.5],
      [0, 49],
    ]);
    const p = shortProjection(a, NOW, 1);
    expect(p.rate).toBe(0);
    expect(p.projected).toBe(49);
    expect(p.hit).toBeNull();
  });

  it('a zero rate projects the current use', () => {
    const a = analysis([
      [2, 33],
      [1, 33],
      [0, 33],
    ]);
    const p = shortProjection(a, NOW, 2);
    expect(p.rate).toBe(0);
    expect(p.projected).toBe(33);
    expect(p.hit).toBeNull();
  });

  it('ignores readings after now', () => {
    const a = analysis([
      [1, 10],
      [0, 11],
      [-1, 40],
    ]);
    expect(shortProjection(a, NOW, 1).rate).toBeCloseTo(1, 9);
  });
});

describe('short projection text', () => {
  const base = {
    window_h: 2 as const,
    rate_pct_per_h: 1,
    since: null,
    until: null,
    covered_h: 2,
    projected_pct: 97.3,
    runs_out_at: null,
    reason: null,
    reason_text: null,
  };
  const time = (s: string) => `T(${s})`;

  it('formats % at reset, runs out, and missing data', () => {
    expect(shortOutcome(base, time)).toBe('97% at reset');
    expect(shortOutcome({ ...base, runs_out_at: 'x' }, time)).toBe('runs out T(x)');
    expect(
      shortOutcome(
        { ...base, projected_pct: null, rate_pct_per_h: null, reason: 'short_span' },
        time,
      ),
    ).toBe('not enough readings');
    expect(shortOutcome({ ...base, projected_pct: null, reason: 'window_ended' }, time)).toBe(
      'window has reset',
    );
  });

  it('builds the card line, 2 h first', () => {
    expect(
      shortProjectionsText(
        {
          projection_1h: { ...base, window_h: 1, runs_out_at: 'fri' },
          projection_2h: base,
        },
        time,
      ),
    ).toBe('Last 2 h: 97% at reset · Last 1 h: runs out T(fri)');
    expect(shortProjectionsText({}, time)).toBeNull();
  });
});

describe('projection line geometry', () => {
  const win = { start: 0, end: 100, now: 60 };

  it('runs from the last reading at now to the reset', () => {
    expect(projectionSegment(win, 50, { t: 100, used: 80, runsOut: false })).toEqual({
      t0: 60,
      used0: 50,
      t1: 100,
      used1: 80,
      runsOut: false,
    });
  });

  it('stops at 100% when it runs out, inside the plot', () => {
    const g = projectionSegment(win, 90, { t: 70, used: 100, runsOut: true });
    expect(g).toMatchObject({ t1: 70, used1: 100, runsOut: true });
  });

  it('pins an already-spent run-out time to now and never passes the reset', () => {
    expect(projectionSegment(win, 100, { t: 10, used: 100, runsOut: true })).toMatchObject({
      t0: 60,
      t1: 60,
      used1: 100,
    });
    expect(projectionSegment(win, 50, { t: 500, used: 140, runsOut: false })).toMatchObject({
      t1: 100,
      used1: 100,
      runsOut: true,
    });
  });

  it('never projects below the current use or outside 0-100', () => {
    expect(projectionSegment(win, 120, { t: 100, used: 30, runsOut: false })).toMatchObject({
      used0: 100,
      used1: 100,
    });
    expect(
      projectionSegment({ ...win, now: 150 }, 10, { t: 100, used: 20, runsOut: false }),
    ).toMatchObject({
      t0: 100,
      t1: 100,
    });
    expect(projectionSegment(win, 10, { t: Number.NaN, used: 20, runsOut: false })).toBeNull();
  });
});
