// Past weeks: grouping readings into windows (jittered resets_at), window stats, the windows
// API, and the web logic that aligns, scales and averages other weeks onto the shown one.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  findWindow,
  HOUR_MS,
  planWindows,
  WEEK_MS,
  windowStats,
  type Reading,
} from '../server/plans/pacing.ts';
import { insertReadings, type NewReading } from '../server/plans/store.ts';
import { startServer, type Running } from '../server/server.ts';
import {
  alignSeries,
  averageSeries,
  averageWindows,
  compareWindows,
  overlayLabel,
  overlayShortLabel,
  parseCompare,
  parseState,
  rangeLabel,
  spreadLabels,
  stateHash,
  targetText,
  valueAt,
  type WindowSummary,
} from '../web/src/pages/past-weeks-logic.ts';
import { memoryDb, testConfig } from './helpers.ts';

const H = HOUR_MS;
const iso = (t: number) => new Date(t).toISOString();
const RESET = Date.parse('2026-11-20T23:00:00Z');
const NOW = Date.parse('2026-11-20T20:00:00Z');

/** Hourly readings across a window, each with a jittered resets_at. */
function week(
  reset: number,
  opts: { from?: number; to?: number; step?: number; jitter?: (i: number) => number } = {},
  used: (i: number, t: number) => number = (i) => i * 0.5,
): Reading[] {
  const out: Reading[] = [];
  const start = reset - WEEK_MS;
  const from = opts.from ?? start + H;
  const to = opts.to ?? reset - H;
  const step = opts.step ?? 2 * H;
  for (let t = from, i = 1; t <= to; t += step, i++) {
    const j = opts.jitter ? opts.jitter(i) : 0;
    out.push({
      read_at: iso(t),
      used_pct: Math.min(100, used(i, t)),
      resets_at: iso(reset + j),
      machine_id: 'm1',
      how: 'test',
    });
  }
  return out;
}

describe('planWindows: grouping readings into windows', () => {
  it('groups readings whose resets_at jitter by milliseconds and minutes into one window', () => {
    // Like the live data: sub-second jitter on most readings, a second source 10 min off.
    const jitter = (i: number) => (i % 7 === 0 ? 10 * 60_000 : ((i * 37) % 900) - 450);
    const list = [
      ...week(RESET - WEEK_MS, { jitter }),
      ...week(RESET, { to: NOW, jitter: (i) => -((i * 13) % 600) }),
    ];
    expect(new Set(list.map((r) => r.resets_at)).size).toBeGreaterThan(20);
    const ws = planWindows(list, NOW);
    expect(ws).toHaveLength(2);
    expect(ws[0]!.current).toBe(true);
    expect(ws[1]!.current).toBe(false);
    // The reset is the median reported reset, so one odd source does not move it.
    expect(Math.abs(ws[1]!.end - (RESET - WEEK_MS))).toBeLessThan(60_000);
    expect(ws[1]!.length_h).toBeCloseTo(168, 1);
    expect(ws[1]!.points).toHaveLength(list.filter((r) => r.resets_at! < iso(RESET - H)).length);
  });

  it('keeps windows apart by the same-reset tolerance and orders them newest first', () => {
    const list = [
      ...week(RESET - 2 * WEEK_MS),
      ...week(RESET - WEEK_MS),
      ...week(RESET, { to: NOW }),
    ];
    const ws = planWindows(list, NOW);
    expect(ws.map((w) => w.id)).toEqual([
      iso(RESET),
      iso(RESET - WEEK_MS),
      iso(RESET - 2 * WEEK_MS),
    ]);
  });

  it('makes a window shorter when the previous reset came early', () => {
    const early = RESET - WEEK_MS - 48 * H; // previous window reset two days later than a week
    const list = [...week(RESET - WEEK_MS), ...week(RESET, { from: RESET - WEEK_MS + 2 * H })];
    const shifted = list.map((r) =>
      r.resets_at!.startsWith(iso(RESET - WEEK_MS).slice(0, 13))
        ? { ...r, resets_at: iso(early), read_at: iso(Date.parse(r.read_at) - 48 * H) }
        : r,
    );
    const ws = planWindows(shifted, RESET + H);
    expect(ws).toHaveLength(2);
    expect(ws[1]!.end).toBe(early);
    expect(ws[0]!.start).toBe(RESET - WEEK_MS); // a full week from the earlier reset
    const shorter = planWindows(
      [...week(RESET - 72 * H), ...week(RESET, { from: RESET - 71 * H, to: NOW })],
      NOW,
    );
    expect(shorter[0]!.start).toBe(RESET - 72 * H);
    expect(shorter[0]!.length_h).toBe(72);
  });

  it('keeps a full-length window when the previous one was reset early', () => {
    // The provider reset the plan 3 days before the reported reset; the new window's readings
    // start right away, before the old window's reported reset.
    const oldReset = RESET - 4 * 24 * H;
    const resetAt = RESET - WEEK_MS + H; // when the early reset happened
    const now = resetAt + 24 * H;
    const list = [
      ...week(oldReset, { to: resetAt - H }),
      ...week(RESET, { from: resetAt + H, to: now }),
    ];
    const ws = planWindows(list, now);
    expect(ws).toHaveLength(2);
    expect(ws[0]!.start).toBe(RESET - WEEK_MS);
    expect(ws[0]!.length_h).toBe(168);
    // Every reading of the new window lies inside it, so none is dropped from its stats.
    expect(ws[0]!.points.every((p) => p.t >= ws[0]!.start)).toBe(true);
    // The old window's reported reset is still ahead, but only the newest window is current.
    expect(oldReset).toBeGreaterThan(now);
    expect(ws.map((w) => w.current)).toEqual([true, false]);
  });

  it("uses the plan's own window length", () => {
    const five = 5 * 24 * H;
    const ws = planWindows(week(RESET, { from: RESET - five + H, to: NOW }), NOW, five);
    expect(ws[0]!.start).toBe(RESET - five);
    expect(ws[0]!.length_h).toBe(120);
  });

  it('reports final, peak and when it ran out', () => {
    const ws = planWindows(
      week(RESET - WEEK_MS, {}, (i) => i * 1.5),
      NOW,
    );
    const w = ws[0]!;
    expect(w.peak).toBe(100);
    expect(w.final).toBe(100);
    expect(w.ran_out_at).toBe(w.points.find((p) => p.used >= 100)!.t);
    expect(w.partial).toBe(false);
  });

  it('flags partial weeks (readings start late or stop early) and handles empty input', () => {
    const late = week(RESET - WEEK_MS, { from: RESET - WEEK_MS - 72 * H });
    expect(planWindows(late, NOW)[0]!.partial).toBe(true);
    const stops = week(RESET - WEEK_MS, { to: RESET - WEEK_MS - 30 * H });
    expect(planWindows(stops, NOW)[0]!.partial).toBe(true);
    expect(planWindows([], NOW)).toEqual([]);
    expect(planWindows([{ read_at: iso(NOW), used_pct: 5, resets_at: null }], NOW)).toEqual([]);
  });

  it('drops exact duplicate readings and finds a window by a nearby reset time', () => {
    const list = week(RESET - WEEK_MS);
    const ws = planWindows([...list, ...list], NOW);
    expect(ws[0]!.points).toHaveLength(list.length);
    expect(findWindow(ws, RESET - WEEK_MS + 2 * H)).toBe(ws[0]);
    expect(findWindow(ws, RESET - WEEK_MS + 4 * H)).toBeNull();
  });
});

describe('windowStats', () => {
  it('measures unused allowance and the gap from even pace', () => {
    // Exactly on even pace to 84% at the end of the week.
    const [w] = planWindows(
      week(RESET - WEEK_MS, { step: H }, (_i, t) => ((t - (RESET - 2 * WEEK_MS)) / WEEK_MS) * 84),
      NOW,
    );
    const s = windowStats(w!, 1);
    expect(s.unused_pct).toBeCloseTo(100 - w!.final, 5);
    expect(s.unused_h).toBeCloseTo(((100 - w!.final) / 100) * 168, 5);
    expect(s.locked_out_h).toBeNull();
    expect(s.target_gap_pct).toBeCloseTo(w!.final - 100, 5);
    // Even pace runs to 97% an hour before the reset; the gap to a straight 0-84% line grows
    // almost linearly, so the mean is about half the end gap (13 pts).
    expect(s.mean_vs_even_pct!).toBeLessThan(0);
    expect(s.mean_abs_vs_even_pct!).toBeCloseTo(-s.mean_vs_even_pct!, 5);
    expect(s.mean_abs_vs_even_pct!).toBeGreaterThan(6);
    expect(s.mean_abs_vs_even_pct!).toBeLessThan(7.5);
  });

  it('reports how early a week ran out against the target and the hours locked out', () => {
    const [w] = planWindows(
      week(RESET - WEEK_MS, { step: H }, (i) => i * 0.8),
      NOW,
    );
    const s = windowStats(w!, 1);
    const out = w!.ran_out_at!;
    expect(s.unused_pct).toBe(0);
    expect(s.locked_out_h).toBeCloseTo((w!.end - out) / H, 5);
    expect(s.ran_out_early_h).toBeCloseTo((w!.end - H - out) / H, 5);
    expect(s.target_gap_pct).toBe(0);
  });

  it('counts the absolute gap across a crossing of the even-pace line', () => {
    const start = RESET - 2 * WEEK_MS;
    const reset = RESET - WEEK_MS;
    // Ahead of even pace early in the week, behind it at the end: crosses the line once.
    const list: Reading[] = [
      [H, 10],
      [WEEK_MS / 2, 50],
      [WEEK_MS - H, 60],
    ].map(([dt, used]) => ({ read_at: iso(start + dt!), used_pct: used!, resets_at: iso(reset) }));
    const s = windowStats(planWindows(list, NOW)[0]!, 1);
    expect(s.mean_abs_vs_even_pct!).toBeGreaterThan(Math.abs(s.mean_vs_even_pct!));
  });

  it('does not count a partial week from 0% at its start', () => {
    const [w] = planWindows(week(RESET - WEEK_MS, { from: RESET - WEEK_MS - 48 * H }), NOW);
    const s = windowStats(w!, 1);
    expect(w!.partial).toBe(true);
    expect(s.mean_vs_even_pct).not.toBeNull();
  });
});

describe('windows API', () => {
  let running: Running;
  beforeAll(async () => {
    const config = testConfig({
      plans: [
        { id: 'p1', name: 'P1', provider: 'manual', empty_buffer_hours: 2 },
        { id: 'p2', name: 'P2', provider: 'manual', window_hours: 120 },
      ],
    });
    const db = memoryDb(config);
    const now = Date.now();
    const reset = Math.ceil((now + 30 * H) / H) * H;
    const rows: NewReading[] = [
      ...week(reset - WEEK_MS, { jitter: (i) => (i % 2 ? 300 : -300) }),
      ...week(reset, { to: now - H }),
    ].map((r) => ({ ...r, plan_id: 'p1', window: 'weekly' as const }) as NewReading);
    insertReadings(db, rows);
    running = await startServer({ config, db, port: 0, host: '127.0.0.1', retention: false });
  });
  afterAll(() => running.close());
  const get = (p: string) => fetch(`${running.url}/api/v1${p}`);
  type List = { window_hours: number; windows: WindowSummary[] };
  type Detail = { window: WindowSummary; readings: { read_at: string }[] };

  it('lists windows newest first with their stats', async () => {
    const res = await get('/plans/p1/windows');
    expect(res.status).toBe(200);
    const body = (await res.json()) as List;
    expect(body.window_hours).toBe(168);
    expect(body.windows).toHaveLength(2);
    const [cur, past] = body.windows as [WindowSummary, WindowSummary];
    expect(cur.current).toBe(true);
    expect(past.current).toBe(false);
    expect(past).toMatchObject({ length_h: 168, ran_out: false, partial: false });
    expect(Date.parse(past.target_empty_at)).toBe(Date.parse(past.reset_at) - 2 * H);
    expect(typeof past.mean_abs_vs_even_pct).toBe('number');
    const only = (await (await get('/plans/p1/windows?current=0&limit=1')).json()) as List;
    expect(only.windows.map((w) => w.id)).toEqual([past.id]);
  });

  it("returns one window's readings by reset time (with tolerance) or current", async () => {
    const list = ((await (await get('/plans/p1/windows')).json()) as List).windows as [
      WindowSummary,
      WindowSummary,
    ];
    const near = new Date(Date.parse(list[1].id) + 30 * 60_000).toISOString();
    const res = await get(`/plans/p1/windows/${encodeURIComponent(near)}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Detail;
    expect(body.window.id).toBe(list[1].id);
    expect(body.readings.length).toBe(list[1].readings);
    expect(body.readings[0]).toHaveProperty('read_at');
    const cur = (await (await get('/plans/p1/windows/current')).json()) as Detail;
    expect(cur.window.current).toBe(true);
  });

  it('rejects bad input and reports missing windows', async () => {
    expect((await get('/plans/p1/windows?limit=0')).status).toBe(400);
    expect((await get('/plans/p1/windows?bogus=1')).status).toBe(400);
    expect((await get('/plans/p1/windows/yesterday')).status).toBe(400);
    expect((await get('/plans/p1/windows/2020-01-01T00:00:00Z')).status).toBe(404);
    expect((await get('/plans/nope/windows')).status).toBe(404);
    const empty = await (await get('/plans/p2/windows')).json();
    expect(empty).toMatchObject({ window_hours: 120, windows: [] });
    expect((await get('/plans/p2/windows/current')).status).toBe(404);
  });
});

// ---- Web logic ----

const DAY = 24 * H;
const dst = { start: Date.parse('2026-11-13T23:00:00Z'), end: Date.parse('2026-11-20T23:00:00Z') };

describe('alignSeries', () => {
  it('aligns by time since window start, even when resets drift', () => {
    const src = { start: dst.start - WEEK_MS + 37 * 60_000, end: dst.end - WEEK_MS + 37 * 60_000 };
    const a = alignSeries(
      [
        { t: src.start + 2 * H, used: 1 },
        { t: src.start + 3 * DAY, used: 40 },
      ],
      src,
      dst,
    );
    expect(a.scaled).toBe(false);
    expect(a.fromZero).toBe(true);
    expect(a.points).toEqual([
      { t: dst.start, used: 0 },
      { t: dst.start + 2 * H, used: 1 },
      { t: dst.start + 3 * DAY, used: 40 },
    ]);
  });

  it('scales a window of a different length by elapsed fraction', () => {
    const src = { start: 0, end: 5 * DAY };
    const a = alignSeries(
      [
        { t: 2.5 * DAY, used: 50 },
        { t: 5 * DAY, used: 90 },
      ],
      src,
      dst,
    );
    expect(a.scaled).toBe(true);
    expect(a.length_h).toBe(120);
    // Readings start halfway in, so there is no 0% anchor: the first point is the first reading.
    expect(a.points[0]).toEqual({ t: dst.start + 3.5 * DAY, used: 50 });
    expect(a.points[1]).toEqual({ t: dst.end, used: 90 });
  });

  it('clamps readings outside the source window and leaves partial weeks unanchored', () => {
    const src = { start: 0, end: WEEK_MS };
    const a = alignSeries(
      [
        { t: 3 * DAY, used: 30 },
        { t: WEEK_MS + 10 * 60_000, used: 99 },
      ],
      src,
      dst,
    );
    expect(a.fromZero).toBe(false);
    expect(a.points[0]).toEqual({ t: dst.start + 3 * DAY, used: 30 });
    expect(a.points[1]).toEqual({ t: dst.end, used: 99 });
    expect(alignSeries([], src, dst).points).toEqual([]);
  });
});

describe('valueAt and averageSeries', () => {
  const a = [
    { t: 0, used: 0 },
    { t: 10, used: 20 },
  ];
  const b = [
    { t: 0, used: 0 },
    { t: 5, used: 30 },
  ];
  it('interpolates between readings and is null outside the data', () => {
    expect(valueAt(a, 5)).toBe(10);
    expect(valueAt(a, 10)).toBe(20);
    expect(valueAt(a, 11)).toBeNull();
    expect(valueAt(a, -1)).toBeNull();
    expect(valueAt([], 1)).toBeNull();
  });
  it('averages where at least two weeks have data, as one unbroken run', () => {
    const avg = averageSeries([a, b], { start: 0, end: 10 }, 10);
    expect(avg.map((p) => p.t)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(avg[5]!.used).toBeCloseTo((10 + 30) / 2);
    expect(averageSeries([a], { start: 0, end: 10 })).toEqual([]);
  });
});

function summary(id: string, extra: Partial<WindowSummary> = {}): WindowSummary {
  return {
    id,
    current: false,
    start: iso(Date.parse(id) - WEEK_MS),
    reset_at: id,
    length_h: 168,
    readings: 10,
    first_reading_at: id,
    last_reading_at: id,
    final_pct: 91.4,
    peak_pct: 91.4,
    ran_out: false,
    ran_out_at: null,
    unused_pct: 8.6,
    unused_h: 14.4,
    locked_out_h: null,
    target_empty_at: id,
    target_gap_pct: -8.6,
    ran_out_early_h: null,
    mean_vs_even_pct: 1,
    mean_abs_vs_even_pct: 3,
    partial: false,
    ...extra,
  };
}

describe('compare choices', () => {
  const ws = [
    summary('2026-11-20T23:00:00.000Z', { current: true }),
    summary('2026-11-13T23:00:00.000Z'),
    summary('2026-11-06T23:00:00.000Z'),
    summary('2026-10-30T23:00:00.000Z'),
    summary('2026-10-23T23:00:00.000Z'),
    summary('2026-10-16T23:00:00.000Z'),
    summary('2026-10-09T23:00:00.000Z'),
  ];
  const ids = (list: WindowSummary[]) => list.map((w) => w.id.slice(5, 10));
  it('picks the weeks just before the shown one, up to four', () => {
    expect(ids(compareWindows(ws, ws[0]!.id, 'last'))).toEqual(['11-13']);
    expect(ids(compareWindows(ws, ws[0]!.id, 'last4'))).toEqual([
      '11-13',
      '11-06',
      '10-30',
      '10-23',
    ]);
    expect(ids(compareWindows(ws, ws[2]!.id, 'last2'))).toEqual(['10-30', '10-23']);
    expect(compareWindows(ws, ws[6]!.id, 'last')).toEqual([]);
    expect(compareWindows(ws, ws[0]!.id, 'none')).toEqual([]);
    // The current week before it is listed: every listed week is older.
    expect(ids(compareWindows(ws.slice(1), 'current', 'last'))).toEqual(['11-13']);
  });
  it('a chosen week is fixed and never the shown one', () => {
    expect(ids(compareWindows(ws, ws[3]!.id, `week:${ws[0]!.id}`))).toEqual(['11-20']);
    expect(compareWindows(ws, ws[3]!.id, `week:${ws[3]!.id}`)).toEqual([]);
    expect(compareWindows(ws, ws[3]!.id, 'week:2020-01-01T00:00:00.000Z')).toEqual([]);
  });
  it('averages up to four finished weeks before the shown one', () => {
    expect(ids(averageWindows(ws, ws[0]!.id))).toEqual(['11-13', '11-06', '10-30', '10-23']);
    expect(ids(averageWindows(ws, ws[5]!.id))).toEqual(['10-09']);
  });
  it('parses compare values strictly', () => {
    expect(parseCompare('last3')).toBe('last3');
    expect(parseCompare('last9')).toBe('none');
    expect(parseCompare('week:2026-11-13T23:00:00.000Z')).toBe('week:2026-11-13T23:00:00.000Z');
    expect(parseCompare('week:<script>')).toBe('none');
    expect(parseCompare(null)).toBe('none');
  });
});

describe('labels', () => {
  const tz = 'America/New_York';
  it('formats date ranges in the time zone, full and compact', () => {
    const s = Date.parse('2026-11-13T23:00:00Z');
    const e = Date.parse('2026-11-20T23:00:00Z');
    expect(rangeLabel(s, e, tz)).toBe('Nov 13 – Nov 20');
    expect(rangeLabel(s, e, tz, true)).toBe('Nov 13–20');
    expect(
      rangeLabel(Date.parse('2026-10-30T12:00:00Z'), Date.parse('2026-11-06T12:00:00Z'), tz, true),
    ).toBe('Oct 30–Nov 6');
  });
  it('labels overlay ends and the target column', () => {
    const w = summary('2026-11-13T23:00:00.000Z');
    expect(overlayLabel(w, tz)).toBe('Nov 6–13: 91%');
    expect(overlayLabel({ ...w, ran_out: true }, tz)).toBe('Nov 6–13: ran out');
    expect(overlayLabel({ ...w, current: true }, tz)).toBe('Nov 6–13: 91% so far');
    expect(overlayShortLabel(w, tz)).toBe('Nov 6: 91%');
    expect(overlayShortLabel({ ...w, ran_out: true }, tz)).toBe('Nov 6: out');
    expect(targetText(w)).toBe('9 pts unused');
    expect(targetText({ ...w, ran_out: true, ran_out_early_h: 14.2 })).toBe('ran out 14 h early');
    expect(targetText({ ...w, ran_out: true, ran_out_early_h: -0.6 })).toBe('0.6 h after target');
    expect(targetText({ ...w, ran_out: true, ran_out_early_h: 0.2 })).toBe('on target');
    expect(targetText({ ...w, target_gap_pct: -0.3 })).toBe('on target');
  });
  it('spreads end labels so they never overlap and stay inside the plot', () => {
    const ys = spreadLabels([50, 52, 51, 200], 12, 20, 210);
    const sorted = [...ys].sort((a, b) => a - b);
    for (let i = 1; i < sorted.length; i++)
      expect(sorted[i]! - sorted[i - 1]!).toBeGreaterThanOrEqual(12);
    expect(ys[3]).toBe(200);
    const low = spreadLabels([208, 209, 210], 12, 20, 210);
    expect(Math.max(...low)).toBe(210);
    expect(Math.min(...low)).toBe(186);
  });
});

describe('page state in the URL', () => {
  it('round-trips the week, comparison and average, leaving defaults out', () => {
    const state = {
      plan: 'codex',
      week: '2026-11-13T23:00:00.000Z',
      compare: 'last2' as const,
      avg: true,
    };
    const hash = stateHash(state);
    expect(hash.startsWith('#/burndown?')).toBe(true);
    expect(parseState(hash)).toEqual(state);
    expect(stateHash({ plan: null, week: 'current', compare: 'none', avg: false })).toBe(
      '#/burndown',
    );
    expect(parseState('#/burndown')).toEqual({});
    expect(parseState('#/burndown?week=bad&compare=evil&plan=%3Cx%3E')).toEqual({
      compare: 'none',
    });
  });
});
